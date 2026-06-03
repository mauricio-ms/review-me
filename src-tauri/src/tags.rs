use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::AppResult;

const TAGS_DIR: &str = ".ai-review";
const TAGS_FILE: &str = "tags.json";
const CONTEXT_LINES: usize = 3;
/// How far (in lines) to search around the original position when a tag's content
/// no longer hashes at its stored range (handles inserts/deletes above the region).
const SEARCH_WINDOW: i64 = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnchorKind {
    File,
    Hunk,
    Range,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    /// Repo-relative path.
    pub file: String,
    /// 1-based inclusive line range in the file's current content.
    pub start_line: u32,
    pub end_line: u32,
    /// sha256 of the captured lines (joined with `\n`).
    pub content_hash: String,
    #[serde(default)]
    pub context_before: Vec<String>,
    #[serde(default)]
    pub context_after: Vec<String>,
    pub kind: AnchorKind,
    /// Set during re-anchoring when the captured content can no longer be found.
    #[serde(default)]
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedTag {
    pub id: String,
    pub anchor: Anchor,
    pub created_at: u64,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlagTag {
    pub id: String,
    pub anchor: Anchor,
    pub created_at: u64,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub severity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagStore {
    pub version: u32,
    #[serde(default)]
    pub reviewed: Vec<ReviewedTag>,
    #[serde(default)]
    pub flags: Vec<FlagTag>,
}

impl Default for TagStore {
    fn default() -> Self {
        Self {
            version: 1,
            reviewed: Vec::new(),
            flags: Vec::new(),
        }
    }
}

/// Load the store and re-anchor every tag against the repo's current file contents.
pub fn load(root: &Path) -> AppResult<TagStore> {
    let mut store = read(root)?;
    for tag in &mut store.reviewed {
        reanchor(root, &mut tag.anchor);
    }
    for tag in &mut store.flags {
        reanchor(root, &mut tag.anchor);
    }
    Ok(store)
}

pub fn add_reviewed(
    root: &Path,
    file: &str,
    start_line: u32,
    end_line: u32,
    kind: AnchorKind,
) -> AppResult<TagStore> {
    let mut store = read(root)?;
    let anchor = build_anchor(root, file, start_line, end_line, kind);
    // Replace any existing reviewed tag with the same range (toggle-friendly).
    store
        .reviewed
        .retain(|t| !same_range(&t.anchor, file, start_line, end_line));
    store.reviewed.push(ReviewedTag {
        id: new_id("rev", file, start_line, end_line),
        anchor,
        created_at: now_millis(),
        note: None,
    });
    write(root, &store)?;
    load(root)
}

pub fn add_flag(
    root: &Path,
    file: &str,
    start_line: u32,
    end_line: u32,
    kind: AnchorKind,
    note: Option<String>,
    severity: Option<String>,
) -> AppResult<TagStore> {
    let mut store = read(root)?;
    let anchor = build_anchor(root, file, start_line, end_line, kind);
    store
        .flags
        .retain(|t| !same_range(&t.anchor, file, start_line, end_line));
    store.flags.push(FlagTag {
        id: new_id("flag", file, start_line, end_line),
        anchor,
        created_at: now_millis(),
        note,
        severity,
    });
    write(root, &store)?;
    load(root)
}

pub fn remove(root: &Path, id: &str) -> AppResult<TagStore> {
    let mut store = read(root)?;
    store.reviewed.retain(|t| t.id != id);
    store.flags.retain(|t| t.id != id);
    write(root, &store)?;
    load(root)
}

/// Drop every reviewed and flag tag, persisting an empty store. Clearing in place
/// preserves the store `version`.
pub fn clear_all(root: &Path) -> AppResult<TagStore> {
    let mut store = read(root)?;
    store.reviewed.clear();
    store.flags.clear();
    write(root, &store)?;
    load(root)
}

/// Remove every reviewed tag in `file` whose range overlaps `[start, end]`. This is
/// the `u` (unmark) action: unreviewing a hunk clears any reviewed tag covering it.
pub fn unreview_range(
    root: &Path,
    file: &str,
    start: u32,
    end: u32,
) -> AppResult<TagStore> {
    let mut store = read(root)?;
    store.reviewed.retain(|t| {
        !(t.anchor.file == file && t.anchor.start_line <= end && t.anchor.end_line >= start)
    });
    write(root, &store)?;
    load(root)
}

pub fn save(root: &Path, store: &TagStore) -> AppResult<()> {
    write(root, store)
}

fn same_range(anchor: &Anchor, file: &str, start: u32, end: u32) -> bool {
    anchor.file == file && anchor.start_line == start && anchor.end_line == end
}

fn tags_path(root: &Path) -> PathBuf {
    root.join(TAGS_DIR).join(TAGS_FILE)
}

fn read(root: &Path) -> AppResult<TagStore> {
    let path = tags_path(root);
    if !path.exists() {
        return Ok(TagStore::default());
    }
    let json = std::fs::read_to_string(&path)?;
    if json.trim().is_empty() {
        return Ok(TagStore::default());
    }
    Ok(serde_json::from_str(&json)?)
}

fn write(root: &Path, store: &TagStore) -> AppResult<()> {
    let path = tags_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(store)?)?;
    Ok(())
}

fn build_anchor(root: &Path, file: &str, start: u32, end: u32, kind: AnchorKind) -> Anchor {
    let lines = read_file_lines(root, file);
    let (hash, before, after) = match &lines {
        Some(lines) if start >= 1 && start <= end && (end as usize) <= lines.len() => {
            let s = (start - 1) as usize;
            let e = end as usize; // exclusive
            let hash = hash_lines(&lines[s..e]);
            let before = lines[s.saturating_sub(CONTEXT_LINES)..s].to_vec();
            let after_end = (e + CONTEXT_LINES).min(lines.len());
            let after = lines[e..after_end].to_vec();
            (hash, before, after)
        }
        _ => (String::new(), Vec::new(), Vec::new()),
    };
    Anchor {
        file: file.to_string(),
        start_line: start,
        end_line: end,
        content_hash: hash,
        context_before: before,
        context_after: after,
        kind,
        stale: false,
    }
}

fn reanchor(root: &Path, anchor: &mut Anchor) {
    // File-level / empty anchors carry no line hash to verify.
    if anchor.content_hash.is_empty() {
        anchor.stale = false;
        return;
    }
    let lines = match read_file_lines(root, &anchor.file) {
        Some(lines) => lines,
        None => {
            anchor.stale = true;
            return;
        }
    };
    let span = (anchor.end_line.saturating_sub(anchor.start_line) + 1) as usize;

    // Still at the recorded position?
    if let Some(hash) = window_hash(&lines, anchor.start_line as usize, span) {
        if hash == anchor.content_hash {
            anchor.stale = false;
            return;
        }
    }

    // Search a window around the original start for a block with the same hash,
    // preferring the closest match.
    let orig = anchor.start_line as i64;
    let max_start = lines.len() as i64 - span as i64 + 1;
    let lo = (orig - SEARCH_WINDOW).max(1);
    let hi = (orig + SEARCH_WINDOW).min(max_start);
    let mut best: Option<usize> = None;
    let mut best_dist = i64::MAX;
    let mut s = lo;
    while s <= hi {
        if let Some(hash) = window_hash(&lines, s as usize, span) {
            if hash == anchor.content_hash {
                let dist = (s - orig).abs();
                if dist < best_dist {
                    best_dist = dist;
                    best = Some(s as usize);
                }
            }
        }
        s += 1;
    }

    match best {
        Some(start) => {
            anchor.start_line = start as u32;
            anchor.end_line = (start + span - 1) as u32;
            anchor.stale = false;
        }
        None => anchor.stale = true,
    }
}

/// Hash the `span` lines starting at 1-based `start`, or `None` if out of range.
fn window_hash(lines: &[String], start: usize, span: usize) -> Option<String> {
    if start < 1 || span == 0 {
        return None;
    }
    let s = start - 1;
    let e = s + span;
    if e > lines.len() {
        return None;
    }
    Some(hash_lines(&lines[s..e]))
}

fn hash_lines(lines: &[String]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(lines.join("\n").as_bytes());
    format!("{:x}", hasher.finalize())
}

fn read_file_lines(root: &Path, file: &str) -> Option<Vec<String>> {
    let content = std::fs::read_to_string(root.join(file)).ok()?;
    Some(content.lines().map(str::to_string).collect())
}

fn new_id(prefix: &str, file: &str, start: u32, end: u32) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{prefix}:{file}:{start}-{end}@{nanos}")
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_lines(path: &Path, lines: &[&str]) {
        fs::write(path, format!("{}\n", lines.join("\n"))).unwrap();
    }

    #[test]
    fn exact_match_keeps_anchor() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_lines(&root.join("a.txt"), &["one", "two", "three", "four", "five"]);

        let store = add_reviewed(root, "a.txt", 2, 3, AnchorKind::Hunk).unwrap();
        assert_eq!(store.reviewed.len(), 1);
        let anchor = &store.reviewed[0].anchor;
        assert!(!anchor.stale);
        assert_eq!((anchor.start_line, anchor.end_line), (2, 3));
    }

    #[test]
    fn reanchors_after_lines_inserted_above() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_lines(&root.join("a.txt"), &["one", "two", "three", "four", "five"]);
        add_reviewed(root, "a.txt", 2, 3, AnchorKind::Hunk).unwrap();

        // Insert two lines at the top; the captured block "two\nthree" moves to 4..5.
        write_lines(
            &root.join("a.txt"),
            &["x", "y", "one", "two", "three", "four", "five"],
        );
        let store = load(root).unwrap();
        let anchor = &store.reviewed[0].anchor;
        assert!(!anchor.stale, "should re-find the moved block");
        assert_eq!((anchor.start_line, anchor.end_line), (4, 5));
    }

    #[test]
    fn marks_stale_when_content_gone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_lines(&root.join("a.txt"), &["one", "two", "three", "four", "five"]);
        add_reviewed(root, "a.txt", 2, 3, AnchorKind::Hunk).unwrap();

        write_lines(&root.join("a.txt"), &["completely", "different", "file"]);
        let store = load(root).unwrap();
        assert!(store.reviewed[0].anchor.stale, "should be stale");
    }

    #[test]
    fn remove_deletes_tag() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_lines(&root.join("a.txt"), &["one", "two", "three"]);
        let store = add_flag(root, "a.txt", 1, 2, AnchorKind::Range, None, None).unwrap();
        let id = store.flags[0].id.clone();
        let after = remove(root, &id).unwrap();
        assert!(after.flags.is_empty());
    }

    #[test]
    fn clear_all_removes_everything() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_lines(&root.join("a.txt"), &["one", "two", "three", "four", "five"]);
        add_reviewed(root, "a.txt", 2, 3, AnchorKind::Hunk).unwrap();
        add_flag(root, "a.txt", 1, 1, AnchorKind::Range, None, None).unwrap();

        let after = clear_all(root).unwrap();
        assert!(after.reviewed.is_empty());
        assert!(after.flags.is_empty());
        // Reloading confirms the empty state was persisted.
        let reloaded = load(root).unwrap();
        assert!(reloaded.reviewed.is_empty() && reloaded.flags.is_empty());
    }
}
