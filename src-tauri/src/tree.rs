use std::path::Path;

use git2::Repository;
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

/// List the immediate children of a repo-relative directory in `source`. In the
/// working tree that means skipping `.git` and git-ignored paths so project mode
/// mirrors what's under version control; in a committed tree everything present is
/// by definition tracked.
pub fn list_dir(repo: &Repository, source: &ProjectSource, rel: &str) -> AppResult<TreeListing> {
    let rel = rel.trim_matches('/');
    let child_path = |name: &str| {
        if rel.is_empty() {
            name.to_string()
        } else {
            format!("{rel}/{name}")
        }
    };

    let mut entries = Vec::new();
    match revision::tree(repo, source)? {
        Some(tree) => {
            for (name, is_dir) in revision::list_tree_dir(repo, &tree, rel)? {
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
