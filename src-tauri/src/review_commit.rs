use std::collections::{HashMap, HashSet};
use std::path::Path;

use git2::{
    ApplyLocation, ApplyOptions, Delta, Diff, DiffDelta, DiffFindOptions, DiffHunk, DiffOptions,
    Patch, Repository, Tree,
};
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::repo;
use crate::tags::{self, Anchor, AnchorSide, ReviewScope, ReviewedTag, TagStore};

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

/// A whole-file binary unit to stage (added/modified/deleted). Binary content can't be
/// applied hunk-by-hunk, so the blob is staged or removed wholesale.
#[derive(Debug, Clone)]
struct EligibleFile {
    path: String,
    deleted: bool,
}

#[derive(Debug, Clone)]
struct Eligibility {
    hunks: Vec<EligibleHunk>,
    files: Vec<EligibleFile>,
    tag_ids: Vec<String>,
    unsupported_reviewed_count: u32,
}

impl Eligibility {
    /// Paths touched by any eligible unit (hunks + binary files), sorted + deduped.
    fn paths(&self) -> Vec<String> {
        let mut paths = self
            .hunks
            .iter()
            .map(|h| h.path.clone())
            .chain(self.files.iter().map(|f| f.path.clone()))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        paths.sort();
        paths
    }

    /// Total reviewable units (text hunks + binary files).
    fn unit_count(&self) -> u32 {
        (self.hunks.len() + self.files.len()) as u32
    }
}

