use std::collections::HashSet;
use std::path::Path;

use git2::{Delta, Diff, DiffDelta, DiffFindOptions, DiffOptions, Oid, Patch, Repository, Tree};
use serde::{Deserialize, Serialize};

use crate::branches::{self, ResolvedBranches};
use crate::commits::{self, ResolvedCommit};
use crate::error::AppResult;
use crate::repo;

/// How a branch comparison picks the old side. Only `MergeBase` exists today
/// (`git diff base...target`), but the tagged shape leaves room for `Direct`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffStrategy {
    MergeBase,
}

/// What the diff buffer is showing. `Worktree` is the default magit-status view
/// (working tree vs. HEAD); `Branches` reviews committed history between two refs and
/// `Commit` reviews one commit against its first parent. Neither committed-history
/// mode touches the checkout, index, or working tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiffSpec {
    Worktree,
    #[serde(rename_all = "camelCase")]
    Branches {
        base_ref: String,
        target_ref: String,
        strategy: DiffStrategy,
    },
    #[serde(rename_all = "camelCase")]
    Commit {
        /// Full 40-char oid — the comparison's identity.
        oid: String,
        /// The branch the commit was picked from. Display context only: it names
        /// where the reviewer found the commit, and is deliberately absent from both
        /// the comparison's identity and its review scope, so the same commit reached
        /// from two branches is one review.
        branch_ref: Option<String>,
    },
}

impl Default for DiffSpec {
    fn default() -> Self {
        DiffSpec::Worktree
    }
}

/// Resolved metadata for the comparison a `DiffSummary` describes. Kept separate from
/// the file list so the UI never has to infer the mode from overloaded fields.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Comparison {
    #[serde(rename_all = "camelCase")]
    Worktree { head: String, branch: String },
    #[serde(rename_all = "camelCase")]
    Branches {
        /// Canonical refs — the durable identity of the comparison.
        base_ref: String,
        target_ref: String,
        /// Shorthand names for display.
        base_name: String,
        target_name: String,
        /// Resolved oids — the exact snapshot on screen.
        base_oid: String,
        target_oid: String,
        merge_base: String,
    },
    #[serde(rename_all = "camelCase")]
    Commit {
        /// Full oid — the durable identity of the comparison.
        oid: String,
        short_oid: String,
        summary: String,
        author_name: String,
        timestamp: i64,
        /// The first parent, whose tree is the old side. `None` for a root commit,
        /// whose old side is empty.
        parent_oid: Option<String>,
        is_merge: bool,
        /// Shorthand of the branch the commit was picked from, for display.
        branch_name: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffLineKind {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub id: String,
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: ChangeStatus,
    /// Whether the change is present in the index. `None` in branch mode, where both
    /// sides are committed history and staging is meaningless.
    pub staged: Option<bool>,
    pub hunks: Vec<Hunk>,
    pub added_lines: u32,
    pub removed_lines: u32,
    pub binary: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub repo_root: String,
    pub comparison: Comparison,
    pub files: Vec<ChangedFile>,
}

/// Compute the diff `spec` asks for. Never mutates the repository.
pub fn compute(repo: &Repository, spec: &DiffSpec) -> AppResult<DiffSummary> {
    match spec {
        DiffSpec::Worktree => compute_worktree(repo),
        DiffSpec::Branches {
            base_ref,
            target_ref,
            strategy: DiffStrategy::MergeBase,
        } => compute_branches(repo, &branches::resolve(repo, base_ref, target_ref)?),
        DiffSpec::Commit { oid, branch_ref } => {
            compute_commit(repo, &commits::resolve(repo, oid)?, branch_ref.as_deref())
        }
    }
}

/// The working-tree-vs-HEAD diff: every uncommitted change, staged or not, including
/// newly created (untracked) files. This is the magit-status view.
fn compute_worktree(repo: &Repository) -> AppResult<DiffSummary> {
    let head_tree = head_tree(repo)?;

    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .context_lines(3);
    let mut diff = repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))?;
    diff.find_similar(Some(DiffFindOptions::new().renames(true)))?;

    let staged = staged_paths(repo, head_tree.as_ref())?;
    let root = repo::root(repo)?;

    let mut files = Vec::new();
    for idx in 0..diff.deltas().len() {
        let file = changed_file(&diff, idx, Some(&staged), &|_delta, path| {
            path_change_is_binary(repo, &root, path)
        })?;
        if let Some(file) = file {
            files.push(file);
        }
    }

    let (head, branch) = repo::head_info(repo);
    Ok(DiffSummary {
        repo_root: root.to_string_lossy().into_owned(),
        comparison: Comparison::Worktree { head, branch },
        files,
    })
}

