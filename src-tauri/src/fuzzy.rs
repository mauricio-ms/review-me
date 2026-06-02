use std::collections::BTreeSet;

use git2::{Repository, Status, StatusOptions};
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::Serialize;

use crate::error::AppResult;
use crate::repo;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatch {
    pub path: String,
    pub score: u32,
    /// Char indices in `path` that matched the query (for highlighting).
    pub indices: Vec<u32>,
}

/// Repo-relative paths of all files worth navigating: everything git tracks plus
/// untracked-but-not-ignored files, restricted to paths that still exist on disk.
pub fn repo_files(repo: &Repository) -> AppResult<Vec<String>> {
    let mut set: BTreeSet<String> = BTreeSet::new();

    let index = repo.index()?;
    for entry in index.iter() {
        set.insert(String::from_utf8_lossy(&entry.path).into_owned());
    }

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts))?;
    for entry in statuses.iter() {
        if entry.status().contains(Status::WT_NEW) {
            if let Some(path) = entry.path() {
                set.insert(path.to_string());
            }
        }
    }

    let root = repo::root(repo)?;
    Ok(set
        .into_iter()
        .filter(|rel| root.join(rel).is_file())
        .collect())
}

/// Fuzzy-rank the repo's files against `query`. Empty query returns the first
/// `limit` files (path-sorted) so the finder shows content immediately.
pub fn fuzzy_files(repo: &Repository, query: &str, limit: usize) -> AppResult<Vec<FileMatch>> {
    let files = repo_files(repo)?;
    let query = query.trim();

    if query.is_empty() {
        return Ok(files
            .into_iter()
            .take(limit)
            .map(|path| FileMatch {
                path,
                score: 0,
                indices: Vec::new(),
            })
            .collect());
    }

    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);

    let mut haystack_buf: Vec<char> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut matches: Vec<FileMatch> = Vec::new();

    for path in &files {
        indices.clear();
        let haystack = Utf32Str::new(path, &mut haystack_buf);
        if let Some(score) = pattern.indices(haystack, &mut matcher, &mut indices) {
            let mut idx = indices.clone();
            idx.sort_unstable();
            idx.dedup();
            matches.push(FileMatch {
                path: path.clone(),
                score,
                indices: idx,
            });
        }
    }

    // Highest score first; break ties by shorter path then lexicographically.
    matches.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.path.len().cmp(&b.path.len()))
            .then_with(|| a.path.cmp(&b.path))
    });
    matches.truncate(limit);
    Ok(matches)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn run(dir: &std::path::Path, args: &[&str]) {
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

    #[test]
    fn ranks_tracked_and_untracked_skips_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        run(path, &["init", "-q", "-b", "master"]);
        fs::create_dir_all(path.join("src/main")).unwrap();
        fs::write(path.join("src/main/App.java"), "x").unwrap();
        fs::write(path.join("README.md"), "x").unwrap();
        fs::write(path.join(".gitignore"), "ignored.txt\n").unwrap();
        run(path, &["add", "."]);
        run(path, &["commit", "-qm", "init"]);
        fs::write(path.join("Untracked.java"), "x").unwrap();
        fs::write(path.join("ignored.txt"), "x").unwrap();

        let repo = Repository::open(path).unwrap();
        let all = repo_files(&repo).unwrap();
        assert!(all.contains(&"src/main/App.java".to_string()));
        assert!(all.contains(&"Untracked.java".to_string()));
        assert!(!all.contains(&"ignored.txt".to_string()), "ignored excluded");

        let hits = fuzzy_files(&repo, "appjava", 10).unwrap();
        assert_eq!(hits.first().map(|m| m.path.as_str()), Some("src/main/App.java"));
    }
}
