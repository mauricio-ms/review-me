//! Review notes exported as Markdown, for an LLM (or a person) to act on later.
//!
//! The tag store is the source of truth: a note is a flag's `note`, made while reviewing
//! one commit. These files are a *projection* of it, regenerated whenever a mark in a
//! commit's scope changes and never read back:
//!
//! ```text
//! .review-me/notes/README.md            index of every commit with notes
//! .review-me/notes/commits/<oid>.md     one commit's notes, named by its full oid
//! .review-me/notes/branches/<name>.md   `:export` — a branch's notes, oldest first
//! ```
//!
//! Rendering is deterministic (dates come from the commit, never the clock), so
//! regenerating an unchanged review rewrites nothing.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use git2::{Repository, Sort, Tree};
use serde::Serialize;

use crate::branches;
use crate::commits;
use crate::coverage::has_note;
use crate::diff::{self, ChangeStatus, ChangedFile, DiffLine, DiffLineKind, DiffSpec};
use crate::error::AppResult;
use crate::repo;
use crate::review_dir;
use crate::tags::{self, AnchorSide, FlagTag, ReviewScope};

/// Bumped when the documents' structure changes, so a reader can tell formats apart.
const FORMAT_VERSION: u32 = 1;
const NOTES_DIR: &str = "notes";
/// Longest excerpt quoted under a note; the rest is counted, not shown.
const EXCERPT_MAX_LINES: usize = 60;

/// What `:export` wrote.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesExport {
    /// Repo-relative path of the bundle, or `None` when the branch has no notes.
    pub path: Option<String>,
    pub commits: u32,
    pub notes: u32,
}

/// Everything one commit's notes are rendered from, gathered up front so rendering is
/// pure string building.
#[derive(Debug)]
struct CommitNotes {
    oid: String,
    short_oid: String,
    parent: Option<String>,
    subject: String,
    message: String,
    author: String,
    timestamp: i64,
    /// Files in diff order, then files the commit didn't change (notes made from
    /// project mode) by path.
    files: Vec<FileNotes>,
}

impl CommitNotes {
    fn note_count(&self) -> usize {
        self.files.iter().map(|f| f.notes.len()).sum()
    }
}

#[derive(Debug)]
struct FileNotes {
    path: String,
    /// How this commit changed the file; `None` when it didn't.
    change: Option<FileChange>,
    notes: Vec<Note>,
}

#[derive(Debug)]
struct FileChange {
    status: ChangeStatus,
    old_path: Option<String>,
    binary: bool,
}

#[derive(Debug)]
struct Note {
    side: AnchorSide,
    lo: u32,
    hi: u32,
    body: String,
    excerpt: Option<Excerpt>,
}

/// The code a note is about, as it was in the commit.
#[derive(Debug)]
enum Excerpt {
    /// The commit's own diff lines over the note's range, hunk header first.
    Diff { lines: Vec<String>, omitted: usize },
    /// Plain lines from the commit's (or its parent's) tree, for notes on code the
    /// commit didn't touch.
    Code {
        lang: &'static str,
        lines: Vec<String>,
        omitted: usize,
    },
}

fn notes_dir(root: &Path) -> PathBuf {
    review_dir::path(root).join(NOTES_DIR)
}

fn commit_path(root: &Path, oid: &str) -> PathBuf {
    notes_dir(root).join("commits").join(format!("{oid}.md"))
}

/// Regenerate `oid`'s notes file — or remove it once the commit has no notes — and
/// the index. Called after any mark changes in that commit's scope.
pub fn sync_commit(root: &Path, oid: &str) -> AppResult<()> {
    let repo = repo::open(root)?;
    let path = commit_path(root, oid);
    match gather(&repo, root, oid)? {
        Some(notes) => write_if_changed(root, &path, &render_commit(&notes))?,
        None => remove_if_exists(&path)?,
    }
    sync_index(&repo, root)
}

