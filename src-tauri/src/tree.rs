use std::path::Path;

use git2::{Repository, Tree};
use serde::Serialize;

use crate::error::AppResult;
use crate::repo;
use crate::revision::{self, ProjectSource};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub name: String,
    /// Repo-relative path (forward slashes).
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeListing {
    /// Repo-relative path of the listed directory ("" for the repo root).
    pub path: String,
    pub entries: Vec<TreeEntry>,
}

/// The immediate children of a repo-relative directory, unsorted. In the working tree
/// that means skipping `.git` and git-ignored paths so project mode mirrors what's
/// under version control; in a committed tree everything present is by definition
/// tracked.
fn children(repo: &Repository, tree: Option<&Tree>, rel: &str) -> AppResult<Vec<TreeEntry>> {
    let child_path = |name: &str| {
        if rel.is_empty() {
            name.to_string()
        } else {
            format!("{rel}/{name}")
        }
    };

    let mut entries = Vec::new();
    match tree {
        Some(tree) => {
            for (name, is_dir) in revision::list_tree_dir(repo, tree, rel)? {
                entries.push(TreeEntry {
                    path: child_path(&name),
                    name,
                    is_dir,
                });
            }
        }
        None => {
            let root = repo::root(repo)?;
            let dir = if rel.is_empty() {
                root.clone()
            } else {
                root.join(rel)
            };
            if let Ok(read_dir) = std::fs::read_dir(&dir) {
                for entry in read_dir.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name == ".git" {
                        continue;
                    }
                    let child_rel = child_path(&name);
                    if repo.is_path_ignored(Path::new(&child_rel)).unwrap_or(false) {
                        continue;
                    }
                    // A symlink is never a dir here, so the folder walk below can't loop.
                    let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    entries.push(TreeEntry {
                        name,
                        path: child_rel,
                        is_dir,
                    });
                }
            }
        }
    }
    Ok(entries)
}

/// Follow a folder down while it holds nothing but one other folder, so a Java
/// package (`java/com/acme/billing`) is one row instead of four: the entry keeps its
/// place, its name grows to the chain (`java/com/acme/billing`), and its path becomes
/// the deepest folder's — the one whose children expanding it lists. A folder with a
/// file, two children, or none stops the walk.
fn compact(repo: &Repository, tree: Option<&Tree>, mut entry: TreeEntry) -> AppResult<TreeEntry> {
    while entry.is_dir {
        let mut inner = children(repo, tree, &entry.path)?;
        if inner.len() != 1 || !inner[0].is_dir {
            break;
        }
        let only = inner.remove(0);
        entry.name = format!("{}/{}", entry.name, only.name);
        entry.path = only.path;
    }
    Ok(entry)
}

/// List a repo-relative directory of `source` for the project tree: folders first, by
/// name, each folder compacted through its single-folder descendants.
pub fn list_dir(repo: &Repository, source: &ProjectSource, rel: &str) -> AppResult<TreeListing> {
    let rel = rel.trim_matches('/');
    let tree = revision::tree(repo, source)?;
    let mut entries = children(repo, tree.as_ref(), rel)?
        .into_iter()
        .map(|entry| compact(repo, tree.as_ref(), entry))
        .collect::<AppResult<Vec<_>>>()?;

    entries.sort_by(|a, b| {
        let rank = |e: &TreeEntry| if e.is_dir { 0 } else { 1 };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(TreeListing {
        path: rel.to_string(),
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn run(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {:?}", args);
    }

    fn names(listing: &TreeListing) -> Vec<(&str, &str)> {
        listing
            .entries
            .iter()
            .map(|e| (e.name.as_str(), e.path.as_str()))
            .collect()
    }

    /// A Maven layout: `src/main/java/com/example/{App.java, model/Book.java}`, a
    /// resources folder beside `java`, and a README at the root.
    fn maven(path: &Path) {
        run(path, &["init", "-q", "-b", "master"]);
        fs::create_dir_all(path.join("src/main/java/com/example/model")).unwrap();
        fs::create_dir_all(path.join("src/main/resources/db")).unwrap();
        fs::write(path.join("src/main/java/com/example/App.java"), "x").unwrap();
        fs::write(path.join("src/main/java/com/example/model/Book.java"), "x").unwrap();
        fs::write(path.join("src/main/resources/db/V1.sql"), "x").unwrap();
        fs::write(path.join("README.md"), "x").unwrap();
        run(path, &["add", "."]);
        run(path, &["commit", "-qm", "init"]);
    }

    #[test]
    fn compacts_single_folder_chains() {
        let dir = tempfile::tempdir().unwrap();
        maven(dir.path());
        let repo = Repository::open(dir.path()).unwrap();

        // `src` holds only `main`, which holds two folders: the chain stops there.
        let root = list_dir(&repo, &ProjectSource::Worktree, "").unwrap();
        assert_eq!(names(&root), vec![("src/main", "src/main"), ("README.md", "README.md")]);

        let main = list_dir(&repo, &ProjectSource::Worktree, "src/main").unwrap();
        assert_eq!(
            names(&main),
            vec![
                ("java/com/example", "src/main/java/com/example"),
                ("resources/db", "src/main/resources/db"),
            ],
        );

        // Expanding a chain lists its deepest folder; `model` holds a file, so it stays.
        let example = list_dir(&repo, &ProjectSource::Worktree, "src/main/java/com/example").unwrap();
        assert_eq!(
            names(&example),
            vec![
                ("model", "src/main/java/com/example/model"),
                ("App.java", "src/main/java/com/example/App.java"),
            ],
        );
    }

    #[test]
    fn compacts_a_committed_tree_too() {
        let dir = tempfile::tempdir().unwrap();
        maven(dir.path());
        let repo = Repository::open(dir.path()).unwrap();
        let oid = repo.head().unwrap().target().unwrap().to_string();
        // The working tree moves on; the commit's tree is what gets listed.
        fs::write(dir.path().join("src/main/java/Loose.java"), "x").unwrap();

        let commit = ProjectSource::Commit { oid };
        let main = list_dir(&repo, &commit, "src/main").unwrap();
        assert_eq!(names(&main)[0], ("java/com/example", "src/main/java/com/example"));

        // On disk `java` now has a file of its own, so the chain stops at it.
        let disk = list_dir(&repo, &ProjectSource::Worktree, "src/main").unwrap();
        assert_eq!(names(&disk)[0], ("java", "src/main/java"));
    }

    #[test]
    fn an_ignored_sibling_does_not_break_a_chain() {
        let dir = tempfile::tempdir().unwrap();
        maven(dir.path());
        fs::write(dir.path().join(".gitignore"), "build/\n").unwrap();
        fs::create_dir_all(dir.path().join("src/main/java/com/build")).unwrap();
        let repo = Repository::open(dir.path()).unwrap();

        // `com/build` is ignored, so `com` still holds a single folder.
        let main = list_dir(&repo, &ProjectSource::Worktree, "src/main").unwrap();
        assert_eq!(names(&main)[0], ("java/com/example", "src/main/java/com/example"));
    }
}
