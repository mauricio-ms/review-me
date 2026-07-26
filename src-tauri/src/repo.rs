use std::path::{Path, PathBuf};

use git2::{Repository, Status, StatusOptions};
use serde::Serialize;

use crate::branches;
use crate::error::{AppError, AppResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Absolute canonical path to the repository working directory.
    pub root: String,
    /// Short HEAD sha (empty for an unborn branch).
    pub head: String,
    /// Branch shorthand, or a marker like "(detached)" / "(no commits)".
    pub branch: String,
    /// The **review branch** to start on: the canonical ref HEAD is on, else the
    /// repo's default branch (a detached or unborn HEAD is on no branch). `None` when
    /// the repo has no branches at all. App-level only — nothing is ever checked out.
    pub review_branch_ref: Option<String>,
    /// Whether the working tree has any uncommitted change (incl. untracked).
    pub is_dirty: bool,
}

/// Open the git repository that contains `path` (discovers an enclosing repo so a
/// subdirectory selection also works). Rejects bare repositories — we need a
/// working tree to diff against HEAD.
pub fn open(path: &Path) -> AppResult<Repository> {
    let repo = Repository::discover(path)
        .map_err(|e| AppError::Repo(format!("not a git repository: {e}")))?;
    if repo.is_bare() {
        return Err(AppError::Repo("bare repositories are not supported".into()));
    }
    Ok(repo)
}

/// The canonical working-directory root of an open repository.
pub fn root(repo: &Repository) -> AppResult<PathBuf> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::Repo("repository has no working directory".into()))?;
    Ok(workdir.canonicalize().unwrap_or_else(|_| workdir.to_path_buf()))
}

/// `(short_head_sha, branch_label)` for the current HEAD.
pub fn head_info(repo: &Repository) -> (String, String) {
    match repo.head() {
        Ok(head) => {
            let sha = head
                .target()
                .map(|oid| short_sha(&oid.to_string()))
                .unwrap_or_default();
            let branch = if head.is_branch() {
                head.shorthand().unwrap_or("HEAD").to_string()
            } else {
                "(detached)".to_string()
            };
            (sha, branch)
        }
        // Unborn branch (a freshly `git init`'d repo with no commits yet).
        Err(_) => (String::new(), "(no commits)".to_string()),
    }
}

/// The canonical ref of the branch HEAD is on, or `None` when HEAD is detached or
/// unborn.
pub fn head_branch_ref(repo: &Repository) -> Option<String> {
    let head = repo.head().ok()?;
    if !head.is_branch() {
        return None;
    }
    head.name().map(str::to_string)
}

pub fn info(repo: &Repository) -> AppResult<RepoInfo> {
    let (head, branch) = head_info(repo);
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts))?;
    let is_dirty = statuses
        .iter()
        .any(|entry| entry.status() != Status::CURRENT);
    Ok(RepoInfo {
        root: root(repo)?.to_string_lossy().into_owned(),
        head,
        branch,
        review_branch_ref: head_branch_ref(repo).or_else(|| branches::default_branch_ref(repo)),
        is_dirty,
    })
}

/// Cheap check used by the open-repo browser to mark which directories are repos.
pub fn is_git_repo(path: &Path) -> bool {
    path.join(".git").exists()
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .expect("git");
        assert!(out.status.success(), "git {args:?} failed");
    }

    fn commit_on(root: &Path, name: &str) {
        std::fs::write(root.join("a.txt"), format!("{name}\n")).unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", name]);
    }

    #[test]
    fn review_branch_starts_on_the_checked_out_branch() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q", "-b", "master"]);
        commit_on(root, "init");
        git(root, &["checkout", "-qb", "feature"]);
        commit_on(root, "feature work");

        let repo = Repository::open(root).unwrap();
        let info = info(&repo).unwrap();
        assert_eq!(info.branch, "feature");
        assert_eq!(info.review_branch_ref.as_deref(), Some("refs/heads/feature"));
    }

    #[test]
    fn detached_head_falls_back_to_the_default_branch() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q", "-b", "master"]);
        commit_on(root, "init");
        commit_on(root, "second");
        git(root, &["checkout", "-q", "--detach", "HEAD~1"]);

        let repo = Repository::open(root).unwrap();
        assert!(head_branch_ref(&repo).is_none(), "detached HEAD is on no branch");
        let info = info(&repo).unwrap();
        assert_eq!(info.branch, "(detached)");
        assert_eq!(
            info.review_branch_ref.as_deref(),
            Some("refs/heads/master"),
            "nothing is checked out to review, so offer the default branch"
        );
    }

    #[test]
    fn a_repo_with_no_commits_has_no_review_branch() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q", "-b", "master"]);

        let repo = Repository::open(root).unwrap();
        let info = info(&repo).unwrap();
        assert_eq!(info.branch, "(no commits)");
        assert!(
            info.review_branch_ref.is_none(),
            "an unborn branch is not a ref that resolves"
        );
    }
}