/// `git diff base...target`: the merge-base tree against the target tree. The index,
/// untracked files, and any dirty working-tree content are deliberately ignored —
/// only committed history is on screen.
fn compute_branches(repo: &Repository, resolved: &ResolvedBranches) -> AppResult<DiffSummary> {
    let old_tree = repo.find_commit(resolved.merge_base)?.tree()?;
    let new_tree = repo.find_commit(resolved.target_oid)?.tree()?;

    let mut opts = DiffOptions::new();
    opts.context_lines(3);
    let mut diff =
        repo.diff_tree_to_tree(Some(&old_tree), Some(&new_tree), Some(&mut opts))?;
    diff.find_similar(Some(DiffFindOptions::new().renames(true)))?;

    let mut files = Vec::new();
    for idx in 0..diff.deltas().len() {
        let file = changed_file(&diff, idx, None, &|delta, _path| {
            delta_change_is_binary(repo, delta)
        })?;
        if let Some(file) = file {
            files.push(file);
        }
    }

    Ok(DiffSummary {
        repo_root: repo::root(repo)?.to_string_lossy().into_owned(),
        comparison: Comparison::Branches {
            base_ref: resolved.base_ref.clone(),
            target_ref: resolved.target_ref.clone(),
            base_name: resolved.base_name.clone(),
            target_name: resolved.target_name.clone(),
            base_oid: resolved.base_oid.to_string(),
            target_oid: resolved.target_oid.to_string(),
            merge_base: resolved.merge_base.to_string(),
        },
        files,
    })
}

/// `git show <commit>`: the commit's tree against its first parent's. A merge is
/// reviewed against parent 1 (never a combined diff); a root commit has no old tree at
/// all, so every one of its files reads as added. Like branch mode, the checkout and
/// index are irrelevant here.
fn compute_commit(
    repo: &Repository,
    resolved: &ResolvedCommit,
    branch_ref: Option<&str>,
) -> AppResult<DiffSummary> {
    let new_tree = repo.find_commit(resolved.oid)?.tree()?;
    let old_tree = match resolved.parent_oid {
        Some(parent) => Some(repo.find_commit(parent)?.tree()?),
        None => None,
    };

    let mut opts = DiffOptions::new();
    opts.context_lines(3);
    let mut diff = repo.diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), Some(&mut opts))?;
    diff.find_similar(Some(DiffFindOptions::new().renames(true)))?;

    let mut files = Vec::new();
    for idx in 0..diff.deltas().len() {
        let file = changed_file(&diff, idx, None, &|delta, _path| {
            delta_change_is_binary(repo, delta)
        })?;
        if let Some(file) = file {
            files.push(file);
        }
    }

    let info = &resolved.info;
    Ok(DiffSummary {
        repo_root: repo::root(repo)?.to_string_lossy().into_owned(),
        comparison: Comparison::Commit {
            oid: info.oid.clone(),
            short_oid: info.short_oid.clone(),
            summary: info.summary.clone(),
            author_name: info.author_name.clone(),
            timestamp: info.timestamp,
            parent_oid: resolved.parent_oid.map(|oid| oid.to_string()),
            is_merge: info.is_merge,
            branch_name: branch_ref.map(|r| branches::shorthand(r).to_string()),
        },
        files,
    })
}