/// `:export`: every note on commits reachable from `ref_name`, oldest commit first, in
/// one file to hand an LLM. Also regenerates each of those commits' own files and the
/// index, so the folder is whole again even if something was deleted by hand.
pub fn export(repo: &Repository, root: &Path, ref_name: &str) -> AppResult<NotesExport> {
    let tip = commits::resolve(repo, ref_name)?;
    let name = if ref_name == "HEAD" {
        "HEAD".to_string()
    } else {
        branches::shorthand(ref_name).to_string()
    };
    let bundle = notes_dir(root).join("branches").join(format!("{name}.md"));

    let noted = noted_commits(root)?;
    let mut gathered = Vec::new();
    if !noted.is_empty() {
        let mut walk = repo.revwalk()?;
        walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME | Sort::REVERSE)?;
        walk.push(tip.oid)?;
        for oid in walk {
            let oid = oid?.to_string();
            if !noted.contains(&oid) {
                continue;
            }
            if let Some(notes) = gather(repo, root, &oid)? {
                write_if_changed(root, &commit_path(root, &oid), &render_commit(&notes))?;
                gathered.push(notes);
            }
        }
    }
    sync_index(repo, root)?;

    let notes = gathered.iter().map(CommitNotes::note_count).sum::<usize>() as u32;
    if gathered.is_empty() {
        // A bundle exists exactly when there is something in it.
        remove_if_exists(&bundle)?;
        return Ok(NotesExport {
            path: None,
            commits: 0,
            notes: 0,
        });
    }
    write_if_changed(
        root,
        &bundle,
        &render_bundle(&name, &tip.oid.to_string(), &gathered),
    )?;
    Ok(NotesExport {
        path: Some(
            bundle
                .strip_prefix(root)
                .unwrap_or(&bundle)
                .to_string_lossy()
                .into_owned(),
        ),
        commits: gathered.len() as u32,
        notes,
    })
}

/// Commits with at least one note, by full oid.
fn noted_commits(root: &Path) -> AppResult<HashSet<String>> {
    let mut out = HashSet::new();
    for scope in tags::marked_scopes(root)? {
        if let ReviewScope::Commit { oid } = &scope {
            let store = tags::load(root, &scope)?;
            if store.flags.iter().any(|f| has_note(f.note.as_deref())) {
                out.insert(oid.clone());
            }
        }
    }
    Ok(out)
}

/// Rewrite `notes/README.md`, the index of commits with notes (removed when none).
fn sync_index(repo: &Repository, root: &Path) -> AppResult<()> {
    let path = notes_dir(root).join("README.md");
    let mut entries = Vec::new();
    for oid in noted_commits(root)? {
        // A commit gone from the object database can't be described; skip it.
        let Ok(resolved) = commits::resolve(repo, &oid) else {
            continue;
        };
        let store = tags::load(root, &ReviewScope::Commit { oid: oid.clone() })?;
        let count = store
            .flags
            .iter()
            .filter(|f| has_note(f.note.as_deref()))
            .count();
        entries.push(IndexEntry {
            oid,
            short_oid: resolved.info.short_oid,
            subject: resolved.info.summary,
            timestamp: resolved.info.timestamp,
            notes: count,
        });
    }
    if entries.is_empty() {
        return remove_if_exists(&path);
    }
    entries.sort_by(|a, b| (a.timestamp, &a.oid).cmp(&(b.timestamp, &b.oid)));
    write_if_changed(root, &path, &render_index(&entries))
}

struct IndexEntry {
    oid: String,
    short_oid: String,
    subject: String,
    timestamp: i64,
    notes: usize,
}

