use std::collections::HashSet;
use std::path::Path;

use git2::{Delta, Diff, DiffFindOptions, DiffOptions, Patch, Repository, Tree};
use serde::Serialize;

use crate::error::AppResult;
use crate::repo;

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
    pub staged: bool,
    pub hunks: Vec<Hunk>,
    pub added_lines: u32,
    pub removed_lines: u32,
    pub binary: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub repo_root: String,
    pub head: String,
    pub branch: String,
    pub files: Vec<ChangedFile>,
}

/// Compute the working-tree-vs-HEAD diff: every uncommitted change, staged or not,
/// including newly created (untracked) files. This is the magit-status view.
pub fn compute(repo: &Repository) -> AppResult<DiffSummary> {
    let head_tree = head_tree(repo)?;

    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .context_lines(3);
    let mut diff = repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))?;
    diff.find_similar(Some(DiffFindOptions::new().renames(true)))?;

    let staged = staged_paths(repo, head_tree.as_ref())?;

    let mut files = Vec::new();
    for idx in 0..diff.deltas().len() {
        if let Some(file) = changed_file(&diff, idx, &staged)? {
            files.push(file);
        }
    }

    let (head, branch) = repo::head_info(repo);
    Ok(DiffSummary {
        repo_root: repo::root(repo)?.to_string_lossy().into_owned(),
        head,
        branch,
        files,
    })
}

fn changed_file(
    diff: &Diff,
    idx: usize,
    staged: &HashSet<String>,
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

    let binary = delta.new_file().is_binary() || delta.old_file().is_binary();
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
        staged: staged.contains(&path),
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
        let summary = compute(&repo).unwrap();

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
        let summary = compute(&repo).unwrap();
        let file = summary.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert!(file.staged, "a.txt should be marked staged");
    }
}
