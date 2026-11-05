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

    #[test]
    fn worktree_reads_reject_paths_outside_the_repository() {
        let fixture = crate::test_support::TestRepo::new();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "outside").unwrap();
        let path = outside.path().join("secret.txt");
        // root.join must not allow an absolute path to bypass the boundary check.
        let error = read_file(&fixture.repo, &ProjectSource::Worktree, fixture.path(), path.to_str().unwrap()).unwrap_err();
        assert!(error.to_string().contains("path escapes the repository"));
        let parent = fixture.path().parent().unwrap();
        let sibling = tempfile::Builder::new().prefix("read-boundary-").tempfile_in(parent).unwrap();
        let rel = format!("../{}", sibling.path().file_name().unwrap().to_str().unwrap());
        assert!(read_file(&fixture.repo, &ProjectSource::Worktree, fixture.path(), &rel).unwrap_err().to_string().contains("path escapes the repository"));
    }

    #[cfg(unix)]
    #[test]
    fn worktree_reads_allow_internal_symlinks_and_reject_external_ones() {
        use std::os::unix::fs::symlink;
        let fixture = crate::test_support::TestRepo::new();
        fixture.write("inside.txt", "inside");
        let outside = tempfile::NamedTempFile::new().unwrap();
        symlink("inside.txt", fixture.path().join("internal")).unwrap();
        symlink(outside.path(), fixture.path().join("external")).unwrap();
        assert_eq!(read_file(&fixture.repo, &ProjectSource::Worktree, fixture.path(), "internal").unwrap(), "inside");
        assert!(read_file(&fixture.repo, &ProjectSource::Worktree, fixture.path(), "external").unwrap_err().to_string().contains("path escapes the repository"));
    }

    #[test]
    fn invalid_utf8_is_an_error_for_both_worktree_and_committed_reads() {
        let fixture = crate::test_support::TestRepo::new();
        fixture.write("binary.dat", [0xff, 0xfe, 0x80]);
        let oid = fixture.commit("invalid UTF-8");
        assert!(read_file(&fixture.repo, &ProjectSource::Worktree, fixture.path(), "binary.dat").is_err());
        let error = read_file(&fixture.repo, &ProjectSource::Commit { oid }, fixture.path(), "binary.dat").unwrap_err();
        assert!(error.to_string().contains("not valid UTF-8"));
    }

    #[test]
    fn invalid_or_unknown_commits_do_not_fall_back_to_the_worktree() {
        let fixture = crate::test_support::TestRepo::new();
        fixture.write("file.txt", "must not be returned");
        for oid in ["bad", "1111111111111111111111111111111111111111"] {
            assert!(read_file(&fixture.repo, &ProjectSource::Commit { oid: oid.into() }, fixture.path(), "file.txt").is_err());
        }
    }

    #[test]
    fn missing_files_and_directories_cannot_be_read_as_text() {
        let fixture = crate::test_support::TestRepo::new();
        fixture.write("dir/file.txt", "text");
        let source = ProjectSource::Commit { oid: fixture.commit("directory") };
        for source in [&source, &ProjectSource::Worktree] {
            for path in ["missing", "dir"] {
                assert!(read_file(&fixture.repo, source, fixture.path(), path).is_err());
            }
        }
    }
}