/// Collect `oid`'s notes, or `None` when it has none.
fn gather(repo: &Repository, root: &Path, oid: &str) -> AppResult<Option<CommitNotes>> {
    let store = tags::load(root, &ReviewScope::Commit { oid: oid.to_string() })?;
    let mut flags: Vec<FlagTag> = store
        .flags
        .into_iter()
        .filter(|f| has_note(f.note.as_deref()))
        .collect();
    if flags.is_empty() {
        return Ok(None);
    }
    let resolved = commits::resolve(repo, oid)?;
    let spec = DiffSpec::Commit {
        oid: oid.to_string(),
        branch_ref: None,
    };
    let changed = diff::compute(repo, &spec)?.files;
    let new_tree = repo.find_commit(resolved.oid)?.tree()?;
    let old_tree = match resolved.parent_oid {
        Some(parent) => Some(repo.find_commit(parent)?.tree()?),
        None => None,
    };

    // Diff order for changed files, then the rest by path; notes by side and line.
    let position: HashMap<&str, usize> = changed
        .iter()
        .enumerate()
        .map(|(i, f)| (f.path.as_str(), i))
        .collect();
    flags.sort_by(|a, b| {
        let key = |f: &FlagTag| {
            (
                position.get(f.anchor.file.as_str()).copied().unwrap_or(usize::MAX),
                f.anchor.file.clone(),
                f.anchor.side != AnchorSide::New,
                f.anchor.start_line,
                f.anchor.end_line,
            )
        };
        key(a).cmp(&key(b))
    });

    let mut files: Vec<FileNotes> = Vec::new();
    for flag in flags {
        let anchor = &flag.anchor;
        let file = changed.iter().find(|f| f.path == anchor.file);
        let excerpt = match anchor.side {
            AnchorSide::File => None,
            side => file
                .and_then(|f| diff_excerpt(f, side, anchor.start_line, anchor.end_line))
                .or_else(|| {
                    let tree = if side == AnchorSide::New {
                        Some(&new_tree)
                    } else {
                        old_tree.as_ref()
                    };
                    tree.and_then(|tree| {
                        code_excerpt(repo, tree, &anchor.file, anchor.start_line, anchor.end_line)
                    })
                }),
        };
        let note = Note {
            side: anchor.side,
            lo: anchor.start_line,
            hi: anchor.end_line,
            body: flag.note.clone().unwrap_or_default().trim().to_string(),
            excerpt,
        };
        match files.last_mut() {
            Some(last) if last.path == anchor.file => last.notes.push(note),
            _ => files.push(FileNotes {
                path: anchor.file.clone(),
                change: file.map(|f| FileChange {
                    status: f.status,
                    old_path: f.old_path.clone(),
                    binary: f.binary,
                }),
                notes: vec![note],
            }),
        }
    }

    let info = resolved.info;
    Ok(Some(CommitNotes {
        oid: info.oid,
        short_oid: info.short_oid,
        parent: resolved.parent_oid.map(|p| p.to_string()),
        subject: info.summary,
        message: resolved.message,
        author: info.author_name,
        timestamp: info.timestamp,
        files,
    }))
}

/// The commit's diff lines over `[lo, hi]` on `side`, from each hunk that touches it.
/// A new-side range also takes the removed lines just before it (what it replaced); an
/// old-side range, the added lines just after (what replaced it).
fn diff_excerpt(file: &ChangedFile, side: AnchorSide, lo: u32, hi: u32) -> Option<Excerpt> {
    let in_range = |line: &DiffLine| {
        let n = if side == AnchorSide::New {
            line.new_line
        } else {
            line.old_line
        };
        n.is_some_and(|n| lo <= n && n <= hi)
    };
    let mut lines = Vec::new();
    for hunk in &file.hunks {
        let hits: Vec<usize> = (0..hunk.lines.len())
            .filter(|&i| in_range(&hunk.lines[i]))
            .collect();
        let (Some(&first), Some(&last)) = (hits.first(), hits.last()) else {
            continue;
        };
        let (mut first, mut last) = (first, last);
        if side == AnchorSide::New {
            while first > 0 && matches!(hunk.lines[first - 1].kind, DiffLineKind::Removed) {
                first -= 1;
            }
        } else {
            while last + 1 < hunk.lines.len()
                && matches!(hunk.lines[last + 1].kind, DiffLineKind::Added)
            {
                last += 1;
            }
        }
        lines.push(hunk.header.clone());
        for line in &hunk.lines[first..=last] {
            let sign = match line.kind {
                DiffLineKind::Added => '+',
                DiffLineKind::Removed => '-',
                DiffLineKind::Context => ' ',
            };
            lines.push(format!("{sign}{}", line.content));
        }
    }
    if lines.is_empty() {
        return None;
    }
    let (lines, omitted) = cap(lines);
    Some(Excerpt::Diff { lines, omitted })
}

/// Lines `[lo, hi]` of `path` in `tree`, for a note on code the commit didn't change.
fn code_excerpt(repo: &Repository, tree: &Tree, path: &str, lo: u32, hi: u32) -> Option<Excerpt> {
    let entry = tree.get_path(Path::new(path)).ok()?;
    let blob = entry.to_object(repo).ok()?.peel_to_blob().ok()?;
    let content = std::str::from_utf8(blob.content()).ok()?;
    let lines: Vec<String> = content
        .lines()
        .skip(lo.saturating_sub(1) as usize)
        .take((hi.saturating_sub(lo) + 1) as usize)
        .map(str::to_string)
        .collect();
    if lines.is_empty() {
        return None;
    }
    let (lines, omitted) = cap(lines);
    Some(Excerpt::Code {
        lang: fence_lang(path),
        lines,
        omitted,
    })
}