pub fn preflight(repo: &Repository) -> AppResult<ReviewedCommitPreflight> {
    let root = repo::root(repo)?;
    let head_tree = head_tree(repo)?;
    let staged_paths = staged_paths(repo, head_tree.as_ref())?;
    let eligibility = reviewed_hunks(repo, &root)?;

    Ok(ReviewedCommitPreflight {
        staged_paths,
        reviewed_hunk_count: eligibility.unit_count(),
        reviewed_paths: eligibility.paths(),
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
    if !eligibility.files.is_empty() {
        stage_files(repo, &eligibility.files)?;
    }

    Ok(PreparedReviewedCommit {
        staged_paths: eligibility.paths(),
        reviewed_tag_ids: eligibility.tag_ids.clone(),
        hunk_count: eligibility.unit_count(),
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

    let tag_store = tags::remove_reviewed_by_ids(&root, &ReviewScope::Worktree, reviewed_tag_ids)?;
    Ok(ReviewedCommitResult {
        commit: short_oid(&commit_id.to_string()),
        tag_store,
    })
}

/// Reviewed units that can be staged from the working tree. Deliberately loads only
/// **worktree-scoped** tags: a branch review marks commits that are already in
/// history, and must never be able to stage working-tree content that happens to
/// share a path and line range.
fn reviewed_hunks(repo: &Repository, root: &Path) -> AppResult<Eligibility> {
    let store = tags::load(root, &ReviewScope::Worktree)?;
    let mut diff = workdir_diff(repo)?;
    diff.find_similar(Some(DiffFindOptions::new().renames(true)))?;

    let mut hunks = Vec::new();
    let mut files = Vec::new();
    // Eligible/excluded line ranges, keyed by (side, path) so a new-side and an
    // old-side range on the same file never collide.
    let mut eligible: HashMap<(AnchorSide, String), Vec<(u32, u32)>> = HashMap::new();
    let mut excluded: HashMap<(AnchorSide, String), Vec<(u32, u32)>> = HashMap::new();
    let mut eligible_files: HashSet<String> = HashSet::new();
    let mut excluded_files: HashSet<String> = HashSet::new();

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

        // Binary files are one whole-file unit, reviewed/flagged/ignored at file scope.
        if crate::diff::path_change_is_binary(repo, root, &path) {
            let reviewed = covers_file(&store.reviewed, &path);
            let flagged = file_tagged(store.flags.iter().map(|t| &t.anchor), &path);
            let ignored = file_tagged(store.ignored.iter().map(|t| &t.anchor), &path);
            if reviewed && (flagged || ignored) {
                excluded_files.insert(path.clone());
            }
            if reviewed && !flagged && !ignored {
                files.push(EligibleFile {
                    path: path.clone(),
                    deleted: delta.status() == Delta::Deleted,
                });
                eligible_files.insert(path.clone());
            }
            continue;
        }

        let Some(patch) = Patch::from_diff(&diff, idx)? else {
            continue;
        };
        for hunk_idx in 0..patch.num_hunks() {
            let (hunk, line_count) = patch.hunk(hunk_idx)?;
            let stats = hunk_stats(&patch, hunk_idx, line_count)?;
            // A hunk with additions is reviewed on the new side; a pure-deletion hunk
            // (only removed lines) on the old side.
            let (side, lo, hi) = if stats.added_lines > 0 {
                match stats.new_range {
                    Some((lo, hi)) => (AnchorSide::New, lo, hi),
                    None => continue,
                }
            } else if stats.removed_lines > 0 {
                match stats.old_range {
                    Some((lo, hi)) => (AnchorSide::Old, lo, hi),
                    None => continue,
                }
            } else {
                continue;
            };

            let reviewed = covers(&store.reviewed, side, &path, lo, hi);
            let flagged = overlaps(store.flags.iter().map(|t| &t.anchor), side, &path, lo, hi);
            let ignored = overlaps(store.ignored.iter().map(|t| &t.anchor), side, &path, lo, hi);

            if reviewed && (flagged || ignored) {
                excluded
                    .entry((side, path.clone()))
                    .or_default()
                    .push((lo, hi));
            }
            if !reviewed || flagged || ignored {
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
            eligible
                .entry((side, path.clone()))
                .or_default()
                .push((lo, hi));
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
            match anchor.side {
                AnchorSide::File => {
                    eligible_files.contains(&anchor.file)
                        && !excluded_files.contains(&anchor.file)
                }
                side => {
                    let key = (side, anchor.file.clone());
                    let committed = eligible.get(&key).is_some_and(|ranges| {
                        range_covered(ranges, anchor.start_line, anchor.end_line)
                    });
                    let is_excluded = excluded.get(&key).is_some_and(|ranges| {
                        range_overlaps_any(ranges, anchor.start_line, anchor.end_line)
                    });
                    committed && !is_excluded
                }
            }
        })
        .map(|tag| tag.id.clone())
        .collect::<Vec<_>>();
    tag_ids.sort();
    tag_ids.dedup();

    Ok(Eligibility {
        hunks,
        files,
        tag_ids,
        unsupported_reviewed_count: 0,
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

/// Stage whole-file binary units: add the working blob, or remove the path for a
/// reviewed deletion.
fn stage_files(repo: &Repository, files: &[EligibleFile]) -> AppResult<()> {
    let mut index = repo.index()?;
    for file in files {
        let path = Path::new(&file.path);
        if file.deleted {
            index.remove_path(path)?;
        } else {
            index.add_path(path)?;
        }
    }
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
    /// New-side span across every line carrying a new line number (context + added).
    new_range: Option<(u32, u32)>,
    /// Old-side span across the removed lines only (the deletion content).
    old_range: Option<(u32, u32)>,
    added_lines: u32,
    removed_lines: u32,
}

fn hunk_stats(patch: &Patch<'_>, hunk_idx: usize, line_count: usize) -> AppResult<HunkStats> {
    let mut new_lo = u32::MAX;
    let mut new_hi = 0u32;
    let mut old_lo = u32::MAX;
    let mut old_hi = 0u32;
    let mut added_lines = 0u32;
    let mut removed_lines = 0u32;
    for line_idx in 0..line_count {
        let line = patch.line_in_hunk(hunk_idx, line_idx)?;
        let removed = matches!(line.origin(), '-' | '<');
        if matches!(line.origin(), '+' | '>') {
            added_lines += 1;
        }
        if removed {
            removed_lines += 1;
            if let Some(old_line) = line.old_lineno() {
                old_lo = old_lo.min(old_line);
                old_hi = old_hi.max(old_line);
            }
        }
        if let Some(new_line) = line.new_lineno() {
            new_lo = new_lo.min(new_line);
            new_hi = new_hi.max(new_line);
        }
    }
    Ok(HunkStats {
        new_range: (new_lo != u32::MAX).then_some((new_lo, new_hi)),
        old_range: (old_lo != u32::MAX).then_some((old_lo, old_hi)),
        added_lines,
        removed_lines,
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

fn covers(tags: &[ReviewedTag], side: AnchorSide, file: &str, lo: u32, hi: u32) -> bool {
    tags.iter().any(|tag| {
        let anchor = &tag.anchor;
        !anchor.stale
            && anchor.side == side
            && anchor.file == file
            && anchor.start_line <= lo
            && anchor.end_line >= hi
    })
}

fn overlaps<'a>(
    mut anchors: impl Iterator<Item = &'a Anchor>,
    side: AnchorSide,
    file: &str,
    lo: u32,
    hi: u32,
) -> bool {
    anchors.any(|anchor| {
        !anchor.stale
            && anchor.side == side
            && anchor.file == file
            && anchor.start_line <= hi
            && anchor.end_line >= lo
    })
}

/// A binary file is reviewed when a non-stale file anchor names its path.
fn covers_file(tags: &[ReviewedTag], file: &str) -> bool {
    tags.iter().any(|tag| {
        !tag.anchor.stale && tag.anchor.side == AnchorSide::File && tag.anchor.file == file
    })
}

/// File-scope flag/ignore check for binary files: any non-stale anchor on the path.
fn file_tagged<'a>(mut anchors: impl Iterator<Item = &'a Anchor>, file: &str) -> bool {
    anchors.any(|anchor| !anchor.stale && anchor.file == file)
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
        tags::add_reviewed(root, &ReviewScope::Worktree, "a.txt", 1, 5, tags::AnchorKind::Hunk, tags::AnchorSide::New).unwrap();

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
        tags::add_reviewed(root, &ReviewScope::Worktree, "a.txt", 1, 5, tags::AnchorKind::Hunk, tags::AnchorSide::New).unwrap();
        tags::add_flag(root, &ReviewScope::Worktree, "a.txt", 2, 2, tags::AnchorKind::Range, tags::AnchorSide::New, None, None).unwrap();

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
        tags::add_reviewed(root, &ReviewScope::Worktree, "a.txt", 1, 5, tags::AnchorKind::Hunk, tags::AnchorSide::New).unwrap();
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
        tags::add_reviewed(root, &ReviewScope::Worktree, "a.txt", 1, 5, tags::AnchorKind::Hunk, tags::AnchorSide::New).unwrap();
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
        tags::add_reviewed(root, &ReviewScope::Worktree, "a.txt", 1, 5, tags::AnchorKind::Hunk, tags::AnchorSide::New).unwrap();
        tags::add_reviewed(root, &ReviewScope::Worktree, "a.txt", 15, 20, tags::AnchorKind::Hunk, tags::AnchorSide::New).unwrap();
        tags::add_flag(root, &ReviewScope::Worktree, "a.txt", 18, 18, tags::AnchorKind::Range, tags::AnchorSide::New, None, None).unwrap();
        let prepared = prepare(&repo, false).unwrap();
        assert_eq!(prepared.hunk_count, 1);

        let result = commit(&repo, "review first hunk", &prepared.reviewed_tag_ids).unwrap();
        assert_eq!(result.commit.len(), 7);
        let store = tags::load(root, &ReviewScope::Worktree).unwrap();
        assert_eq!(store.reviewed.len(), 1);
        assert_eq!(store.flags.len(), 1);
        assert_eq!(store.reviewed[0].anchor.start_line, 15);
    }

    /// Delete HEAD lines 5..7 in the working tree, leaving everything else.
    fn delete_lines_five_to_seven(root: &Path) {
        let lines = (1..=20)
            .filter(|n| !(5..=7).contains(n))
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(root.join("a.txt"), format!("{lines}\n")).unwrap();
    }

    #[test]
    fn prepare_stages_reviewed_deletion_hunk() {
        let (dir, repo) = init_repo();
        let root = dir.path();
        delete_lines_five_to_seven(root);
        // Old-side anchor over the removed block (HEAD lines 5..7).
        tags::add_reviewed(root, &ReviewScope::Worktree, "a.txt", 5, 7, tags::AnchorKind::Hunk, tags::AnchorSide::Old)
            .unwrap();

        let prepared = prepare(&repo, false).unwrap();
        assert_eq!(prepared.hunk_count, 1);
        let cached = run(root, &["diff", "--cached", "--", "a.txt"]);
        assert!(cached.contains("-line 5"), "staged deletion:\n{cached}");
        assert!(cached.contains("-line 7"));
        assert!(!cached.contains("-line 8"), "line 8 must survive");
    }

    #[test]
    fn deletion_hunk_excluded_when_flagged() {
        let (dir, repo) = init_repo();
        let root = dir.path();
        delete_lines_five_to_seven(root);
        tags::add_reviewed(root, &ReviewScope::Worktree, "a.txt", 5, 7, tags::AnchorKind::Hunk, tags::AnchorSide::Old)
            .unwrap();
        // A flag on the same old-side range is an active concern → not staged.
        tags::add_flag(root, &ReviewScope::Worktree, "a.txt", 6, 6, tags::AnchorKind::Range, tags::AnchorSide::Old, None, None)
            .unwrap();

        let prepared = prepare(&repo, false).unwrap();
        assert_eq!(prepared.hunk_count, 0);
        assert!(run(root, &["diff", "--cached", "--", "a.txt"]).is_empty());
    }

    #[test]
    fn commit_clears_committed_deletion_tag() {
        let (dir, repo) = init_repo();
        let root = dir.path();
        delete_lines_five_to_seven(root);
        tags::add_reviewed(root, &ReviewScope::Worktree, "a.txt", 5, 7, tags::AnchorKind::Hunk, tags::AnchorSide::Old)
            .unwrap();
        let prepared = prepare(&repo, false).unwrap();
        assert_eq!(prepared.reviewed_tag_ids.len(), 1);

        commit(&repo, "drop lines 5-7", &prepared.reviewed_tag_ids).unwrap();
        let store = tags::load(root, &ReviewScope::Worktree).unwrap();
        assert!(store.reviewed.is_empty(), "old-side tag cleared after commit");
    }

    #[test]
    fn prepare_stages_reviewed_deleted_file() {
        let (dir, repo) = init_repo();
        let root = dir.path();
        // b.txt exists at HEAD, then is deleted in the working tree.
        fs::write(root.join("b.txt"), "one\ntwo\nthree\n").unwrap();
        run(root, &["add", "b.txt"]);
        run(root, &["commit", "-qm", "add b"]);
        fs::remove_file(root.join("b.txt")).unwrap();

        tags::add_reviewed(root, &ReviewScope::Worktree, "b.txt", 1, 3, tags::AnchorKind::Hunk, tags::AnchorSide::Old)
            .unwrap();

        let prepared = prepare(&repo, false).unwrap();
        assert_eq!(prepared.hunk_count, 1);
        let status = run(root, &["diff", "--cached", "--name-status"]);
        assert!(status.contains("D\tb.txt"), "staged deletion:\n{status}");
    }

    fn write_bin(root: &Path, name: &str, bytes: &[u8]) {
        fs::write(root.join(name), bytes).unwrap();
    }

    #[test]
    fn prepare_stages_reviewed_binary_modify() {
        let (dir, repo) = init_repo();
        let root = dir.path();
        write_bin(root, "logo.bin", &[0, 159, 146, 150, 0, 1, 2]);
        run(root, &["add", "logo.bin"]);
        run(root, &["commit", "-qm", "add bin"]);
        write_bin(root, "logo.bin", &[0, 1, 2, 3, 159, 146, 150]);

        tags::add_reviewed(root, &ReviewScope::Worktree, "logo.bin", 0, 0, tags::AnchorKind::File, tags::AnchorSide::File)
            .unwrap();

        let prepared = prepare(&repo, false).unwrap();
        assert_eq!(prepared.hunk_count, 1);
        assert_eq!(prepared.staged_paths, vec!["logo.bin"]);
        let status = run(root, &["diff", "--cached", "--name-status"]);
        assert!(status.contains("M\tlogo.bin"), "staged modify:\n{status}");
    }

    #[test]
    fn prepare_stages_reviewed_binary_delete() {
        let (dir, repo) = init_repo();
        let root = dir.path();
        write_bin(root, "logo.bin", &[0, 159, 146, 150, 0, 1, 2]);
        run(root, &["add", "logo.bin"]);
        run(root, &["commit", "-qm", "add bin"]);
        fs::remove_file(root.join("logo.bin")).unwrap();

        tags::add_reviewed(root, &ReviewScope::Worktree, "logo.bin", 0, 0, tags::AnchorKind::File, tags::AnchorSide::File)
            .unwrap();

        let prepared = prepare(&repo, false).unwrap();
        assert_eq!(prepared.hunk_count, 1);
        let status = run(root, &["diff", "--cached", "--name-status"]);
        assert!(status.contains("D\tlogo.bin"), "staged deletion:\n{status}");
    }

    #[test]
    fn binary_unit_excluded_when_ignored() {
        let (dir, repo) = init_repo();
        let root = dir.path();
        write_bin(root, "logo.bin", &[0, 159, 146, 150]);
        run(root, &["add", "logo.bin"]);
        run(root, &["commit", "-qm", "add bin"]);
        write_bin(root, "logo.bin", &[0, 1, 2, 3]);

        tags::add_reviewed(root, &ReviewScope::Worktree, "logo.bin", 0, 0, tags::AnchorKind::File, tags::AnchorSide::File)
            .unwrap();
        tags::add_ignored(root, &ReviewScope::Worktree, "logo.bin", 0, 0, tags::AnchorKind::File, tags::AnchorSide::File)
            .unwrap();

        let prepared = prepare(&repo, false).unwrap();
        assert_eq!(prepared.hunk_count, 0);
        assert!(run(root, &["diff", "--cached", "--name-status"]).is_empty());
    }
}
