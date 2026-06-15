use std::collections::{HashMap, HashSet};
use std::path::Path;

use git2::{
    ApplyLocation, ApplyOptions, Delta, Diff, DiffDelta, DiffFindOptions, DiffHunk, DiffOptions,
    Patch, Repository, Tree,
};
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::repo;
use crate::tags::{self, Anchor, ReviewedTag, TagStore};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedCommitPreflight {
    pub staged_paths: Vec<String>,
    pub reviewed_hunk_count: u32,
    pub reviewed_paths: Vec<String>,
    pub unsupported_reviewed_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedReviewedCommit {
    pub staged_paths: Vec<String>,
    pub reviewed_tag_ids: Vec<String>,
    pub hunk_count: u32,
    pub unsupported_reviewed_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedCommitResult {
    pub commit: String,
    pub tag_store: TagStore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct HunkKey {
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
}

#[derive(Debug, Clone)]
struct EligibleHunk {
    path: String,
    key: HunkKey,
}

#[derive(Debug, Clone)]
struct Eligibility {
    hunks: Vec<EligibleHunk>,
    tag_ids: Vec<String>,
    unsupported_reviewed_count: u32,
}

pub fn preflight(repo: &Repository) -> AppResult<ReviewedCommitPreflight> {
    let root = repo::root(repo)?;
    let head_tree = head_tree(repo)?;
    let staged_paths = staged_paths(repo, head_tree.as_ref())?;
    let eligibility = reviewed_hunks(repo, &root)?;
    let mut reviewed_paths = eligibility
        .hunks
        .iter()
        .map(|h| h.path.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    reviewed_paths.sort();

    Ok(ReviewedCommitPreflight {
        staged_paths,
        reviewed_hunk_count: eligibility.hunks.len() as u32,
        reviewed_paths,
        unsupported_reviewed_count: eligibility.unsupported_reviewed_count,
    })
}

pub fn prepare(
    repo: &Repository,
    unstage_existing: bool,
) -> AppResult<PreparedReviewedCommit> {
    let root = repo::root(repo)?;
    let head_tree = head_tree(repo)?;
    let staged = staged_paths(repo, head_tree.as_ref())?;
    if !staged.is_empty() && !unstage_existing {
        return Err(AppError::Repo(
            "staged changes must be unstaged before committing reviewed content".into(),
        ));
    }
    if !staged.is_empty() || unstage_existing {
        unstage_all(repo, head_tree.as_ref())?;
    }

    let eligibility = reviewed_hunks(repo, &root)?;
    if !eligibility.hunks.is_empty() {
        stage_hunks(repo, &eligibility.hunks)?;
    }

    let mut staged_paths = eligibility
        .hunks
        .iter()
        .map(|h| h.path.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    staged_paths.sort();

    Ok(PreparedReviewedCommit {
        staged_paths,
        reviewed_tag_ids: eligibility.tag_ids,
        hunk_count: eligibility.hunks.len() as u32,
        unsupported_reviewed_count: eligibility.unsupported_reviewed_count,
    })
}

pub fn abort(repo: &Repository) -> AppResult<()> {
    let head_tree = head_tree(repo)?;
    unstage_all(repo, head_tree.as_ref())
}

pub fn commit(
    repo: &Repository,
    message: &str,
    reviewed_tag_ids: &[String],
) -> AppResult<ReviewedCommitResult> {
    let root = repo::root(repo)?;
    let message = clean_commit_message(message);
    if message.is_empty() {
        return Err(AppError::Repo("commit message is empty".into()));
    }

    let mut index = repo.index()?;
    let tree_id = index.write_tree()?;
    let head_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    if let Some(parent) = head_commit.as_ref() {
        if parent.tree_id() == tree_id {
            return Err(AppError::Repo("nothing staged to commit".into()));
        }
    } else if index.is_empty() {
        return Err(AppError::Repo("nothing staged to commit".into()));
    }

    let tree = repo.find_tree(tree_id)?;
    let signature = repo.signature().map_err(|_| {
        AppError::Git("git user.name and user.email must be configured".into())
    })?;
    let parents = head_commit.iter().collect::<Vec<_>>();
    let commit_id = repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        &message,
        &tree,
        &parents,
    )?;

    let tag_store = tags::remove_reviewed_by_ids(&root, reviewed_tag_ids)?;
    Ok(ReviewedCommitResult {
        commit: short_oid(&commit_id.to_string()),
        tag_store,
    })
}

fn reviewed_hunks(repo: &Repository, root: &Path) -> AppResult<Eligibility> {
    let store = tags::load(root)?;
    let mut diff = workdir_diff(repo)?;
    diff.find_similar(Some(DiffFindOptions::new().renames(true)))?;

    let mut hunks = Vec::new();
    let mut eligible_ranges: HashMap<String, Vec<(u32, u32)>> = HashMap::new();
    let mut excluded_ranges: HashMap<String, Vec<(u32, u32)>> = HashMap::new();
    let mut unsupported_reviewed_count = 0u32;

    for idx in 0..diff.deltas().len() {
        let Some(delta) = diff.get_delta(idx) else {
            continue;
        };
        if delta.status() == Delta::Unmodified || delta.status() == Delta::Ignored {
            continue;
        }
        let Some(path) = delta_path(&delta) else {
            continue;
        };
        if delta.new_file().is_binary() || delta.old_file().is_binary() {
            continue;
        }
        let Some(patch) = Patch::from_diff(&diff, idx)? else {
            continue;
        };
        for hunk_idx in 0..patch.num_hunks() {
            let (hunk, line_count) = patch.hunk(hunk_idx)?;
            let stats = hunk_stats(&patch, hunk_idx, line_count)?;
            let Some((lo, hi)) = stats.new_range else {
                continue;
            };
            let reviewed = covers(&store.reviewed, &path, lo, hi);
            let flagged = overlaps(store.flags.iter().map(|t| &t.anchor), &path, lo, hi);
            let ignored = overlaps(store.ignored.iter().map(|t| &t.anchor), &path, lo, hi);

            if reviewed && (flagged || ignored) {
                excluded_ranges.entry(path.clone()).or_default().push((lo, hi));
            }
            if !reviewed || flagged || ignored {
                continue;
            }
            if stats.added_lines == 0 {
                unsupported_reviewed_count += 1;
                continue;
            }

            let key = HunkKey {
                old_start: hunk.old_start(),
                old_lines: hunk.old_lines(),
                new_start: hunk.new_start(),
                new_lines: hunk.new_lines(),
            };
            hunks.push(EligibleHunk {
                path: path.clone(),
                key,
            });
            eligible_ranges.entry(path.clone()).or_default().push((lo, hi));
        }
    }

    let mut tag_ids = store
        .reviewed
        .iter()
        .filter(|tag| {
            let anchor = &tag.anchor;
            if anchor.stale {
                return false;
            }
            let committed = eligible_ranges
                .get(&anchor.file)
                .is_some_and(|ranges| range_covered(ranges, anchor.start_line, anchor.end_line));
            let excluded = excluded_ranges
                .get(&anchor.file)
                .is_some_and(|ranges| range_overlaps_any(ranges, anchor.start_line, anchor.end_line));
            committed && !excluded
        })
        .map(|tag| tag.id.clone())
        .collect::<Vec<_>>();
    tag_ids.sort();
    tag_ids.dedup();

    Ok(Eligibility {
        hunks,
        tag_ids,
        unsupported_reviewed_count,
    })
}

fn stage_hunks(repo: &Repository, hunks: &[EligibleHunk]) -> AppResult<()> {
    let mut allowed: HashMap<String, HashSet<HunkKey>> = HashMap::new();
    for hunk in hunks {
        allowed
            .entry(hunk.path.clone())
            .or_default()
            .insert(hunk.key);
    }

    let mut diff = workdir_diff(repo)?;
    diff.find_similar(Some(DiffFindOptions::new().renames(true)))?;
    let current_path = std::cell::RefCell::new(None::<String>);
    let mut opts = ApplyOptions::new();
    opts.delta_callback(|delta| {
        let path = delta.and_then(|d| delta_path(&d));
        *current_path.borrow_mut() = path.clone();
        path.is_some_and(|p| allowed.contains_key(&p))
    });
    opts.hunk_callback(|hunk| {
        let Some(hunk) = hunk else {
            return false;
        };
        let Some(path) = current_path.borrow().clone() else {
            return false;
        };
        allowed
            .get(&path)
            .is_some_and(|keys| keys.contains(&hunk_key(&hunk)))
    });
    repo.apply(&diff, ApplyLocation::Index, Some(&mut opts))?;
    let mut index = repo.index()?;
    index.write()?;
    Ok(())
}

fn workdir_diff(repo: &Repository) -> AppResult<Diff<'_>> {
    let head_tree = head_tree(repo)?;
    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .context_lines(3);
    Ok(repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))?)
}

fn unstage_all(repo: &Repository, head_tree: Option<&Tree>) -> AppResult<()> {
    let mut index = repo.index()?;
    match head_tree {
        Some(tree) => index.read_tree(tree)?,
        None => index.clear()?,
    }
    index.write()?;
    Ok(())
}

fn staged_paths(repo: &Repository, head_tree: Option<&Tree>) -> AppResult<Vec<String>> {
    let index = repo.index()?;
    let diff = repo.diff_tree_to_index(head_tree, Some(&index), None)?;
    let mut paths = HashSet::new();
    for delta in diff.deltas() {
        if let Some(path) = delta_path(&delta) {
            paths.insert(path);
        }
    }
    let mut paths = paths.into_iter().collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

fn head_tree(repo: &Repository) -> AppResult<Option<Tree<'_>>> {
    match repo.head() {
        Ok(head) => {
            let commit = head.peel_to_commit()?;
            Ok(Some(commit.tree()?))
        }
        Err(_) => Ok(None),
    }
}

#[derive(Debug, Clone, Copy)]
struct HunkStats {
    new_range: Option<(u32, u32)>,
    added_lines: u32,
}

fn hunk_stats(patch: &Patch<'_>, hunk_idx: usize, line_count: usize) -> AppResult<HunkStats> {
    let mut lo = u32::MAX;
    let mut hi = 0u32;
    let mut added_lines = 0u32;
    for line_idx in 0..line_count {
        let line = patch.line_in_hunk(hunk_idx, line_idx)?;
        if matches!(line.origin(), '+' | '>') {
            added_lines += 1;
        }
        if let Some(new_line) = line.new_lineno() {
            lo = lo.min(new_line);
            hi = hi.max(new_line);
        }
    }
    Ok(HunkStats {
        new_range: (lo != u32::MAX).then_some((lo, hi)),
        added_lines,
    })
}

fn hunk_key(hunk: &DiffHunk<'_>) -> HunkKey {
    HunkKey {
        old_start: hunk.old_start(),
        old_lines: hunk.old_lines(),
        new_start: hunk.new_start(),
        new_lines: hunk.new_lines(),
    }
}

fn delta_path(delta: &DiffDelta<'_>) -> Option<String> {
    delta
        .new_file()
        .path()
        .or_else(|| delta.old_file().path())
        .map(path_string)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn covers(tags: &[ReviewedTag], file: &str, lo: u32, hi: u32) -> bool {
    tags.iter().any(|tag| {
        let anchor = &tag.anchor;
        !anchor.stale
            && anchor.file == file
            && anchor.start_line <= lo
            && anchor.end_line >= hi
    })
}

fn overlaps<'a>(mut anchors: impl Iterator<Item = &'a Anchor>, file: &str, lo: u32, hi: u32) -> bool {
    anchors.any(|anchor| {
        !anchor.stale && anchor.file == file && anchor.start_line <= hi && anchor.end_line >= lo
    })
}

fn range_covered(ranges: &[(u32, u32)], lo: u32, hi: u32) -> bool {
    let mut ranges = ranges.to_vec();
    ranges.sort_by_key(|r| r.0);
    let mut covered_until = lo.saturating_sub(1);
    for (start, end) in ranges {
        if start > covered_until.saturating_add(1) {
            return false;
        }
        if end > covered_until {
            covered_until = end;
        }
        if covered_until >= hi {
            return true;
        }
    }
    false
}

fn range_overlaps_any(ranges: &[(u32, u32)], lo: u32, hi: u32) -> bool {
    ranges.iter().any(|(start, end)| *start <= hi && *end >= lo)
}

fn clean_commit_message(raw: &str) -> String {
    raw.lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn short_oid(oid: &str) -> String {
    oid.chars().take(7).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn run(repo_dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(repo_dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    fn init_repo() -> (tempfile::TempDir, Repository) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        run(root, &["init", "-q", "-b", "master"]);
        run(root, &["config", "user.name", "t"]);
        run(root, &["config", "user.email", "t@t"]);
        let lines = (1..=20)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(root.join("a.txt"), format!("{lines}\n")).unwrap();
        run(root, &["add", "."]);
        run(root, &["commit", "-qm", "init"]);
        let repo = Repository::open(root).unwrap();
        (dir, repo)
    }

    fn write_changed_two_hunks(root: &Path) {
        let lines = (1..=20)
            .map(|n| match n {
                2 => "line two changed".to_string(),
                18 => "line eighteen changed".to_string(),
                _ => format!("line {n}"),
            })
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(root.join("a.txt"), format!("{lines}\n")).unwrap();
    }

    #[test]
    fn preflight_reports_staged_paths() {
        let (dir, repo) = init_repo();
        let root = dir.path();
        fs::write(root.join("a.txt"), "changed\n").unwrap();
        run(root, &["add", "a.txt"]);

        let result = preflight(&repo).unwrap();
        assert_eq!(result.staged_paths, vec!["a.txt"]);
    }

    #[test]
    fn prepare_refuses_existing_staged_changes_without_confirmation() {
        let (dir, repo) = init_repo();
        let root = dir.path();
        fs::write(root.join("a.txt"), "changed\n").unwrap();
        run(root, &["add", "a.txt"]);

        let err = prepare(&repo, false).unwrap_err().to_string();
        assert!(err.contains("staged changes"));
    }

    #[test]
    fn prepare_stages_only_reviewed_hunks() {
        let (dir, repo) = init_repo();
        let root = dir.path();
        write_changed_two_hunks(root);
        tags::add_reviewed(root, "a.txt", 1, 5, tags::AnchorKind::Hunk).unwrap();

        let prepared = prepare(&repo, false).unwrap();
        assert_eq!(prepared.hunk_count, 1);
        let cached = run(root, &["diff", "--cached", "--", "a.txt"]);
        assert!(cached.contains("line two changed"));
        assert!(!cached.contains("line eighteen changed"));
    }

    #[test]
    fn prepare_excludes_flagged_reviewed_hunks() {
        let (dir, repo) = init_repo();
        let root = dir.path();
        write_changed_two_hunks(root);
        tags::add_reviewed(root, "a.txt", 1, 5, tags::AnchorKind::Hunk).unwrap();
        tags::add_flag(root, "a.txt", 2, 2, tags::AnchorKind::Range, None, None).unwrap();

        let prepared = prepare(&repo, false).unwrap();
        assert_eq!(prepared.hunk_count, 0);
        let cached = run(root, &["diff", "--cached", "--", "a.txt"]);
        assert!(cached.is_empty());
    }

    #[test]
    fn abort_unstages_prepared_content() {
        let (dir, repo) = init_repo();
        let root = dir.path();
        write_changed_two_hunks(root);
        tags::add_reviewed(root, "a.txt", 1, 5, tags::AnchorKind::Hunk).unwrap();
        prepare(&repo, false).unwrap();

        let cached = run(root, &["diff", "--cached", "--", "a.txt"]);
        assert!(!cached.is_empty());
        abort(&repo).unwrap();
        let cached = run(root, &["diff", "--cached", "--", "a.txt"]);
        assert!(cached.is_empty());
    }

    #[test]
    fn commit_rejects_empty_message() {
        let (dir, repo) = init_repo();
        let root = dir.path();
        write_changed_two_hunks(root);
        tags::add_reviewed(root, "a.txt", 1, 5, tags::AnchorKind::Hunk).unwrap();
        let prepared = prepare(&repo, false).unwrap();

        let err = commit(&repo, "\n# comment only\n", &prepared.reviewed_tag_ids)
            .unwrap_err()
            .to_string();
        assert!(err.contains("commit message is empty"));
    }

    #[test]
    fn commit_clears_only_committed_reviewed_tags() {
        let (dir, repo) = init_repo();
        let root = dir.path();
        write_changed_two_hunks(root);
        tags::add_reviewed(root, "a.txt", 1, 5, tags::AnchorKind::Hunk).unwrap();
        tags::add_reviewed(root, "a.txt", 15, 20, tags::AnchorKind::Hunk).unwrap();
        tags::add_flag(root, "a.txt", 18, 18, tags::AnchorKind::Range, None, None).unwrap();
        let prepared = prepare(&repo, false).unwrap();
        assert_eq!(prepared.hunk_count, 1);

        let result = commit(&repo, "review first hunk", &prepared.reviewed_tag_ids).unwrap();
        assert_eq!(result.commit.len(), 7);
        let store = tags::load(root).unwrap();
        assert_eq!(store.reviewed.len(), 1);
        assert_eq!(store.flags.len(), 1);
        assert_eq!(store.reviewed[0].anchor.start_line, 15);
    }
}
