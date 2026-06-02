use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use streaming_iterator::StreamingIterator;
use tree_sitter::{Language, Parser, Point, Query, QueryCursor, Tree};

use crate::error::{AppError, AppResult};
use crate::queries;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SymbolKind {
    Class,
    Interface,
    Enum,
    Method,
    Field,
    Type,
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
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub files: u32,
    pub symbols: u32,
}

struct DefRec {
    kind: SymbolKind,
    file: String,
    line: u32,
    col: u32,
    snippet: String,
}

struct FileEntry {
    rel: String,
    source: String,
    tree: Tree,
}

struct JavaIndex {
    root: PathBuf,
    files: Vec<FileEntry>,
    defs: HashMap<String, Vec<DefRec>>,
}

// One cached project index. Rebuilt when the root changes or on explicit request.
static INDEX: Mutex<Option<JavaIndex>> = Mutex::new(None);

fn java_language() -> Language {
    tree_sitter_java::LANGUAGE.into()
}

fn java_parser() -> AppResult<Parser> {
    let mut parser = Parser::new();
    parser
        .set_language(&java_language())
        .map_err(|e| AppError::TreeSitter(e.to_string()))?;
    Ok(parser)
}

fn is_java(rel: &str) -> bool {
    rel.ends_with(".java")
}

fn line_text(source: &str, row0: usize) -> String {
    source.lines().nth(row0).unwrap_or("").trim().to_string()
}

fn kind_from_capture(name: &str) -> SymbolKind {
    match name {
        "def.class" => SymbolKind::Class,
        "def.interface" => SymbolKind::Interface,
        "def.enum" => SymbolKind::Enum,
        "def.method" => SymbolKind::Method,
        "def.field" => SymbolKind::Field,
        _ => SymbolKind::Identifier,
    }
}

/// (Re)build the Java symbol index for `root` over the given repo-relative files.
pub fn build_index(root: &Path, rel_files: &[String]) -> AppResult<IndexStats> {
    let language = java_language();
    let def_query = Query::new(&language, queries::java::DEFINITIONS)
        .map_err(|e| AppError::TreeSitter(e.to_string()))?;
    let mut parser = java_parser()?;

    let mut files = Vec::new();
    let mut defs: HashMap<String, Vec<DefRec>> = HashMap::new();
    let mut symbol_count = 0u32;

    for rel in rel_files.iter().filter(|f| is_java(f)) {
        let source = match std::fs::read_to_string(root.join(rel)) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let tree = match parser.parse(&source, None) {
            Some(t) => t,
            None => continue,
        };

        let mut cursor = QueryCursor::new();
        let mut matches = cursor.matches(&def_query, tree.root_node(), source.as_bytes());
        while let Some(m) = matches.next() {
            for cap in m.captures {
                let cap_name = def_query.capture_names()[cap.index as usize];
                let node = cap.node;
                let name = source[node.byte_range()].to_string();
                let pos = node.start_position();
                defs.entry(name).or_default().push(DefRec {
                    kind: kind_from_capture(cap_name),
                    file: rel.clone(),
                    line: pos.row as u32 + 1,
                    col: pos.column as u32,
                    snippet: line_text(&source, pos.row),
                });
                symbol_count += 1;
            }
        }

        files.push(FileEntry {
            rel: rel.clone(),
            source,
            tree,
        });
    }

    let stats = IndexStats {
        files: files.len() as u32,
        symbols: symbol_count,
    };
    *INDEX.lock().unwrap() = Some(JavaIndex {
        root: root.to_path_buf(),
        files,
        defs,
    });
    Ok(stats)
}

/// Build the index if it's missing or was built for a different repo root.
fn ensure_index(root: &Path, rel_files: &[String]) -> AppResult<()> {
    let needs_build = {
        let guard = INDEX.lock().unwrap();
        match guard.as_ref() {
            Some(index) => index.root != root,
            None => true,
        }
    };
    if needs_build {
        build_index(root, rel_files)?;
    }
    Ok(())
}

