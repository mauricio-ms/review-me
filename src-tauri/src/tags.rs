use std::path::{Path, PathBuf};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{ObjectType, Oid, Repository};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::AppResult;
use crate::repo;

const TAGS_DIR: &str = ".review-me";
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

/// Which side of the diff an anchor's content lives on. `New` (the default) anchors
/// to the working-tree file; `Old` anchors to HEAD content (pure-deletion hunks and
/// deleted text files); `File` anchors a whole binary-file change by blob identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnchorSide {
    New,
    Old,
    File,
}

impl Default for AnchorSide {
    fn default() -> Self {
        AnchorSide::New
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    /// Repo-relative path.
    pub file: String,
    /// 1-based inclusive line range. New-side anchors index the working-tree file;
    /// old-side anchors index HEAD content; file anchors ignore these (0,0).
    pub start_line: u32,
    pub end_line: u32,
    /// sha256 of the captured lines (joined with `\n`), or `old:new` blob oids for a
    /// file anchor.
    pub content_hash: String,
    #[serde(default)]
    pub context_before: Vec<String>,
    #[serde(default)]
    pub context_after: Vec<String>,
    pub kind: AnchorKind,
    /// Which side of the diff the content lives on. Defaults to `New` for tags written
    /// before deletion/binary support existed.
    #[serde(default)]
    pub side: AnchorSide,
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

/// A hunk/file the reviewer has set aside ("don't need to look at this"). Like a
/// flag but with no severity — purely a marker that buckets it into the Ignore
/// section.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredTag {
    pub id: String,
    pub anchor: Anchor,
    pub created_at: u64,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagStore {
    pub version: u32,
    #[serde(default)]
    pub reviewed: Vec<ReviewedTag>,
    #[serde(default)]
    pub flags: Vec<FlagTag>,
    #[serde(default)]
    pub ignored: Vec<IgnoredTag>,
}

impl Default for TagStore {
    fn default() -> Self {
        Self {
            version: 1,
            reviewed: Vec::new(),
            flags: Vec::new(),
            ignored: Vec::new(),
        }
    }
}

/// Load the store and re-anchor every tag against the repo's current file contents.
/// Old-side and file anchors need git data (HEAD content / blob oids), so the repo is
/// opened once up front; new-side anchors only touch the working tree.
pub fn load(root: &Path) -> AppResult<TagStore> {
    let mut store = read(root)?;
    let git = repo::open(root).ok();
    for tag in &mut store.reviewed {
        reanchor(root, git.as_ref(), &mut tag.anchor);
    }
    for tag in &mut store.flags {
        reanchor(root, git.as_ref(), &mut tag.anchor);
    }
    for tag in &mut store.ignored {
        reanchor(root, git.as_ref(), &mut tag.anchor);
    }
    Ok(store)
}

pub fn add_reviewed(
    root: &Path,
    file: &str,
    start_line: u32,
    end_line: u32,
    kind: AnchorKind,
    side: AnchorSide,
) -> AppResult<TagStore> {
    let mut store = read(root)?;
    let git = repo::open(root).ok();
    let anchor = build_anchor(root, git.as_ref(), file, start_line, end_line, kind, side);
    // Replace any existing reviewed tag with the same range + side (toggle-friendly).
    store
        .reviewed
        .retain(|t| !same_range(&t.anchor, file, start_line, end_line, side));
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
    side: AnchorSide,
    note: Option<String>,
    severity: Option<String>,
) -> AppResult<TagStore> {
    let mut store = read(root)?;
    let git = repo::open(root).ok();
    let anchor = build_anchor(root, git.as_ref(), file, start_line, end_line, kind, side);
    store
        .flags
        .retain(|t| !same_range(&t.anchor, file, start_line, end_line, side));
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

pub fn add_ignored(
    root: &Path,
    file: &str,
    start_line: u32,
    end_line: u32,
    kind: AnchorKind,
    side: AnchorSide,
) -> AppResult<TagStore> {
    let mut store = read(root)?;
    let git = repo::open(root).ok();
    let anchor = build_anchor(root, git.as_ref(), file, start_line, end_line, kind, side);
    store
        .ignored
        .retain(|t| !same_range(&t.anchor, file, start_line, end_line, side));
    store.ignored.push(IgnoredTag {
        id: new_id("ign", file, start_line, end_line),
        anchor,
        created_at: now_millis(),
        note: None,
    });
    write(root, &store)?;
    load(root)
}

pub fn remove(root: &Path, id: &str) -> AppResult<TagStore> {
    let mut store = read(root)?;
    store.reviewed.retain(|t| t.id != id);
    store.flags.retain(|t| t.id != id);
    store.ignored.retain(|t| t.id != id);
    write(root, &store)?;
    load(root)
}

/// Remove only reviewed tags with ids in `ids`, preserving flag and ignore tags.
/// Used after committing reviewed content so unresolved flagged/ignored sections
/// keep their markers.
pub fn remove_reviewed_by_ids(root: &Path, ids: &[String]) -> AppResult<TagStore> {
    if ids.is_empty() {
        return load(root);
    }
    let ids: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let mut store = read(root)?;
    store.reviewed.retain(|t| !ids.contains(t.id.as_str()));
    write(root, &store)?;
    load(root)
}

/// Drop every reviewed, flag, and ignore tag, persisting an empty store. Clearing
/// in place preserves the store `version`.
pub fn clear_all(root: &Path) -> AppResult<TagStore> {
    let mut store = read(root)?;
    store.reviewed.clear();
    store.flags.clear();
    store.ignored.clear();
    write(root, &store)?;
    load(root)
}

/// Remove every same-side tag in `file` whose range overlaps `[start, end]`. This is
/// the `u` unmark action: it clears reviewed, flag, and ignore markers for the scope.
/// A `File`-side scope clears every file anchor on the path (line numbers are unused).
pub fn unmark_range(
    root: &Path,
    file: &str,
    start: u32,
    end: u32,
    side: AnchorSide,
) -> AppResult<TagStore> {
    let mut store = read(root)?;
    let overlaps = |anchor: &Anchor| {
        if anchor.file != file || anchor.side != side {
            return false;
        }
        match side {
            AnchorSide::File => true,
            _ => anchor.start_line <= end && anchor.end_line >= start,
        }
    };
    store.reviewed.retain(|t| !overlaps(&t.anchor));
    store.flags.retain(|t| !overlaps(&t.anchor));
    store.ignored.retain(|t| !overlaps(&t.anchor));
    write(root, &store)?;
    load(root)
}

pub fn save(root: &Path, store: &TagStore) -> AppResult<()> {
    write(root, store)
}

fn same_range(anchor: &Anchor, file: &str, start: u32, end: u32, side: AnchorSide) -> bool {
    anchor.side == side
        && anchor.file == file
        && anchor.start_line == start
        && anchor.end_line == end
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

fn build_anchor(
    root: &Path,
    git: Option<&Repository>,
    file: &str,
    start: u32,
    end: u32,
    kind: AnchorKind,
    side: AnchorSide,
) -> Anchor {
    let (hash, before, after) = match side {
        AnchorSide::New => match read_file_lines(root, file) {
            Some(lines) => capture(&lines, start, end),
            None => (String::new(), Vec::new(), Vec::new()),
        },
        AnchorSide::Old => match git.and_then(|repo| head_lines(repo, file)) {
            Some(lines) => capture(&lines, start, end),
            None => (String::new(), Vec::new(), Vec::new()),
        },
        // A binary file change is identified by its (old, new) blob oids, not by line
        // content. Line numbers are meaningless here.
        AnchorSide::File => {
            let hash = git
                .map(|repo| oid_pair(head_blob_oid(repo, file), working_blob_oid(root, file)))
                .unwrap_or_default();
            (hash, Vec::new(), Vec::new())
        }
    };
    Anchor {
        file: file.to_string(),
        start_line: start,
        end_line: end,
        content_hash: hash,
        context_before: before,
        context_after: after,
        kind,
        side,
        stale: false,
    }
}

/// Hash the `[start, end]` (1-based inclusive) slice of `lines` and grab its
/// surrounding context, or empties when the range is out of bounds.
fn capture(lines: &[String], start: u32, end: u32) -> (String, Vec<String>, Vec<String>) {
    if start >= 1 && start <= end && (end as usize) <= lines.len() {
        let s = (start - 1) as usize;
        let e = end as usize; // exclusive
        let before = lines[s.saturating_sub(CONTEXT_LINES)..s].to_vec();
        let after = lines[e..(e + CONTEXT_LINES).min(lines.len())].to_vec();
        (hash_lines(&lines[s..e]), before, after)
    } else {
        (String::new(), Vec::new(), Vec::new())
    }
}

fn reanchor(root: &Path, git: Option<&Repository>, anchor: &mut Anchor) {
    match anchor.side {
        AnchorSide::New => reanchor_lines(read_file_lines(root, &anchor.file), anchor),
        // Old-side content lives in HEAD; without git access (e.g. tests over a bare
        // tempdir) we can't verify it, so leave the stored position untouched.
        AnchorSide::Old => {
            if let Some(repo) = git {
                reanchor_lines(head_lines(repo, &anchor.file), anchor);
            }
        }
        AnchorSide::File => {
            if let Some(repo) = git {
                reanchor_file(root, repo, anchor);
            }
        }
    }
}

/// Re-anchor a line-range anchor against `lines` (working tree for new-side, HEAD for
/// old-side): exact hash at the stored position, else a ±`SEARCH_WINDOW` search.
fn reanchor_lines(lines: Option<Vec<String>>, anchor: &mut Anchor) {
    // Empty-hash anchors captured nothing to verify; treat them as live.
    if anchor.content_hash.is_empty() {
        anchor.stale = false;
        return;
    }
    let lines = match lines {
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

/// A file (binary) anchor is live while the path still carries the same (old, new)
/// blob change it was tagged against. Identical or both-missing oids mean the change
/// is gone.
fn reanchor_file(root: &Path, repo: &Repository, anchor: &mut Anchor) {
    let old = head_blob_oid(repo, &anchor.file);
    let new = working_blob_oid(root, &anchor.file);
    anchor.stale = match (old, new) {
        (None, None) => true,
        (a, b) if a == b => true,
        _ => oid_pair(old, new) != anchor.content_hash,
    };
}

/// HEAD's content for `file`, split into lines, or `None` when the path isn't in HEAD
/// (e.g. an added file) or isn't valid UTF-8.
fn head_lines(repo: &Repository, file: &str) -> Option<Vec<String>> {
    let tree = repo.head().ok()?.peel_to_commit().ok()?.tree().ok()?;
    let entry = tree.get_path(Path::new(file)).ok()?;
    let blob = entry.to_object(repo).ok()?.peel_to_blob().ok()?;
    let content = std::str::from_utf8(blob.content()).ok()?;
    Some(content.lines().map(str::to_string).collect())
}

/// Oid of HEAD's blob at `file`, or `None` when absent in HEAD.
fn head_blob_oid(repo: &Repository, file: &str) -> Option<Oid> {
    let tree = repo.head().ok()?.peel_to_commit().ok()?.tree().ok()?;
    tree.get_path(Path::new(file)).ok().map(|e| e.id())
}

/// Blob oid the working-tree file at `file` would hash to, or `None` when it's gone.
fn working_blob_oid(root: &Path, file: &str) -> Option<Oid> {
    let path = root.join(file);
    if !path.exists() {
        return None;
    }
    Oid::hash_file(ObjectType::Blob, &path).ok()
}

fn oid_pair(old: Option<Oid>, new: Option<Oid>) -> String {
    let part = |o: Option<Oid>| o.map(|o| o.to_string()).unwrap_or_else(|| "none".into());
    format!("{}:{}", part(old), part(new))
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

        let store = add_reviewed(root, "a.txt", 2, 3, AnchorKind::Hunk, AnchorSide::New).unwrap();
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
        add_reviewed(root, "a.txt", 2, 3, AnchorKind::Hunk, AnchorSide::New).unwrap();

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
        add_reviewed(root, "a.txt", 2, 3, AnchorKind::Hunk, AnchorSide::New).unwrap();

        write_lines(&root.join("a.txt"), &["completely", "different", "file"]);
        let store = load(root).unwrap();
        assert!(store.reviewed[0].anchor.stale, "should be stale");
    }

    #[test]
    fn remove_deletes_tag() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_lines(&root.join("a.txt"), &["one", "two", "three"]);
        let store = add_flag(root, "a.txt", 1, 2, AnchorKind::Range, AnchorSide::New, None, None).unwrap();
        let id = store.flags[0].id.clone();
        let after = remove(root, &id).unwrap();
        assert!(after.flags.is_empty());
    }

    #[test]
    fn clear_all_removes_everything() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_lines(&root.join("a.txt"), &["one", "two", "three", "four", "five"]);
        add_reviewed(root, "a.txt", 2, 3, AnchorKind::Hunk, AnchorSide::New).unwrap();
        add_flag(root, "a.txt", 1, 1, AnchorKind::Range, AnchorSide::New, None, None).unwrap();
        add_ignored(root, "a.txt", 4, 5, AnchorKind::Hunk, AnchorSide::New).unwrap();

        let after = clear_all(root).unwrap();
        assert!(after.reviewed.is_empty());
        assert!(after.flags.is_empty());
        assert!(after.ignored.is_empty());
        // Reloading confirms the empty state was persisted.
        let reloaded = load(root).unwrap();
        assert!(
            reloaded.reviewed.is_empty()
                && reloaded.flags.is_empty()
                && reloaded.ignored.is_empty()
        );
    }

    #[test]
    fn unmark_range_removes_all_overlapping_tag_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_lines(
            &root.join("a.txt"),
            &["one", "two", "three", "four", "five", "six", "seven"],
        );
        write_lines(&root.join("b.txt"), &["one", "two", "three"]);
        add_reviewed(root, "a.txt", 2, 3, AnchorKind::Hunk, AnchorSide::New).unwrap();
        add_flag(root, "a.txt", 3, 4, AnchorKind::Range, AnchorSide::New, None, None).unwrap();
        add_ignored(root, "a.txt", 1, 5, AnchorKind::Hunk, AnchorSide::New).unwrap();
        add_reviewed(root, "a.txt", 7, 7, AnchorKind::Range, AnchorSide::New).unwrap();
        add_flag(root, "b.txt", 1, 1, AnchorKind::Range, AnchorSide::New, None, None).unwrap();
        add_ignored(root, "b.txt", 2, 2, AnchorKind::Range, AnchorSide::New).unwrap();

        let after = unmark_range(root, "a.txt", 2, 4, AnchorSide::New).unwrap();
        assert_eq!(after.reviewed.len(), 1);
        assert_eq!(
            (
                after.reviewed[0].anchor.file.as_str(),
                after.reviewed[0].anchor.start_line,
            ),
            ("a.txt", 7),
        );
        assert_eq!(after.flags.len(), 1);
        assert_eq!(after.flags[0].anchor.file, "b.txt");
        assert_eq!(after.ignored.len(), 1);
        assert_eq!(after.ignored[0].anchor.file, "b.txt");

        let reloaded = load(root).unwrap();
        assert_eq!(reloaded.reviewed.len(), 1);
        assert_eq!(reloaded.flags.len(), 1);
        assert_eq!(reloaded.ignored.len(), 1);
    }

    #[test]
    fn add_ignored_then_remove() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_lines(&root.join("a.txt"), &["one", "two", "three", "four", "five"]);

        let store = add_ignored(root, "a.txt", 2, 3, AnchorKind::Hunk, AnchorSide::New).unwrap();
        assert_eq!(store.ignored.len(), 1);
        assert!(!store.ignored[0].anchor.stale);
        let id = store.ignored[0].id.clone();

        let after = remove(root, &id).unwrap();
        assert!(after.ignored.is_empty());
    }

    fn git(repo_dir: &Path, args: &[&str]) {
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

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-q", "-b", "master"]);
        git(dir, &["config", "user.name", "t"]);
        git(dir, &["config", "user.email", "t@t"]);
    }

    #[test]
    fn old_side_anchor_tracks_head_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        write_lines(
            &root.join("a.txt"),
            &["one", "two", "three", "four", "five", "six"],
        );
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "init"]);

        // Delete the "three"/"four" block (HEAD lines 3..4) in the working tree.
        write_lines(&root.join("a.txt"), &["one", "two", "five", "six"]);

        let store = add_reviewed(root, "a.txt", 3, 4, AnchorKind::Hunk, AnchorSide::Old).unwrap();
        let anchor = &store.reviewed[0].anchor;
        assert_eq!(anchor.side, AnchorSide::Old);
        assert!(!anchor.stale, "old-side block still present in HEAD");
        assert_eq!((anchor.start_line, anchor.end_line), (3, 4));

        // Reload re-anchors against HEAD, which is unchanged → still live at 3..4.
        let reloaded = load(root).unwrap();
        assert!(!reloaded.reviewed[0].anchor.stale);
        assert_eq!(
            (
                reloaded.reviewed[0].anchor.start_line,
                reloaded.reviewed[0].anchor.end_line,
            ),
            (3, 4),
        );
    }

    #[test]
    fn old_side_anchor_independent_of_new_side() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        write_lines(&root.join("a.txt"), &["a", "b", "c", "d"]);
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "init"]);
        write_lines(&root.join("a.txt"), &["a", "d"]);

        // Same numeric range, different sides → two distinct tags (no dedup collision).
        add_reviewed(root, "a.txt", 2, 2, AnchorKind::Range, AnchorSide::New).unwrap();
        let store = add_reviewed(root, "a.txt", 2, 2, AnchorKind::Range, AnchorSide::Old).unwrap();
        assert_eq!(store.reviewed.len(), 2);

        // Unmarking the old side leaves the new-side tag untouched.
        let after = unmark_range(root, "a.txt", 2, 2, AnchorSide::Old).unwrap();
        assert_eq!(after.reviewed.len(), 1);
        assert_eq!(after.reviewed[0].anchor.side, AnchorSide::New);
    }

    #[test]
    fn file_anchor_tracks_binary_change() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        fs::write(root.join("logo.bin"), [0u8, 159, 146, 150, 0, 1, 2]).unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "init"]);

        // Change the binary content in the working tree.
        fs::write(root.join("logo.bin"), [0u8, 1, 2, 3, 159, 146, 150]).unwrap();

        let store = add_reviewed(root, "logo.bin", 0, 0, AnchorKind::File, AnchorSide::File).unwrap();
        let anchor = &store.reviewed[0].anchor;
        assert_eq!(anchor.side, AnchorSide::File);
        assert!(!anchor.stale, "binary change present");
        assert!(anchor.content_hash.contains(':'));

        // Reverting the working file back to HEAD removes the change → stale.
        fs::write(root.join("logo.bin"), [0u8, 159, 146, 150, 0, 1, 2]).unwrap();
        let reloaded = load(root).unwrap();
        assert!(
            reloaded.reviewed[0].anchor.stale,
            "no change left → file anchor is stale"
        );
    }

    #[test]
    fn file_anchor_stale_when_path_deleted_and_restored() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        fs::write(root.join("logo.bin"), [0u8, 1, 2, 3]).unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "init"]);

        // Delete the binary file → review the deletion (old present, new gone).
        fs::remove_file(root.join("logo.bin")).unwrap();
        let store = add_reviewed(root, "logo.bin", 0, 0, AnchorKind::File, AnchorSide::File).unwrap();
        assert!(!store.reviewed[0].anchor.stale);
        assert!(store.reviewed[0].anchor.content_hash.ends_with(":none"));
    }
}