fn cap(mut lines: Vec<String>) -> (Vec<String>, usize) {
    let omitted = lines.len().saturating_sub(EXCERPT_MAX_LINES);
    lines.truncate(EXCERPT_MAX_LINES);
    (lines, omitted)
}

// ---------- rendering ----------

/// One commit's notes as a standalone document: front matter, then the notes.
fn render_commit(c: &CommitNotes) -> String {
    let mut md = String::new();
    md.push_str("---\n");
    let _ = writeln!(md, "review-me: {FORMAT_VERSION}");
    let _ = writeln!(md, "commit: {}", c.oid);
    let _ = writeln!(md, "parent: {}", c.parent.as_deref().unwrap_or("null"));
    let _ = writeln!(md, "subject: {}", yaml_string(&c.subject));
    let _ = writeln!(md, "author: {}", yaml_string(&c.author));
    let _ = writeln!(md, "date: {}", iso8601_utc(c.timestamp));
    let _ = writeln!(md, "notes: {}", c.note_count());
    md.push_str("---\n\n");
    let _ = writeln!(md, "# {} {}\n", c.short_oid, c.subject);
    let range = match &c.parent {
        Some(parent) => format!("diffed against its first parent `{}`", short(parent)),
        None => "a root commit, so everything in it is new".to_string(),
    };
    let _ = writeln!(
        md,
        "{}",
        blockquote(&format!(
            "Review notes on commit `{}`, {range}. Each note is a fix to make. Line numbers \
             are the commit's own (a *removed* range, its parent's); the code may have moved \
             since, so find it by the excerpt rather than by the numbers. See the commit \
             with `git show {}`. Generated by review-me — edit notes in the app.",
            c.short_oid, c.oid
        ))
    );
    render_body(&mut md, c, 2);
    md
}

/// A branch's notes in one document, commit by commit, oldest first.
fn render_bundle(branch: &str, tip: &str, commits: &[CommitNotes]) -> String {
    let notes: usize = commits.iter().map(CommitNotes::note_count).sum();
    let mut md = String::new();
    md.push_str("---\n");
    let _ = writeln!(md, "review-me: {FORMAT_VERSION}");
    let _ = writeln!(md, "branch: {}", yaml_string(branch));
    let _ = writeln!(md, "tip: {tip}");
    let _ = writeln!(md, "commits: {}", commits.len());
    let _ = writeln!(md, "notes: {notes}");
    md.push_str("---\n\n");
    let _ = writeln!(md, "# Review notes for `{branch}`\n");
    let _ = writeln!(
        md,
        "{}",
        blockquote(
            "Fixes to make, commit by commit, oldest first. Each note points at code as it \
             was in its commit (a *removed* range, as it was in that commit's parent); the \
             code may have moved since, so find it by the excerpt rather than by the line \
             numbers. Generated by review-me — edit notes in the app."
        )
    );
    for c in commits {
        let _ = writeln!(md, "## {} {}\n", c.short_oid, c.subject);
        let parent = match &c.parent {
            Some(parent) => format!("first parent `{parent}`"),
            None => "root commit".to_string(),
        };
        let _ = writeln!(md, "- **Commit:** `{}` ({parent})", c.oid);
        let _ = writeln!(md, "- **Author:** {}, {}\n", c.author, iso8601_utc(c.timestamp));
        render_body(&mut md, c, 3);
    }
    md
}

/// The commit message, then each file's notes. `level` is the heading level of the
/// sections; notes sit one below, and headings inside a note one below that.
fn render_body(md: &mut String, c: &CommitNotes, level: usize) {
    let h = |n: usize| "#".repeat(n.min(6));
    let message = c.message.trim_end();
    let fence = fence_for(message.lines());
    let _ = writeln!(md, "{} Commit message\n", h(level));
    let _ = writeln!(md, "{fence}text\n{message}\n{fence}\n");
    for file in &c.files {
        let _ = writeln!(md, "{} `{}`\n", h(level), file.path);
        let _ = writeln!(md, "{}\n", describe_change(file.change.as_ref()));
        for note in &file.notes {
            let _ = writeln!(md, "{} {}\n", h(level + 1), note_title(note));
            let _ = writeln!(md, "{}\n", demote_headings(&note.body, level + 1));
            match &note.excerpt {
                Some(Excerpt::Diff { lines, omitted }) => {
                    render_block(md, "diff", lines, *omitted);
                }
                Some(Excerpt::Code {
                    lang,
                    lines,
                    omitted,
                }) => render_block(md, lang, lines, *omitted),
                None => {}
            }
        }
    }
}

