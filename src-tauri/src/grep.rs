use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use git2::{Repository, Tree};
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::revision::ProjectSource;
use crate::{fuzzy, repo, revision};

const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024;
const MAX_HITS: usize = 1000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub repo: String,
    pub source: ProjectSource,
    pub query: String,
    /// None searches the repository; Some searches only these navigable files.
    pub only: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchRange {
    /// Zero-based UTF-16 offsets, as used by JavaScript and CodeMirror.
    pub from: usize,
    pub to: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub line: usize,
    pub col: usize,
    pub snippet: String,
    pub ranges: Vec<MatchRange>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub hits: Vec<SearchHit>,
    pub truncated: bool,
    pub skipped_files: usize,
    pub skipped_lines: usize,
    pub cancelled: bool,
}

#[derive(Default)]
struct Registry {
    running: HashMap<String, Arc<AtomicBool>>,
    // Cancellation may arrive before the async search command starts. Remember a
    // bounded number of those ids; late cancellation of finished searches is harmless.
    cancelled: VecDeque<String>,
}

#[derive(Default)]
pub struct SearchRegistry(Mutex<Registry>);

impl SearchRegistry {
    pub fn begin(&self, id: &str) -> Arc<AtomicBool> {
        let mut registry = self.0.lock().unwrap();
        let cancelled = registry.cancelled.iter().any(|c| c == id);
        registry.cancelled.retain(|c| c != id);
        let token = Arc::new(AtomicBool::new(cancelled));
        if let Some(previous) = registry.running.insert(id.to_owned(), token.clone()) {
            previous.store(true, Ordering::Relaxed);
        }
        token
    }

    pub fn cancel(&self, id: &str) {
        let mut registry = self.0.lock().unwrap();
        if let Some(token) = registry.running.get(id) {
            token.store(true, Ordering::Relaxed);
        } else if !registry.cancelled.iter().any(|c| c == id) {
            registry.cancelled.push_back(id.to_owned());
            while registry.cancelled.len() > 128 {
                registry.cancelled.pop_front();
            }
        }
    }

    pub fn finish(&self, id: &str, token: &Arc<AtomicBool>) {
        let mut registry = self.0.lock().unwrap();
        if registry
            .running
            .get(id)
            .is_some_and(|t| Arc::ptr_eq(t, token))
        {
            registry.running.remove(id);
        }
    }
}

/// Read a bounded text file. Symlinks and non-text content are not search inputs.
fn text(
    repo: &Repository,
    root: &Path,
    tree: Option<&Tree<'_>>,
    path: &str,
) -> AppResult<Option<String>> {
    let bytes = if let Some(tree) = tree {
        let entry = tree.get_path(Path::new(path))?;
        if entry.filemode() != 0o100644 && entry.filemode() != 0o100755 {
            return Ok(None);
        }
        let blob = repo.find_blob(entry.id())?;
        if blob.size() > MAX_FILE_BYTES {
            return Ok(None);
        }
        blob.content().to_vec()
    } else {
        let full = root.join(path);
        let metadata = std::fs::symlink_metadata(&full)?;
        if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES as u64 {
            return Ok(None);
        }
        let canonical = full.canonicalize()?;
        if !canonical.starts_with(root) {
            return Ok(None);
        }
        let mut bytes = Vec::new();
        std::fs::File::open(canonical)?
            .take(MAX_FILE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_FILE_BYTES {
            return Ok(None);
        }
        bytes
    };
    if bytes.contains(&0) {
        return Ok(None);
    }
    Ok(String::from_utf8(bytes).ok())
}

/// Literal, line-oriented search over the same snapshot and file set as the finder.
/// Results are path/line sorted; one hit carries every occurrence on that line.
pub fn search(request: SearchRequest, cancelled: &AtomicBool) -> AppResult<SearchResults> {
    let mut result = SearchResults::default();
    if request.query.is_empty() {
        return Ok(result);
    }
    if request.query.contains(['\r', '\n']) || request.query.len() > MAX_LINE_BYTES {
        return Err(AppError::Repo(
            "grep expects a single-line query of at most 16 KiB".into(),
        ));
    }
    if cancelled.load(Ordering::Relaxed) {
        result.cancelled = true;
        return Ok(result);
    }
    let repository = repo::open(Path::new(&request.repo))?;
    let root = repo::root(&repository)?;
    let tree = revision::tree(&repository, &request.source)?;
    let mut files = fuzzy::repo_files(&repository, &request.source)?;
    if let Some(only) = request.only {
        let allowed: std::collections::HashSet<_> = only.into_iter().collect();
        files.retain(|path| allowed.contains(path));
    }
    let matcher = RegexBuilder::new(&regex::escape(&request.query))
        .case_insensitive(!request.query.chars().any(char::is_uppercase))
        .build()
        .map_err(|e| AppError::Repo(format!("cannot search for this text: {e}")))?;
    'files: for path in files {
        if cancelled.load(Ordering::Relaxed) {
            result.cancelled = true;
            break;
        }
        let content = match text(&repository, &root, tree.as_ref(), &path) {
            Ok(Some(content)) => content,
            _ => {
                result.skipped_files += 1;
                continue;
            }
        };
        for (index, line) in content.lines().enumerate() {
            if cancelled.load(Ordering::Relaxed) {
                result.cancelled = true;
                break 'files;
            }
            if line.len() > MAX_LINE_BYTES {
                result.skipped_lines += 1;
                continue;
            }
            let mut matches = matcher.find_iter(line).peekable();
            if matches.peek().is_none() {
                continue;
            }
            if result.hits.len() == MAX_HITS {
                result.truncated = true;
                break 'files;
            }
            // Convert in one forward pass, avoiding quadratic prefix scans on lines
            // with many matches. The offsets crossing IPC are always UTF-16.
            let mut byte = 0;
            let mut offset = 0;
            let ranges: Vec<_> = matches
                .map(|m| {
                    offset += line[byte..m.start()].encode_utf16().count();
                    let from = offset;
                    offset += line[m.start()..m.end()].encode_utf16().count();
                    byte = m.end();
                    MatchRange { from, to: offset }
                })
                .collect();
            result.hits.push(SearchHit {
                path: path.clone(),
                line: index + 1,
                col: ranges[0].from,
                snippet: line.to_owned(),
                ranges,
            });
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
