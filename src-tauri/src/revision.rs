use std::path::Path;

use git2::{ObjectType, Oid, Repository, Tree, TreeWalkMode, TreeWalkResult};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Which snapshot of the repo project mode is reading. `Worktree` is the checkout on
/// disk; `Commit` is a resolved commit's tree — what branch comparison needs, so
/// opening a file from a `master...feature` diff shows *that branch's* content and
/// not whatever happens to be checked out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectSource {
    Worktree,
    #[serde(rename_all = "camelCase")]
    Commit { oid: String },
}

impl Default for ProjectSource {
    fn default() -> Self {
        ProjectSource::Worktree
    }
}

/// The tree `source` names, or `None` for the working tree (read from disk instead).
pub fn tree<'r>(repo: &'r Repository, source: &ProjectSource) -> AppResult<Option<Tree<'r>>> {
    match source {
        ProjectSource::Worktree => Ok(None),
        ProjectSource::Commit { oid } => {
            let oid = Oid::from_str(oid)
                .map_err(|_| AppError::Repo(format!("not a valid object id: {oid}")))?;
            let commit = repo
                .find_commit(oid)
                .map_err(|e| AppError::Repo(format!("unknown commit {oid}: {e}")))?;
            Ok(Some(commit.tree()?))
        }
    }
}

/// A repo-relative file's text content from `source`.
pub fn read_file(repo: &Repository, source: &ProjectSource, root: &Path, rel: &str) -> AppResult<String> {
    match tree(repo, source)? {
        None => {
            let full = root.join(rel);
            // Keep reads inside the repo root.
            let canonical = full.canonicalize()?;
            if !canonical.starts_with(root) {
                return Err(AppError::Repo("path escapes the repository".into()));
            }
            Ok(std::fs::read_to_string(canonical)?)
        }
        Some(tree) => {
            let entry = tree
                .get_path(Path::new(rel))
                .map_err(|_| AppError::Repo(format!("{rel} is not in this revision")))?;
            let blob = entry.to_object(repo)?.peel_to_blob()?;
            String::from_utf8(blob.content().to_vec())
                .map_err(|_| AppError::Repo(format!("{rel} is not valid UTF-8")))
        }
    }
}

/// `(name, is_dir)` for the immediate children of `rel` in a committed tree.
pub fn list_tree_dir(
    repo: &Repository,
    tree: &Tree,
    rel: &str,
) -> AppResult<Vec<(String, bool)>> {
    let subtree = if rel.is_empty() {
        tree.clone()
    } else {
        match tree.get_path(Path::new(rel)) {
            Ok(entry) => entry.to_object(repo)?.peel_to_tree()?,
            // A directory that doesn't exist in this revision simply has no children.
            Err(_) => return Ok(Vec::new()),
        }
    };
    Ok(subtree
        .iter()
        .filter_map(|entry| {
            let name = entry.name()?.to_string();
            Some((name, entry.kind() == Some(ObjectType::Tree)))
        })
        .collect())
}

/// Every blob path in a committed tree, repo-relative and sorted — the revision's
/// answer to "all the files worth navigating".
pub fn tree_files(tree: &Tree) -> AppResult<Vec<String>> {
    let mut files = Vec::new();
    tree.walk(TreeWalkMode::PreOrder, |dir, entry| {
        if entry.kind() == Some(ObjectType::Blob) {
            if let Some(name) = entry.name() {
                files.push(format!("{dir}{name}"));
            }
        }
        TreeWalkResult::Ok
    })?;
    files.sort();
    Ok(files)
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

    /// `master` has `src/app.txt` + `keep.txt`; `feature` rewrites `src/app.txt`,
    /// adds `src/extra.txt`, and deletes `keep.txt`.
    fn repo_with_branch(root: &Path) {
        git(root, &["init", "-q", "-b", "master"]);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/app.txt"), "base content\n").unwrap();
        std::fs::write(root.join("keep.txt"), "on master\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "init"]);

        git(root, &["checkout", "-qb", "feature"]);
        std::fs::write(root.join("src/app.txt"), "branch content\n").unwrap();
        std::fs::write(root.join("src/extra.txt"), "only on feature\n").unwrap();
        std::fs::remove_file(root.join("keep.txt")).unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-qm", "feature work"]);
        git(root, &["checkout", "-q", "master"]);
    }

    fn source_for(repo: &Repository, refname: &str) -> ProjectSource {
        let oid = repo
            .find_reference(refname)
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id();
        ProjectSource::Commit {
            oid: oid.to_string(),
        }
    }

    #[test]
    fn reads_file_content_from_the_named_revision() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        repo_with_branch(root);
        let repo = Repository::open(root).unwrap();
        let feature = source_for(&repo, "refs/heads/feature");

        // The checkout says "base content"; the revision must not.
        assert_eq!(
            read_file(&repo, &ProjectSource::Worktree, root, "src/app.txt").unwrap(),
            "base content\n"
        );
        assert_eq!(
            read_file(&repo, &feature, root, "src/app.txt").unwrap(),
            "branch content\n"
        );

        // A file deleted on the branch is readable from the base revision, and
        // missing from the branch's.
        let master = source_for(&repo, "refs/heads/master");
        assert_eq!(
            read_file(&repo, &master, root, "keep.txt").unwrap(),
            "on master\n"
        );
        assert!(read_file(&repo, &feature, root, "keep.txt").is_err());
    }

    #[test]
    fn lists_tree_directories_and_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        repo_with_branch(root);
        let repo = Repository::open(root).unwrap();
        let feature = source_for(&repo, "refs/heads/feature");
        let tree = tree(&repo, &feature).unwrap().unwrap();

        let top = list_tree_dir(&repo, &tree, "").unwrap();
        assert_eq!(top, vec![("src".to_string(), true)]);

        let mut src = list_tree_dir(&repo, &tree, "src").unwrap();
        src.sort();
        assert_eq!(
            src,
            vec![("app.txt".to_string(), false), ("extra.txt".to_string(), false)]
        );

        // A directory absent from the revision lists nothing rather than erroring.
        assert!(list_tree_dir(&repo, &tree, "nope").unwrap().is_empty());

        assert_eq!(
            tree_files(&tree).unwrap(),
            vec!["src/app.txt".to_string(), "src/extra.txt".to_string()]
        );
    }

    #[test]
    fn tree_reads_ignore_a_dirty_working_tree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        repo_with_branch(root);
        // Scribble over the checkout and add an untracked file.
        std::fs::write(root.join("src/app.txt"), "SCRIBBLE\n").unwrap();
        std::fs::write(root.join("src/untracked.txt"), "not committed\n").unwrap();

        let repo = Repository::open(root).unwrap();
        let feature = source_for(&repo, "refs/heads/feature");
        assert_eq!(
            read_file(&repo, &feature, root, "src/app.txt").unwrap(),
            "branch content\n"
        );
        let tree = tree(&repo, &feature).unwrap().unwrap();
        assert!(!tree_files(&tree)
            .unwrap()
            .contains(&"src/untracked.txt".to_string()));
    }
}
