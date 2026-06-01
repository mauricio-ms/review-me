use std::path::{Path, PathBuf};

use git2::{Repository, Status, StatusOptions};
use serde::Serialize;

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