fn render_block(md: &mut String, lang: &str, lines: &[String], omitted: usize) {
    let fence = fence_for(lines.iter().map(String::as_str));
    let _ = writeln!(md, "{fence}{lang}");
    for line in lines {
        let _ = writeln!(md, "{line}");
    }
    let _ = writeln!(md, "{fence}\n");
    if omitted > 0 {
        let _ = writeln!(md, "*…and {omitted} more lines.*\n");
    }
}

fn render_index(entries: &[IndexEntry]) -> String {
    let mut md = String::from("# Review notes\n\n");
    md.push_str(&blockquote(
        "Fixes left for later while reviewing commits, one file per commit under \
         `commits/`, named by its full oid. Generated by review-me from its tag store — \
         edit notes in the app.",
    ));
    md.push('\n');
    md.push_str("| Commit | Date | Notes | Subject |\n| --- | --- | --- | --- |\n");
    for e in entries {
        let date = &iso8601_utc(e.timestamp)[..10];
        let subject = e.subject.replace('|', "\\|");
        let _ = writeln!(
            md,
            "| [`{}`](commits/{}.md) | {date} | {} | {subject} |",
            e.short_oid, e.oid, e.notes
        );
    }
    md
}

fn note_title(note: &Note) -> String {
    if note.side == AnchorSide::File {
        return "Whole file".to_string();
    }
    let lines = if note.lo == note.hi {
        format!("Line {}", note.lo)
    } else {
        format!("Lines {}–{}", note.lo, note.hi)
    };
    if note.side == AnchorSide::Old {
        format!("{lines} (removed)")
    } else {
        lines
    }
}

fn describe_change(change: Option<&FileChange>) -> String {
    let Some(change) = change else {
        return "*Not changed by this commit.*".to_string();
    };
    let what = match change.status {
        ChangeStatus::Added => "Added".to_string(),
        ChangeStatus::Modified => "Modified".to_string(),
        ChangeStatus::Deleted => "Deleted".to_string(),
        ChangeStatus::Renamed => match &change.old_path {
            Some(old) => format!("Renamed from `{old}`"),
            None => "Renamed".to_string(),
        },
    };
    let binary = if change.binary { ", binary" } else { "" };
    format!("*{what} by this commit{binary}.*")
}

/// Push every Markdown heading in `text` down by `by` levels (capped at h6), leaving
/// fenced code alone — a note's own `# Heading` must not outrank the note.
fn demote_headings(text: &str, by: usize) -> String {
    let mut fence: Option<String> = None;
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        let marker: String = trimmed
            .chars()
            .take_while(|&c| c == '`' || c == '~')
            .collect();
        if marker.len() >= 3 && marker.chars().all(|c| c == marker.chars().next().unwrap()) {
            match &fence {
                None => fence = Some(marker),
                Some(open) if marker.starts_with(open.as_str()) => fence = None,
                Some(_) => {}
            }
            out.push(line.to_string());
            continue;
        }
        let hashes = line.chars().take_while(|&c| c == '#').count();
        let is_heading = fence.is_none()
            && (1..=6).contains(&hashes)
            && line[hashes..].chars().next().map_or(true, char::is_whitespace);
        if is_heading {
            out.push(format!("{}{}", "#".repeat((hashes + by).min(6)), &line[hashes..]));
        } else {
            out.push(line.to_string());
        }
    }
    out.join("\n")
}

/// `text` as a Markdown blockquote, word-wrapped so the raw file reads as well as the
/// rendered one.
fn blockquote(text: &str) -> String {
    const WIDTH: usize = 80;
    let mut out = String::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        if !line.is_empty() && line.chars().count() + 1 + word.chars().count() > WIDTH - 2 {
            let _ = writeln!(out, "> {line}");
            line.clear();
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(word);
    }
    if !line.is_empty() {
        let _ = writeln!(out, "> {line}");
    }
    out
}