/// Build one `ChangedFile` from delta `idx`. `staged` is `None` in branch mode;
/// `is_binary` differs per mode (working file vs. the delta's own blobs).
fn changed_file(
    diff: &Diff,
    idx: usize,
    staged: Option<&HashSet<String>>,
    is_binary: &dyn Fn(&DiffDelta<'_>, &str) -> bool,
) -> AppResult<Option<ChangedFile>> {
    let delta = match diff.get_delta(idx) {
        Some(delta) => delta,
        None => return Ok(None),
    };

    let status = match delta.status() {
        Delta::Added | Delta::Untracked => ChangeStatus::Added,
        Delta::Deleted => ChangeStatus::Deleted,
        Delta::Renamed => ChangeStatus::Renamed,
        Delta::Unmodified | Delta::Ignored => return Ok(None),
        // Modified, Copied, Typechange, Conflicted, etc.
        _ => ChangeStatus::Modified,
    };

    let new_path = delta.new_file().path().map(path_string);
    let old_path = delta.old_file().path().map(path_string);
    let path = match new_path.clone().or_else(|| old_path.clone()) {
        Some(path) => path,
        None => return Ok(None),
    };
    let renamed_from = match status {
        ChangeStatus::Renamed => old_path.filter(|old| Some(old) != new_path.as_ref()),
        _ => None,
    };

    let binary = is_binary(&delta, &path);
    let mut hunks = Vec::new();
    let mut added_lines = 0u32;
    let mut removed_lines = 0u32;

    if !binary {
        if let Some(patch) = Patch::from_diff(diff, idx)? {
            for h in 0..patch.num_hunks() {
                let (hunk, line_count) = patch.hunk(h)?;
                let mut lines = Vec::with_capacity(line_count);
                for l in 0..line_count {
                    let line = patch.line_in_hunk(h, l)?;
                    let kind = match line.origin() {
                        '+' | '>' => {
                            added_lines += 1;
                            DiffLineKind::Added
                        }
                        '-' | '<' => {
                            removed_lines += 1;
                            DiffLineKind::Removed
                        }
                        _ => DiffLineKind::Context,
                    };
                    lines.push(DiffLine {
                        kind,
                        old_line: line.old_lineno(),
                        new_line: line.new_lineno(),
                        content: line_content(line.content()),
                    });
                }
                hunks.push(Hunk {
                    id: format!("{path}#{}-{}", hunk.old_start(), hunk.new_start()),
                    header: line_content(hunk.header()),
                    old_start: hunk.old_start(),
                    old_lines: hunk.old_lines(),
                    new_start: hunk.new_start(),
                    new_lines: hunk.new_lines(),
                    lines,
                });
            }
        }
    }

    Ok(Some(ChangedFile {
        staged: staged.map(|paths| paths.contains(&path)),
        path,
        old_path: renamed_from,
        status,
        hunks,
        added_lines,
        removed_lines,
        binary,
    }))
}

/// Paths whose changes are staged (present in the HEAD-vs-index diff). Used to mark
/// each changed file's `staged` flag in the combined view.
fn staged_paths(repo: &Repository, head_tree: Option<&Tree>) -> AppResult<HashSet<String>> {
    let mut paths = HashSet::new();
    let index = repo.index()?;
    let diff = repo.diff_tree_to_index(head_tree, Some(&index), None)?;
    for delta in diff.deltas() {
        if let Some(path) = delta.new_file().path().or_else(|| delta.old_file().path()) {
            paths.insert(path_string(path));
        }
    }
    Ok(paths)
}

/// The HEAD commit's tree, or `None` for an unborn branch (no commits yet), in which
/// case the diff treats every tracked path as freshly added.
fn head_tree(repo: &Repository) -> AppResult<Option<Tree<'_>>> {
    match repo.head() {
        Ok(head) => {
            let commit = head.peel_to_commit()?;
            Ok(Some(commit.tree()?))
        }
        Err(_) => Ok(None),
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// libgit2 flags binary files lazily, so `DiffFile::is_binary()` is unreliable until a
/// patch is generated. Detect it ourselves the way git does: a NUL byte in the first
/// 8000 bytes of either side's content. Checks HEAD's blob and the working file so it
/// catches added, modified, and deleted binaries alike.
pub(crate) fn path_change_is_binary(repo: &Repository, root: &Path, path: &str) -> bool {
    head_blob_bytes(repo, path)
        .as_deref()
        .is_some_and(looks_binary)
        || working_bytes(root, path).as_deref().is_some_and(looks_binary)
}

/// The branch-mode equivalent: both sides of the change are committed blobs, so probe
/// the delta's own oids instead of HEAD and the filesystem.
fn delta_change_is_binary(repo: &Repository, delta: &DiffDelta<'_>) -> bool {
    blob_bytes(repo, delta.old_file().id())
        .as_deref()
        .is_some_and(looks_binary)
        || blob_bytes(repo, delta.new_file().id())
            .as_deref()
            .is_some_and(looks_binary)
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|&b| b == 0)
}

fn blob_bytes(repo: &Repository, oid: Oid) -> Option<Vec<u8>> {
    if oid.is_zero() {
        return None;
    }
    repo.find_blob(oid).ok().map(|b| b.content().to_vec())
}

fn head_blob_bytes(repo: &Repository, path: &str) -> Option<Vec<u8>> {
    let tree = repo.head().ok()?.peel_to_commit().ok()?.tree().ok()?;
    let entry = tree.get_path(Path::new(path)).ok()?;
    let blob = entry.to_object(repo).ok()?.peel_to_blob().ok()?;
    Some(blob.content().to_vec())
}

fn working_bytes(root: &Path, path: &str) -> Option<Vec<u8>> {
    std::fs::read(root.join(path)).ok()
}

/// Decode a diff line/header, dropping a single trailing newline (git2 keeps the
/// terminating `\n`/`\r\n` on each line's content).
fn line_content(bytes: &[u8]) -> String {
    let mut text = String::from_utf8_lossy(bytes).into_owned();
    if text.ends_with('\n') {
        text.pop();
        if text.ends_with('\r') {
            text.pop();
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn run(repo_dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(repo_dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .expect("git");
        assert!(status.status.success(), "git {:?} failed", args);
    }

    fn branch_spec(base: &str, target: &str) -> DiffSpec {
        DiffSpec::Branches {
            base_ref: base.to_string(),
            target_ref: target.to_string(),
            strategy: DiffStrategy::MergeBase,
        }
    }

    fn commit_spec(rev: &str, branch_ref: Option<&str>) -> DiffSpec {
        DiffSpec::Commit {
            oid: rev.to_string(),
            branch_ref: branch_ref.map(str::to_string),
        }
    }

    /// The full oid of `rev`, the way the picker would hand one over.
    fn oid_of(repo: &Repository, rev: &str) -> String {
        repo.revparse_single(rev)
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id()
            .to_string()
    }

    #[test]
    fn detects_modified_added_and_untracked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        run(path, &["init", "-q", "-b", "master"]);
        fs::write(path.join("kept.txt"), "line1\nline2\nline3\n").unwrap();
        run(path, &["add", "."]);
        run(path, &["commit", "-qm", "init"]);

        // Modify a tracked file (unstaged) and create a new untracked file.
        fs::write(path.join("kept.txt"), "line1\nCHANGED\nline3\n").unwrap();
        fs::write(path.join("fresh.txt"), "brand new\n").unwrap();

        let repo = Repository::open(path).unwrap();
        let summary = compute(&repo, &DiffSpec::Worktree).unwrap();

        let modified = summary
            .files
            .iter()
            .find(|f| f.path == "kept.txt")
            .expect("kept.txt in diff");
        assert!(matches!(modified.status, ChangeStatus::Modified));
        assert_eq!(modified.added_lines, 1);
        assert_eq!(modified.removed_lines, 1);
        assert!(!modified.hunks.is_empty());

        let fresh = summary
            .files
            .iter()
            .find(|f| f.path == "fresh.txt")
            .expect("fresh.txt in diff");
        assert!(matches!(fresh.status, ChangeStatus::Added));
        assert_eq!(fresh.added_lines, 1);
    }

    #[test]
    fn marks_staged_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        run(path, &["init", "-q", "-b", "master"]);
        fs::write(path.join("a.txt"), "a\n").unwrap();
        run(path, &["add", "."]);
        run(path, &["commit", "-qm", "init"]);

        fs::write(path.join("a.txt"), "a changed\n").unwrap();
        run(path, &["add", "a.txt"]);

        let repo = Repository::open(path).unwrap();
        let summary = compute(&repo, &DiffSpec::Worktree).unwrap();
        let file = summary.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(file.staged, Some(true), "a.txt should be marked staged");
    }

    /// `master` and `feature` both moved past the fork point; `feature` adds, deletes,
    /// renames and modifies files, and `master` has a change of its own that must not
    /// leak into `master...feature`.
    fn diverged_repo(root: &Path) {
        run(root, &["init", "-q", "-b", "master"]);
        fs::write(root.join("kept.txt"), "one\ntwo\nthree\n").unwrap();
        fs::write(root.join("gone.txt"), "delete me\n").unwrap();
        fs::write(root.join("old-name.txt"), "rename me\nline two\nline three\n").unwrap();
        run(root, &["add", "."]);
        run(root, &["commit", "-qm", "init"]);

        run(root, &["checkout", "-qb", "feature"]);
        fs::write(root.join("kept.txt"), "one\nCHANGED\nthree\n").unwrap();
        fs::remove_file(root.join("gone.txt")).unwrap();
        fs::rename(root.join("old-name.txt"), root.join("new-name.txt")).unwrap();
        fs::write(root.join("added.txt"), "brand new\n").unwrap();
        run(root, &["add", "-A"]);
        run(root, &["commit", "-qm", "feature work"]);

        run(root, &["checkout", "-q", "master"]);
        fs::write(root.join("base-only.txt"), "base side\n").unwrap();
        run(root, &["add", "."]);
        run(root, &["commit", "-qm", "master work"]);
    }

    #[test]
    fn branch_diff_uses_merge_base_and_reports_every_status() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        diverged_repo(root);

        let repo = Repository::open(root).unwrap();
        let summary = compute(
            &repo,
            &branch_spec("refs/heads/master", "refs/heads/feature"),
        )
        .unwrap();

        let by_path = |p: &str| summary.files.iter().find(|f| f.path == p);
        assert!(matches!(
            by_path("kept.txt").unwrap().status,
            ChangeStatus::Modified
        ));
        assert!(matches!(
            by_path("gone.txt").unwrap().status,
            ChangeStatus::Deleted
        ));
        assert!(matches!(
            by_path("added.txt").unwrap().status,
            ChangeStatus::Added
        ));
        let renamed = by_path("new-name.txt").unwrap();
        assert!(matches!(renamed.status, ChangeStatus::Renamed));
        assert_eq!(renamed.old_path.as_deref(), Some("old-name.txt"));

        // master's own post-fork commit is behind the merge base → not in the diff.
        assert!(
            by_path("base-only.txt").is_none(),
            "merge-base semantics exclude base-only commits"
        );

        // Committed history has no staging state.
        assert!(summary.files.iter().all(|f| f.staged.is_none()));

        match summary.comparison {
            Comparison::Branches {
                ref base_name,
                ref target_name,
                ref merge_base,
                ref base_oid,
                ..
            } => {
                assert_eq!(base_name, "master");
                assert_eq!(target_name, "feature");
                assert_ne!(merge_base, base_oid, "both sides moved past the fork");
            }
            _ => panic!("expected a branch comparison"),
        }
    }

    #[test]
    fn branch_diff_reverses_with_the_direction() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        diverged_repo(root);
        let repo = Repository::open(root).unwrap();

        let forward = compute(
            &repo,
            &branch_spec("refs/heads/master", "refs/heads/feature"),
        )
        .unwrap();
        let reverse = compute(
            &repo,
            &branch_spec("refs/heads/feature", "refs/heads/master"),
        )
        .unwrap();

        // Forward reviews feature's work; reverse reviews master's.
        assert!(forward.files.iter().any(|f| f.path == "added.txt"));
        assert!(!reverse.files.iter().any(|f| f.path == "added.txt"));
        assert!(reverse.files.iter().any(|f| f.path == "base-only.txt"));
    }

    #[test]
    fn branch_diff_ignores_a_dirty_worktree_and_index() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        diverged_repo(root);

        // Dirty the checkout in every way that shows up in worktree mode.
        fs::write(root.join("kept.txt"), "wildly different\n").unwrap();
        fs::write(root.join("untracked.txt"), "not committed\n").unwrap();
        run(root, &["add", "untracked.txt"]);

        let repo = Repository::open(root).unwrap();
        let summary = compute(
            &repo,
            &branch_spec("refs/heads/master", "refs/heads/feature"),
        )
        .unwrap();
        assert!(!summary.files.iter().any(|f| f.path == "untracked.txt"));
        let kept = summary.files.iter().find(|f| f.path == "kept.txt").unwrap();
        assert_eq!(
            kept.hunks[0]
                .lines
                .iter()
                .filter(|l| matches!(l.kind, DiffLineKind::Added))
                .map(|l| l.content.as_str())
                .collect::<Vec<_>>(),
            vec!["CHANGED"],
            "the committed change is shown, not the dirty working copy"
        );
    }

    #[test]
    fn branch_diff_detects_binary_changes_from_blobs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        run(root, &["init", "-q", "-b", "master"]);
        fs::write(root.join("logo.bin"), [0u8, 1, 2, 3, 4]).unwrap();
        run(root, &["add", "."]);
        run(root, &["commit", "-qm", "init"]);

        run(root, &["checkout", "-qb", "feature"]);
        fs::write(root.join("logo.bin"), [0u8, 9, 9, 9, 9]).unwrap();
        run(root, &["commit", "-qam", "new logo"]);
        // Restore the working tree to the base content so a filesystem-based probe
        // would look at the wrong bytes — the delta's blobs are what matter.
        run(root, &["checkout", "-q", "master"]);

        let repo = Repository::open(root).unwrap();
        let summary = compute(
            &repo,
            &branch_spec("refs/heads/master", "refs/heads/feature"),
        )
        .unwrap();
        let logo = summary.files.iter().find(|f| f.path == "logo.bin").unwrap();
        assert!(logo.binary, "binary change detected from the delta blobs");
        assert!(logo.hunks.is_empty());
    }

    #[test]
    fn identical_branches_produce_no_changes_and_bad_refs_error() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        diverged_repo(root);
        run(root, &["branch", "twin", "feature"]);

        let repo = Repository::open(root).unwrap();
        let summary = compute(
            &repo,
            &branch_spec("refs/heads/twin", "refs/heads/feature"),
        )
        .unwrap();
        assert!(summary.files.is_empty(), "identical tips → empty diff");

        assert!(compute(
            &repo,
            &branch_spec("refs/heads/feature", "refs/heads/feature")
        )
        .is_err());
        assert!(compute(
            &repo,
            &branch_spec("refs/heads/master", "refs/heads/ghost")
        )
        .is_err());
    }

    #[test]
    fn branch_diff_follows_a_moved_branch_on_recompute() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        diverged_repo(root);
        let spec = branch_spec("refs/heads/master", "refs/heads/feature");

        {
            let repo = Repository::open(root).unwrap();
            let before = compute(&repo, &spec).unwrap();
            assert!(!before.files.iter().any(|f| f.path == "later.txt"));
        }

        run(root, &["checkout", "-q", "feature"]);
        fs::write(root.join("later.txt"), "added after the first read\n").unwrap();
        run(root, &["add", "."]);
        run(root, &["commit", "-qm", "more feature work"]);

        let repo = Repository::open(root).unwrap();
        let after = compute(&repo, &spec).unwrap();
        assert!(after.files.iter().any(|f| f.path == "later.txt"));
    }

    #[test]
    fn commit_diff_shows_one_commit_against_its_parent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        diverged_repo(root);
        let repo = Repository::open(root).unwrap();

        // feature's single commit: modify, delete, rename, add.
        let summary = compute(
            &repo,
            &commit_spec(&oid_of(&repo, "refs/heads/feature"), Some("refs/heads/feature")),
        )
        .unwrap();

        let by_path = |p: &str| summary.files.iter().find(|f| f.path == p);
        assert!(matches!(
            by_path("kept.txt").unwrap().status,
            ChangeStatus::Modified
        ));
        assert!(matches!(
            by_path("gone.txt").unwrap().status,
            ChangeStatus::Deleted
        ));
        assert!(matches!(
            by_path("added.txt").unwrap().status,
            ChangeStatus::Added
        ));
        let renamed = by_path("new-name.txt").unwrap();
        assert!(matches!(renamed.status, ChangeStatus::Renamed));
        assert_eq!(renamed.old_path.as_deref(), Some("old-name.txt"));
        // master's own post-fork commit is on the other side of history entirely.
        assert!(by_path("base-only.txt").is_none());

        // Committed history has no staging state.
        assert!(summary.files.iter().all(|f| f.staged.is_none()));

        match summary.comparison {
            Comparison::Commit {
                ref oid,
                ref short_oid,
                ref summary,
                ref parent_oid,
                ref branch_name,
                is_merge,
                ..
            } => {
                assert_eq!(oid, &oid_of(&repo, "refs/heads/feature"));
                assert_eq!(short_oid, &oid[..7]);
                assert_eq!(summary, "feature work");
                assert_eq!(parent_oid.as_deref(), Some(oid_of(&repo, "refs/heads/feature~1").as_str()));
                assert_eq!(branch_name.as_deref(), Some("feature"), "shorthand, not the full ref");
                assert!(!is_merge);
            }
            _ => panic!("expected a commit comparison"),
        }
    }

    #[test]
    fn commit_diff_uses_the_first_parent_of_a_merge() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        diverged_repo(root);
        // master (with base-only.txt) merges feature in; master is parent 1.
        run(root, &["merge", "-q", "--no-ff", "-m", "merge feature", "feature"]);

        let repo = Repository::open(root).unwrap();
        let head = oid_of(&repo, "HEAD");
        let summary = compute(&repo, &commit_spec(&head, None)).unwrap();

        // Against parent 1 (master), the merge introduces feature's work…
        assert!(summary.files.iter().any(|f| f.path == "added.txt"));
        // …and not master's own base-only.txt, which parent 1 already had.
        assert!(!summary.files.iter().any(|f| f.path == "base-only.txt"));

        match summary.comparison {
            Comparison::Commit {
                is_merge,
                ref parent_oid,
                ref branch_name,
                ..
            } => {
                assert!(is_merge);
                assert_eq!(parent_oid.as_deref(), Some(oid_of(&repo, "HEAD^1").as_str()));
                assert!(branch_name.is_none(), "no branch context was supplied");
            }
            _ => panic!("expected a commit comparison"),
        }
    }

    #[test]
    fn root_commit_reads_as_all_additions() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        diverged_repo(root);
        let repo = Repository::open(root).unwrap();
        let first = oid_of(&repo, "refs/heads/master~1");

        let summary = compute(&repo, &commit_spec(&first, None)).unwrap();
        assert!(!summary.files.is_empty());
        assert!(
            summary
                .files
                .iter()
                .all(|f| matches!(f.status, ChangeStatus::Added)),
            "a root commit has no old tree, so everything is added"
        );
        assert!(summary.files.iter().all(|f| f.removed_lines == 0));
        match summary.comparison {
            Comparison::Commit { ref parent_oid, .. } => assert!(parent_oid.is_none()),
            _ => panic!("expected a commit comparison"),
        }
    }

    #[test]
    fn commit_diff_ignores_the_worktree_and_rejects_bad_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        diverged_repo(root);
        // Dirty the checkout in every way that shows up in worktree mode.
        fs::write(root.join("kept.txt"), "wildly different\n").unwrap();
        fs::write(root.join("untracked.txt"), "not committed\n").unwrap();
        run(root, &["add", "untracked.txt"]);

        let repo = Repository::open(root).unwrap();
        let summary = compute(
            &repo,
            &commit_spec(&oid_of(&repo, "refs/heads/feature"), None),
        )
        .unwrap();
        assert!(!summary.files.iter().any(|f| f.path == "untracked.txt"));
        let kept = summary.files.iter().find(|f| f.path == "kept.txt").unwrap();
        assert_eq!(
            kept.hunks[0]
                .lines
                .iter()
                .filter(|l| matches!(l.kind, DiffLineKind::Added))
                .map(|l| l.content.as_str())
                .collect::<Vec<_>>(),
            vec!["CHANGED"],
            "the committed change is shown, not the dirty working copy"
        );

        assert!(compute(&repo, &commit_spec("not-a-revision", None)).is_err());
    }

    #[test]
    fn commit_diff_detects_binary_changes_from_blobs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        run(root, &["init", "-q", "-b", "master"]);
        fs::write(root.join("logo.bin"), [0u8, 1, 2, 3, 4]).unwrap();
        run(root, &["add", "."]);
        run(root, &["commit", "-qm", "init"]);
        fs::write(root.join("logo.bin"), [0u8, 9, 9, 9, 9]).unwrap();
        run(root, &["commit", "-qam", "new logo"]);
        // A text file on disk where the binary used to be would fool a path probe.
        fs::write(root.join("logo.bin"), "now plain text\n").unwrap();

        let repo = Repository::open(root).unwrap();
        let summary = compute(&repo, &commit_spec(&oid_of(&repo, "HEAD"), None)).unwrap();
        let logo = summary.files.iter().find(|f| f.path == "logo.bin").unwrap();
        assert!(logo.binary, "binary change detected from the delta blobs");
        assert!(logo.hunks.is_empty());
    }

    /// The IPC contract with `src/types/diff.ts`. A renamed field here fails only at
    /// runtime, in a picker the Rust tests never touch, so pin the exact wire shape.
    #[test]
    fn commit_spec_and_comparison_match_the_typescript_shape() {
        let spec: DiffSpec =
            serde_json::from_str(r#"{"kind":"commit","oid":"abc","branchRef":"refs/heads/x"}"#)
                .unwrap();
        assert_eq!(
            spec,
            commit_spec("abc", Some("refs/heads/x")),
            "camelCase branchRef, tagged `commit`"
        );
        // serde emits null for None, which the TS side reads as `string | null`.
        let no_branch: DiffSpec =
            serde_json::from_str(r#"{"kind":"commit","oid":"abc","branchRef":null}"#).unwrap();
        assert_eq!(no_branch, commit_spec("abc", None));

        let json = serde_json::to_value(Comparison::Commit {
            oid: "a".repeat(40),
            short_oid: "aaaaaaa".into(),
            summary: "subject".into(),
            author_name: "Ada".into(),
            timestamp: 7,
            parent_oid: None,
            is_merge: false,
            branch_name: Some("x".into()),
        })
        .unwrap();
        // serde_json orders keys alphabetically; only the names are the contract.
        let keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            vec![
                "authorName",
                "branchName",
                "isMerge",
                "kind",
                "oid",
                "parentOid",
                "shortOid",
                "summary",
                "timestamp",
            ]
        );
        assert_eq!(json["kind"], "commit");
        assert!(json["parentOid"].is_null(), "a root commit reads as null");
    }

    #[test]
    fn comparison_never_mutates_the_repository() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        diverged_repo(root);
        // master is checked out with a dirty file and a staged addition.
        fs::write(root.join("kept.txt"), "dirty\n").unwrap();
        fs::write(root.join("staged.txt"), "staged\n").unwrap();
        run(root, &["add", "staged.txt"]);

        let snapshot = |dir: &Path| {
            let out = std::process::Command::new("git")
                .args(["status", "--porcelain=v1", "--branch"])
                .current_dir(dir)
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        let before = snapshot(root);

        let repo = Repository::open(root).unwrap();
        compute(
            &repo,
            &branch_spec("refs/heads/master", "refs/heads/feature"),
        )
        .unwrap();

        assert_eq!(before, snapshot(root), "checkout/index/worktree untouched");
    }
}
