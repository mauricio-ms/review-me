//! Cross-references: go-to-definition, find-references and in-file occurrences, one
//! resolver per language behind a dispatch on the file's extension.
//!
//! Every language answers with the same contract: an occurrence resolves to a
//! declaration (`Found`), to several it can't choose between (`Ambiguous`, which
//! surfaces a picker), to something provably outside the project (`External`: no
//! fallback, and references drop it), or to nothing it can decide (`Unresolved`: a
//! name match is still the best guess). Conflating the last two is what makes
//! navigation lie.

mod java;
mod js;

use std::path::Path;

use git2::Repository;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::revision::ProjectSource;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SymbolKind {
    Class,
    Interface,
    Enum,
    Method,
    Function,
    Field,
    Type,
    Module,
    Identifier,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum XrefKind {
    Definition,
    Reference,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolRef {
    pub name: String,
    pub kind: SymbolKind,
    pub file: String,
    pub line: u32,
    pub col: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XrefResult {
    pub file: String,
    pub line: u32,
    pub col: u32,
    pub snippet: String,
    pub kind: XrefKind,
    pub symbol_kind: SymbolKind,
    /// True when the resolver *proved* this occurrence refers to the symbol under the
    /// cursor. False means "matches by name, couldn't be decided" — never "wrong".
    /// Occurrences proven to mean something else are dropped instead of being flagged,
    /// so an unconfirmed result is always worth a look.
    pub confirmed: bool,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub files: u32,
    pub symbols: u32,
}

/// One occurrence of a symbol in a file, in the viewer's units: a 1-based line and a
/// 0-based UTF-16 column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub line: u32,
    pub col: u32,
}

/// The symbol under the viewer's cursor and where else in its file it occurs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Occurrences {
    pub name: String,
    /// In document order; the cursor's own occurrence included.
    pub spans: Vec<Span>,
}

/// Each language's index is a process-global `Mutex`, so two tests building their own
/// fixtures in parallel would clobber each other. Every test that builds or queries an
/// index holds this for its duration — including `xref_validate`, which lives in
/// another module, which is why it isn't private to a `tests` module.
#[cfg(test)]
pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The languages with a resolver, by what a file's path says it is.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Lang {
    Java,
    Js,
}

impl Lang {
    fn of(rel: &str) -> Option<Lang> {
        let ext = rel.rsplit_once('.').map(|(_, ext)| ext)?;
        if ext == "java" {
            Some(Lang::Java)
        } else if js::EXTENSIONS.contains(&ext) {
            Some(Lang::Js)
        } else {
            None
        }
    }
}

/// The extensions cross-references answer for — what the viewer asks the index about
/// rather than matching by name.
pub fn indexed_extensions() -> Vec<&'static str> {
    std::iter::once("java").chain(js::EXTENSIONS.iter().copied()).collect()
}

/// (Re)build every language's index for `root` at `source` over the given repo-relative
/// files. Content is read from `source`, so an index built for a branch comparison
/// never mixes in the checkout's version of a file.
pub fn build_index(
    repo: &Repository,
    root: &Path,
    source: &ProjectSource,
    rel_files: &[String],
) -> AppResult<IndexStats> {
    let java = java::build_index(repo, root, source, rel_files)?;
    let js = js::build_index(repo, root, source, rel_files)?;
    Ok(IndexStats {
        files: java.files + js.files,
        symbols: java.symbols + js.symbols,
    })
}

/// The identifier under `(line, col)` in `rel`, parsed fresh from `source`.
pub fn symbol_at(
    repo: &Repository,
    root: &Path,
    source: &ProjectSource,
    rel: &str,
    line: u32,
    col: u32,
) -> AppResult<Option<SymbolRef>> {
    match Lang::of(rel) {
        Some(Lang::Java) => java::symbol_at(repo, root, source, rel, line, col),
        Some(Lang::Js) => js::symbol_at(repo, root, source, rel, line, col),
        None => Ok(None),
    }
}

pub fn find_definition(
    repo: &Repository,
    root: &Path,
    source: &ProjectSource,
    rel_files: &[String],
    symbol: &SymbolRef,
) -> AppResult<Vec<XrefResult>> {
    match Lang::of(&symbol.file) {
        Some(Lang::Java) => java::find_definition(repo, root, source, rel_files, symbol),
        Some(Lang::Js) => js::find_definition(repo, root, source, rel_files, symbol),
        None => Ok(Vec::new()),
    }
}

pub fn find_references(
    repo: &Repository,
    root: &Path,
    source: &ProjectSource,
    rel_files: &[String],
    symbol: &SymbolRef,
) -> AppResult<Vec<XrefResult>> {
    match Lang::of(&symbol.file) {
        Some(Lang::Java) => java::find_references(repo, root, source, rel_files, symbol),
        Some(Lang::Js) => js::find_references(repo, root, source, rel_files, symbol),
        None => Ok(Vec::new()),
    }
}

/// The occurrences in `rel` of the symbol at `(line, col)` — a 0-based UTF-16 column, as
/// the viewer counts — for highlighting. `None` means the index can't answer for this
/// file (no resolver reads it, it isn't indexed at `source` yet, or it's being built
/// right now), and the viewer matches by name instead.
pub fn occurrences(
    root: &Path,
    source: &ProjectSource,
    rel: &str,
    line: u32,
    col: u32,
) -> AppResult<Option<Occurrences>> {
    match Lang::of(rel) {
        Some(Lang::Java) => java::occurrences(root, source, rel, line, col),
        Some(Lang::Js) => js::occurrences(root, source, rel, line, col),
        None => Ok(None),
    }
}

pub(crate) fn line_text(source: &str, row0: usize) -> String {
    source.lines().nth(row0).unwrap_or("").trim().to_string()
}

/// The byte offset where 0-based `row` starts, if the text has that many lines.
pub(crate) fn row_start(src: &str, row: usize) -> Option<usize> {
    if row == 0 {
        return Some(0);
    }
    src.match_indices('\n').nth(row - 1).map(|(i, _)| i + 1)
}

/// The byte offset in `line` of its `col`-th UTF-16 unit, clamped to the line's end.
pub(crate) fn utf16_to_byte(line: &str, col: u32) -> usize {
    let mut units = 0;
    for (i, ch) in line.char_indices() {
        if units >= col as usize || ch == '\n' {
            return i;
        }
        units += ch.len_utf16();
    }
    line.len()
}

/// Order results: proven hits first, then the file the cursor is in, then by path/line.
pub(crate) fn rank(results: &mut [XrefResult], same_file: &str) {
    results.sort_by(|a, b| {
        let a_same = a.file != same_file;
        let b_same = b.file != same_file;
        (!a.confirmed)
            .cmp(&(!b.confirmed))
            .then_with(|| a_same.cmp(&b_same))
            .then_with(|| a.file.cmp(&b.file))
            .then_with(|| a.line.cmp(&b.line))
    });
}