/// A backtick fence longer than any run of backticks in the content.
fn fence_for<'a>(lines: impl Iterator<Item = &'a str>) -> String {
    let mut longest = 0;
    for line in lines {
        let mut run = 0;
        for c in line.chars() {
            run = if c == '`' { run + 1 } else { 0 };
            longest = longest.max(run);
        }
    }
    "`".repeat((longest + 1).max(3))
}

fn fence_lang(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    match ext {
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "rs" => "rust",
        "ts" => "ts",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" => "js",
        "jsx" => "jsx",
        "py" => "python",
        "go" => "go",
        "rb" => "ruby",
        "c" | "h" => "c",
        "cc" | "cpp" | "hpp" => "cpp",
        "cs" => "csharp",
        "sh" | "bash" => "sh",
        "sql" => "sql",
        "md" => "markdown",
        "json" => "json",
        "yml" | "yaml" => "yaml",
        "toml" => "toml",
        "xml" => "xml",
        "html" => "html",
        "css" => "css",
        _ => "",
    }
}

/// A YAML scalar for arbitrary text: JSON string syntax is valid double-quoted YAML.
fn yaml_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())
}

fn short(oid: &str) -> &str {
    &oid[..oid.len().min(7)]
}

/// `seconds` since the epoch as an ISO-8601 UTC timestamp (civil-from-days, so no
/// date-time dependency is needed for one format).
fn iso8601_utc(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let secs = seconds.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        secs / 3_600,
        secs % 3_600 / 60,
        secs % 60
    )
}

fn write_if_changed(root: &Path, path: &Path, content: &str) -> AppResult<()> {
    review_dir::ensure(root)?;
    if fs::read_to_string(path).ok().as_deref() == Some(content) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    Ok(())
}