/// The identifier under `(line, col)` in `root/rel`, parsed fresh from disk.
pub fn symbol_at(
    root: &Path,
    rel: &str,
    line: u32,
    col: u32,
) -> AppResult<Option<SymbolRef>> {
    if !is_java(rel) {
        return Ok(None);
    }
    let source = std::fs::read_to_string(root.join(rel))?;
    let mut parser = java_parser()?;
    let tree = match parser.parse(&source, None) {
        Some(t) => t,
        None => return Ok(None),
    };
    let point = Point::new(line.saturating_sub(1) as usize, col as usize);
    let node = match tree.root_node().descendant_for_point_range(point, point) {
        Some(n) => n,
        None => return Ok(None),
    };
    let kind = match node.kind() {
        "identifier" => SymbolKind::Identifier,
        "type_identifier" => SymbolKind::Type,
        _ => return Ok(None),
    };
    let pos = node.start_position();
    Ok(Some(SymbolRef {
        name: source[node.byte_range()].to_string(),
        kind,
        file: rel.to_string(),
        line: pos.row as u32 + 1,
        col: pos.column as u32,
    }))
}

pub fn find_definition(
    root: &Path,
    rel_files: &[String],
    symbol: &SymbolRef,
) -> AppResult<Vec<XrefResult>> {
    ensure_index(root, rel_files)?;
    let guard = INDEX.lock().unwrap();
    let index = guard.as_ref().expect("index built");
    let mut results: Vec<XrefResult> = index
        .defs
        .get(&symbol.name)
        .map(|recs| {
            recs.iter()
                .map(|d| XrefResult {
                    file: d.file.clone(),
                    line: d.line,
                    col: d.col,
                    snippet: d.snippet.clone(),
                    kind: XrefKind::Definition,
                    symbol_kind: d.kind,
                })
                .collect()
        })
        .unwrap_or_default();
    rank(&mut results, &symbol.file);
    Ok(results)
}

pub fn find_references(
    root: &Path,
    rel_files: &[String],
    symbol: &SymbolRef,
) -> AppResult<Vec<XrefResult>> {
    ensure_index(root, rel_files)?;
    let language = java_language();
    let ref_query = Query::new(&language, queries::java::REFERENCES)
        .map_err(|e| AppError::TreeSitter(e.to_string()))?;

    let guard = INDEX.lock().unwrap();
    let index = guard.as_ref().expect("index built");
    let mut results = Vec::new();

    for entry in &index.files {
        let mut cursor = QueryCursor::new();
        let mut matches =
            cursor.matches(&ref_query, entry.tree.root_node(), entry.source.as_bytes());
        while let Some(m) = matches.next() {
            for cap in m.captures {
                let node = cap.node;
                if &entry.source[node.byte_range()] != symbol.name {
                    continue;
                }
                let pos = node.start_position();
                results.push(XrefResult {
                    file: entry.rel.clone(),
                    line: pos.row as u32 + 1,
                    col: pos.column as u32,
                    snippet: line_text(&entry.source, pos.row),
                    kind: XrefKind::Reference,
                    symbol_kind: symbol.kind,
                });
            }
        }
    }

    rank(&mut results, &symbol.file);
    Ok(results)
}

/// Order results: same file as the cursor first, then by path and line.
fn rank(results: &mut [XrefResult], same_file: &str) {
    results.sort_by(|a, b| {
        let a_same = a.file != same_file;
        let b_same = b.file != same_file;
        a_same
            .cmp(&b_same)
            .then_with(|| a.file.cmp(&b.file))
            .then_with(|| a.line.cmp(&b.line))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn finds_java_definitions_and_references() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(
            root.join("Greeter.java"),
            "class Greeter {\n    String greet() { return \"hi\"; }\n}\n",
        )
        .unwrap();
        fs::write(
            root.join("Main.java"),
            "class Main {\n    void run() {\n        Greeter g = new Greeter();\n        g.greet();\n    }\n}\n",
        )
        .unwrap();
        let files = vec!["Greeter.java".to_string(), "Main.java".to_string()];

        build_index(root, &files).unwrap();

        let sym = SymbolRef {
            name: "Greeter".to_string(),
            kind: SymbolKind::Type,
            file: "Main.java".to_string(),
            line: 3,
            col: 8,
        };
        let defs = find_definition(root, &files, &sym).unwrap();
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].file, "Greeter.java");

        let refs = find_references(root, &files, &sym).unwrap();
        // Two `Greeter` usages in Main.java + the declaration in Greeter.java.
        assert!(refs.len() >= 3, "got {} refs", refs.len());
        assert!(refs.iter().any(|r| r.file == "Greeter.java"));
        assert!(refs.iter().any(|r| r.file == "Main.java"));

        // symbol_at lands on the `Greeter` type use in Main.java line 3.
        let at = symbol_at(root, "Main.java", 3, 8).unwrap().unwrap();
        assert_eq!(at.name, "Greeter");
    }
}