fn remove_if_exists(path: &Path) -> AppResult<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tags::AnchorKind;

    fn git(dir: &Path, minute: u32, args: &[&str]) {
        let date = format!("2026-03-01T09:{minute:02}:00+00:00");
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "Ada")
            .env("GIT_AUTHOR_EMAIL", "ada@t")
            .env("GIT_COMMITTER_NAME", "Ada")
            .env("GIT_COMMITTER_EMAIL", "ada@t")
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .output()
            .expect("git");
        assert!(out.status.success(), "git {args:?} failed");
    }

    fn head(root: &Path) -> String {
        let repo = Repository::open(root).unwrap();
        let oid = repo.head().unwrap().peel_to_commit().unwrap().id().to_string();
        oid
    }

    fn flag(root: &Path, oid: &str, file: &str, lo: u32, hi: u32, side: AnchorSide, note: &str) {
        let scope = ReviewScope::Commit { oid: oid.to_string() };
        let kind = if side == AnchorSide::File {
            AnchorKind::File
        } else {
            AnchorKind::Range
        };
        tags::add_flag(root, &scope, file, lo, hi, kind, side, Some(note.into()), None).unwrap();
    }

    /// `master`: a base commit, then "Add withdrawals" which grows `Account.java`,
    /// trims `notes.txt` (lines 2-3 removed) and changes a binary logo.
    fn fixture(root: &Path) -> (String, String) {
        git(root, 0, &["init", "-q", "-b", "master"]);
        fs::write(
            root.join("Account.java"),
            "class Account {\n    long balance;\n}\n",
        )
        .unwrap();
        fs::write(root.join("notes.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        fs::write(root.join("logo.bin"), b"\0old").unwrap();
        fs::write(root.join("Untouched.java"), "class Untouched {\n    int x;\n}\n").unwrap();
        git(root, 1, &["add", "."]);
        git(root, 1, &["commit", "-qm", "Add an account"]);
        let base = head(root);

        fs::write(
            root.join("Account.java"),
            "class Account {\n    long balance;\n\n    void withdraw(long amount) {\n        balance -= amount;\n    }\n}\n",
        )
        .unwrap();
        fs::write(root.join("notes.txt"), "one\nfour\n").unwrap();
        fs::write(root.join("logo.bin"), b"\0new").unwrap();
        git(root, 2, &["commit", "-qam", "Add withdrawals\n\nNo overdraft checks yet."]);
        (base, head(root))
    }

    fn read(path: PathBuf) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn renders_a_commit_document_with_excerpts_for_every_kind_of_note() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let (base, oid) = fixture(root);
        flag(root, &oid, "Account.java", 4, 6, AnchorSide::New, "Reject `amount > balance`.\n\n# Why\nOverdrafts.");
        flag(root, &oid, "notes.txt", 2, 3, AnchorSide::Old, "Keep `two`.");
        flag(root, &oid, "logo.bin", 0, 0, AnchorSide::File, "Use the SVG.");
        flag(root, &oid, "Untouched.java", 2, 2, AnchorSide::New, "Rename `x`.");
        sync_commit(root, &oid).unwrap();

        let md = read(commit_path(root, &oid));
        assert!(md.starts_with("---\nreview-me: 1\n"), "{md}");
        assert!(md.contains(&format!("commit: {oid}\n")));
        assert!(md.contains(&format!("parent: {base}\n")));
        assert!(md.contains("subject: \"Add withdrawals\"\n"));
        assert!(md.contains("date: 2026-03-01T09:02:00Z\n"));
        assert!(md.contains("notes: 4\n"));
        assert!(md.contains(&format!("# {} Add withdrawals\n", &oid[..7])));
        assert!(md.contains("```text\nAdd withdrawals\n\nNo overdraft checks yet.\n```"));

        // Files in diff order; the untouched file last, said to be untouched.
        let account = md.find("## `Account.java`").unwrap();
        let notes_txt = md.find("## `notes.txt`").unwrap();
        let untouched = md.find("## `Untouched.java`").unwrap();
        assert!(account < notes_txt && notes_txt < untouched);
        assert!(md.contains("*Not changed by this commit.*"));

        // New side: the note, its own heading demoted below the note's, the diff.
        assert!(md.contains("### Lines 4–6\n\nReject `amount > balance`.\n\n#### Why\nOverdrafts."));
        assert!(md.contains("```diff\n@@"));
        assert!(md.contains("+    void withdraw(long amount) {\n+        balance -= amount;\n+    }\n```"));
        // Old side: the removed lines.
        assert!(md.contains("### Lines 2–3 (removed)\n\nKeep `two`.\n\n```diff\n@@"));
        assert!(md.contains("-two\n-three\n```"));
        // Binary: no excerpt.
        assert!(md.contains("### Whole file\n\nUse the SVG.\n\n"));
        assert!(md.contains("*Modified by this commit, binary.*"));
        // Outside the diff: plain code from the commit's tree.
        assert!(md.contains("### Line 2\n\nRename `x`.\n\n```java\n    int x;\n```"));

        // The index lists it.
        let index = read(notes_dir(root).join("README.md"));
        assert!(index.contains(&format!(
            "| [`{}`](commits/{oid}.md) | 2026-03-01 | 4 | Add withdrawals |",
            &oid[..7]
        )));
    }

    #[test]
    fn regenerating_is_stable_and_the_last_note_removes_the_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let (_, oid) = fixture(root);
        flag(root, &oid, "Account.java", 4, 4, AnchorSide::New, "Validate.");
        sync_commit(root, &oid).unwrap();
        let first = read(commit_path(root, &oid));
        sync_commit(root, &oid).unwrap();
        assert_eq!(read(commit_path(root, &oid)), first, "same review, same bytes");

        // Clearing the note (the flag stays) leaves nothing to export.
        let scope = ReviewScope::Commit { oid: oid.clone() };
        let id = tags::load(root, &scope).unwrap().flags[0].id.clone();
        tags::set_flag_note(root, &scope, &id, None).unwrap();
        sync_commit(root, &oid).unwrap();
        assert!(!commit_path(root, &oid).exists());
        assert!(!notes_dir(root).join("README.md").exists());
    }

    #[test]
    fn a_root_commit_has_no_parent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, 0, &["init", "-q", "-b", "master"]);
        fs::write(root.join("a.txt"), "first\n").unwrap();
        git(root, 1, &["add", "."]);
        git(root, 1, &["commit", "-qm", "Start"]);
        let oid = head(root);
        flag(root, &oid, "a.txt", 1, 1, AnchorSide::New, "Say more.");
        sync_commit(root, &oid).unwrap();

        let md = read(commit_path(root, &oid));
        assert!(md.contains("parent: null\n"));
        assert!(md.replace("\n> ", " ").contains("a root commit, so everything in it is new"));
        assert!(md.contains("```diff\n@@ -0,0 +1 @@\n+first\n```"));
    }

    #[test]
    fn export_bundles_a_branchs_notes_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let (base, withdrawals) = fixture(root);
        git(root, 3, &["checkout", "-qb", "feature/docs"]);
        fs::write(root.join("README.md"), "# Accounts\n").unwrap();
        git(root, 3, &["add", "."]);
        git(root, 3, &["commit", "-qm", "docs: describe accounts"]);
        let docs = head(root);
        // A note on a commit the branch can't reach stays out of its bundle.
        git(root, 4, &["checkout", "-q", "master"]);
        fs::write(root.join("other.txt"), "x\n").unwrap();
        git(root, 4, &["add", "."]);
        git(root, 4, &["commit", "-qm", "unrelated"]);
        let unrelated = head(root);

        flag(root, &docs, "README.md", 1, 1, AnchorSide::New, "Add usage.");
        flag(root, &base, "Account.java", 2, 2, AnchorSide::New, "Use a BigDecimal.");
        flag(root, &unrelated, "other.txt", 1, 1, AnchorSide::New, "Drop this.");
        // An ordinary flag without a note exports nothing.
        tags::add_flag(
            root,
            &ReviewScope::Commit { oid: withdrawals.clone() },
            "Account.java",
            4,
            4,
            AnchorKind::Range,
            AnchorSide::New,
            None,
            None,
        )
        .unwrap();

        let repo = Repository::open(root).unwrap();
        let export = export(&repo, root, "refs/heads/feature/docs").unwrap();
        assert_eq!(export.path.as_deref(), Some(".review-me/notes/branches/feature/docs.md"));
        assert_eq!((export.commits, export.notes), (2, 2));

        let md = read(root.join(".review-me/notes/branches/feature/docs.md"));
        assert!(md.contains("branch: \"feature/docs\"\n"));
        assert!(md.contains(&format!("tip: {docs}\n")));
        let older = md.find(&format!("## {} Add an account", &base[..7])).unwrap();
        let newer = md.find(&format!("## {} docs: describe accounts", &docs[..7])).unwrap();
        assert!(older < newer, "oldest commit first");
        assert!(md.contains("#### Line 2\n\nUse a BigDecimal."));
        assert!(!md.contains("Drop this."));
        assert!(!md.contains("Add withdrawals"), "a commit without notes is left out");
        // Each commit's own file and the index are regenerated alongside.
        assert!(commit_path(root, &docs).exists());
        assert!(commit_path(root, &base).exists());

        // Nothing left to say: no bundle.
        let scope = ReviewScope::Commit { oid: docs.clone() };
        tags::clear_scope(root, &scope).unwrap();
        let scope = ReviewScope::Commit { oid: base.clone() };
        tags::clear_scope(root, &scope).unwrap();
        let export = super::export(&repo, root, "refs/heads/feature/docs").unwrap();
        assert!(export.path.is_none());
        assert!(!root.join(".review-me/notes/branches/feature/docs.md").exists());
    }

    #[test]
    fn demotes_headings_outside_code_fences_only() {
        let text = "# Title\nplain #hash\n```md\n# not a heading\n```\n###### Deep\n#nospace";
        assert_eq!(
            demote_headings(text, 3),
            "#### Title\nplain #hash\n```md\n# not a heading\n```\n###### Deep\n#nospace"
        );
    }

    #[test]
    fn blockquotes_wrap_at_eighty_columns() {
        let quote = blockquote(&"word ".repeat(40));
        assert!(quote.lines().all(|l| l.starts_with("> ") && l.chars().count() <= 80));
        assert_eq!(quote.matches("word").count(), 40);
    }

    #[test]
    fn fences_outrun_backticks_in_the_content() {
        assert_eq!(fence_for(["plain"].into_iter()), "```");
        assert_eq!(fence_for(["a ```` b"].into_iter()), "`````");
    }

    #[test]
    fn formats_utc_timestamps() {
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso8601_utc(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(iso8601_utc(-1), "1969-12-31T23:59:59Z");
    }

    #[test]
    fn yaml_strings_survive_quotes_and_colons() {
        assert_eq!(yaml_string("fix: \"quoted\""), "\"fix: \\\"quoted\\\"\"");
    }
}
