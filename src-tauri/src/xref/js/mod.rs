//! JavaScript and TypeScript cross-references — scripts (`.ts`, `.tsx`, `.js`, `.jsx`,
//! `.mjs`, `.cjs`, `.d.ts`) and single-file components (`.vue`, `.svelte`, `.astro`).
//!
//! Unlike Java's, this index is lazy: building it reads every file and the project's
//! config, but a file is parsed only when a query needs it — the import chain a
//! definition follows, the files a reference search finds the name in by plain text —
//! so a monorepo of thousands of files costs what the query touches.
//!
//! Imports resolve the way the project's own tooling resolves them (`project.rs`); see
//! `resolve.rs` for names and members.

mod angular;
mod builtins;
mod config;
mod css;
mod jsonc;
mod parse;
mod project;
mod resolve;
mod scope;
mod sfc;
mod styles;
mod templates;

use std::cell::{OnceCell, RefCell};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use git2::Repository;
use tree_sitter::Node;

use super::{
    line_text, rank, row_start, utf16_to_byte, IndexStats, Occurrences, Span, SymbolKind,
    SymbolRef, XrefKind, XrefResult,
};
use crate::error::AppResult;
use crate::revision::{self, ProjectSource};
use parse::{text, Parsed};
use project::Project;
use resolve::{Resolution, Target};
use scope::{in_space, is_declaration_name, Space, NAME_KINDS};
use sfc::Tag;

pub use css::STYLE_EXTENSIONS;

/// The extensions this resolver reads.
pub const EXTENSIONS: &[&str] = &[
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro", "html",
];

/// Bigger files are bundles or generated, not code anyone navigates.
const MAX_FILE_BYTES: usize = 1 << 20;

struct JsFile {
    rel: String,
    source: String,
    parsed: OnceCell<Option<Parsed>>,
}

pub struct JsIndex {
    root: PathBuf,
    source: ProjectSource,
    files: Vec<JsFile>,
    file_index: HashMap<String, usize>,
    project: Project,
    /// Global declarations by name, found as names are asked about.
    globals: RefCell<HashMap<String, Vec<Target>>>,
    /// Nuxt's components by name, by the folder they're registered from.
    components: RefCell<HashMap<String, HashMap<String, String>>>,
    /// Angular's components, directives and pipes, gathered the first time a template
    /// asks.
    angular: OnceCell<angular::Angular>,
    /// Stylesheets by path: each `.css`/`.scss`/`.less` file, and each component with
    /// `<style>` blocks.
    sheets: HashMap<String, css::Sheet>,
}

// One cached index, rebuilt when the root or revision changes, or on request.
static INDEX: Mutex<Option<JsIndex>> = Mutex::new(None);

/// Whether the index reads `rel`: a script or component outside dependencies and
/// minified bundles.
fn indexed(rel: &str) -> bool {
    let name = project::file_name(rel);
    let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    EXTENSIONS.contains(&ext)
        && !name.contains(".min.")
        && !rel.split('/').any(|seg| seg == "node_modules" || seg == "bower_components")
}

/// Reads repo-relative files from `source`, resolving its tree once.
fn reader<'r>(
    repo: &'r Repository,
    root: &'r Path,
    source: &ProjectSource,
) -> AppResult<Box<dyn Fn(&str) -> Option<String> + 'r>> {
    Ok(match revision::tree(repo, source)? {
        None => Box::new(move |rel: &str| std::fs::read_to_string(root.join(rel)).ok()),
        Some(tree) => Box::new(move |rel: &str| {
            let entry = tree.get_path(Path::new(rel)).ok()?;
            let blob = entry.to_object(repo).ok()?.peel_to_blob().ok()?;
            String::from_utf8(blob.content().to_vec()).ok()
        }),
    })
}

impl JsIndex {
    fn build(
        repo: &Repository,
        root: &Path,
        source: &ProjectSource,
        rel_files: &[String],
    ) -> AppResult<JsIndex> {
        let read = reader(repo, root, source)?;
        let mut project = Project::load(rel_files, &*read);
        config::apply(&mut project, rel_files, &*read);
        let mut files = Vec::new();
        let mut file_index = HashMap::new();
        for rel in rel_files.iter().filter(|f| indexed(f)) {
            let Some(text) = read(rel).filter(|t| t.len() <= MAX_FILE_BYTES) else {
                continue;
            };
            file_index.insert(rel.clone(), files.len());
            files.push(JsFile {
                rel: rel.clone(),
                source: text,
                parsed: OnceCell::new(),
            });
        }
        let mut sheets = HashMap::new();
        for rel in rel_files.iter().filter(|f| css::is_stylesheet(f) && !f.split('/').any(|s| s == "node_modules")) {
            if let Some(text) = read(rel).filter(|t| t.len() <= MAX_FILE_BYTES) {
                sheets.insert(rel.clone(), css::Sheet::file(text, rel));
            }
        }
        for f in &files {
            if matches!(f.rel.rsplit_once('.').map(|(_, e)| e), Some("vue" | "svelte" | "astro")) {
                if let Some(sheet) = css::Sheet::component(&f.source) {
                    sheets.insert(f.rel.clone(), sheet);
                }
            }
        }
        Ok(JsIndex {
            root: root.to_path_buf(),
            source: source.clone(),
            files,
            file_index,
            project,
            globals: RefCell::new(HashMap::new()),
            components: RefCell::new(HashMap::new()),
            angular: OnceCell::new(),
            sheets,
        })
    }

    /// The file parsed — the first time it's asked for.
    fn parsed(&self, fi: usize) -> Option<&Parsed> {
        let f = &self.files[fi];
        f.parsed.get_or_init(|| parse::parse(&f.rel, &f.source)).as_ref()
    }

    /// The text `fi`'s tree was parsed from.
    fn code(&self, fi: usize) -> &str {
        let f = &self.files[fi];
        match self.parsed(fi) {
            Some(p) => p.code(&f.source),
            None => &f.source,
        }
    }

    /// The named node a target's byte points at: a declaration's name, or where an
    /// anonymous export's expression starts.
    fn node_at(&self, fi: usize, byte: usize) -> Option<Node<'_>> {
        self.parsed(fi)?
            .tree
            .root_node()
            .named_descendant_for_byte_range(byte, byte + 1)
    }

    fn result(&self, target: &Target, kind: XrefKind) -> XrefResult {
        match target {
            Target::Decl { file, byte } => {
                let f = &self.files[*file];
                let (line, col) = position(&f.source, *byte);
                XrefResult {
                    file: f.rel.clone(),
                    line,
                    col,
                    snippet: line_text(&f.source, line as usize - 1),
                    kind,
                    symbol_kind: self.node_at(*file, *byte).map_or(SymbolKind::Identifier, symbol_kind),
                    confirmed: true,
                }
            }
            Target::Style { file, byte } => {
                let text = self.sheet_text(file).unwrap_or("");
                let (line, col) = position(text, *byte);
                XrefResult {
                    file: file.clone(),
                    line,
                    col,
                    snippet: line_text(text, line as usize - 1),
                    kind,
                    symbol_kind: SymbolKind::Identifier,
                    confirmed: true,
                }
            }
            Target::File(rel) => XrefResult {
                file: rel.clone(),
                line: 1,
                col: 0,
                snippet: self
                    .file_index
                    .get(rel)
                    .and_then(|&fi| self.files[fi].source.lines().find(|l| !l.trim().is_empty()))
                    .map(|l| l.trim().to_string())
                    .unwrap_or_else(|| rel.clone()),
                kind,
                symbol_kind: SymbolKind::Module,
                confirmed: true,
            },
        }
    }

    fn resolve_located(&self, fi: usize, located: &Located) -> Resolution {
        match located {
            Located::Node(node) => self.resolve(fi, *node),
            Located::Tag(tag) => self.resolve_tag(fi, tag, 0),
        }
    }

    /// Where a symbol is in the index's copy of its file.
    fn locate(&self, symbol: &SymbolRef) -> Option<(usize, Located<'_>)> {
        let fi = *self.file_index.get(&symbol.file)?;
        let parsed = self.parsed(fi)?;
        let byte = byte_at(&self.files[fi].source, symbol.line, symbol.col)?;
        Some((fi, find(parsed, self.code(fi), byte)?))
    }

    /// Every declaration named like the symbol — what a name match can still offer when
    /// resolution can't decide.
    fn name_fallback(&self, symbol: &SymbolRef) -> Vec<XrefResult> {
        let mut out = Vec::new();
        for fi in 0..self.files.len() {
            if out.len() >= MAX_FALLBACK || !self.files[fi].source.contains(&symbol.name) {
                continue;
            }
            let Some(parsed) = self.parsed(fi) else {
                continue;
            };
            let code = self.code(fi);
            walk(parsed.tree.root_node(), &mut |n| {
                if NAME_KINDS.contains(&n.kind())
                    && text(n, code) == symbol.name
                    && is_declaration_name(n)
                    && notable(n)
                    && (symbol.kind != SymbolKind::Type || in_space(n, Space::Type))
                {
                    out.push(self.result(&Target::Decl { file: fi, byte: n.start_byte() }, XrefKind::Definition));
                }
            });
        }
        // A component used by its file's name.
        for rel in self.project.files_named(&symbol.name, &["vue", "svelte", "astro"]) {
            out.push(self.result(&Target::File(rel), XrefKind::Definition));
        }
        out.truncate(MAX_FALLBACK);
        out
    }
}

const MAX_FALLBACK: usize = 100;

/// A symbol's place in a parsed file: a node of its tree, or a template's component tag.
enum Located<'a> {
    Node(Node<'a>),
    Tag(&'a Tag),
}

/// The name (or module specifier) at `byte`.
fn find<'a>(parsed: &'a Parsed, code: &str, byte: usize) -> Option<Located<'a>> {
    if let Some(tag) = parsed.template.tag_at(byte) {
        return Some(Located::Tag(tag));
    }
    let node = parsed.tree.root_node().descendant_for_byte_range(byte, byte)?;
    if NAME_KINDS.contains(&node.kind()) {
        return Some(Located::Node(node));
    }
    if node.kind() == "string_fragment"
        && node.parent().is_some_and(|s| resolve::is_module_source(s, code))
    {
        return Some(Located::Node(node));
    }
    None
}

fn walk<'t>(root: Node<'t>, f: &mut dyn FnMut(Node<'t>)) {
    let mut cursor = root.walk();
    let mut stack = vec![root];
    while let Some(n) = stack.pop() {
        f(n);
        let children: Vec<Node> = n.children(&mut cursor).collect();
        stack.extend(children.into_iter().rev());
    }
}

/// Declarations worth offering as a name match: types, functions, members, top-level
/// variables — never a local or a parameter.
fn notable(name: Node) -> bool {
    let Some(parent) = name.parent() else {
        return false;
    };
    match parent.kind() {
        "function_declaration" | "generator_function_declaration" | "function_signature"
        | "class_declaration" | "abstract_class_declaration" | "interface_declaration"
        | "type_alias_declaration" | "enum_declaration" | "internal_module"
        | "method_definition" | "method_signature" | "abstract_method_signature"
        | "public_field_definition" | "field_definition" | "property_signature"
        | "enum_body" | "enum_assignment" => true,
        "variable_declarator" => {
            let stmt = parent.parent().and_then(|d| d.parent());
            stmt.is_some_and(|s| matches!(s.kind(), "program" | "export_statement"))
        }
        _ => false,
    }
}

fn symbol_kind(name: Node) -> SymbolKind {
    match name.parent().map(|p| p.kind()) {
        Some("class_declaration" | "abstract_class_declaration" | "class") => SymbolKind::Class,
        Some("interface_declaration") => SymbolKind::Interface,
        Some("enum_declaration") => SymbolKind::Enum,
        Some("type_alias_declaration") => SymbolKind::Type,
        Some("function_declaration" | "generator_function_declaration" | "function_signature") => {
            SymbolKind::Function
        }
        Some("method_definition" | "method_signature" | "abstract_method_signature") => SymbolKind::Method,
        Some(
            "public_field_definition" | "field_definition" | "property_signature" | "pair"
            | "enum_body" | "enum_assignment",
        ) => SymbolKind::Field,
        Some("internal_module") => SymbolKind::Module,
        _ => SymbolKind::Identifier,
    }
}

/// A byte offset as the viewer counts: 1-based line, 0-based UTF-16 column.
fn position(src: &str, byte: usize) -> (u32, u32) {
    let byte = byte.min(src.len());
    let before = &src[..byte];
    let line = before.matches('\n').count() as u32 + 1;
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    (line, src[line_start..byte].encode_utf16().count() as u32)
}

/// The byte offset of a viewer position (1-based line, 0-based UTF-16 column).
fn byte_at(src: &str, line: u32, col: u32) -> Option<usize> {
    let start = row_start(src, line.saturating_sub(1) as usize)?;
    Some(start + utf16_to_byte(&src[start..], col))
}

/// Whether an occurrence resolving to `got` is provably not the symbol that resolved to
/// `want` — find-references' rule: different declarations, or ours against the
/// outside world's. Anything undecidable on either side stays.
fn provably_different(want: &Resolution, got: &Resolution) -> bool {
    use Resolution::*;
    match (want, got) {
        (Found(w), Found(g)) => w != g,
        (Found(_), External) | (External, Found(_)) => true,
        (Ambiguous(_), External) | (External, Ambiguous(_)) => true,
        (Ambiguous(ts), Found(t)) | (Found(t), Ambiguous(ts)) => !ts.contains(t),
        _ => false,
    }
}

// ---------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------

pub fn build_index(
    repo: &Repository,
    root: &Path,
    source: &ProjectSource,
    rel_files: &[String],
) -> AppResult<IndexStats> {
    let index = JsIndex::build(repo, root, source, rel_files)?;
    let stats = IndexStats {
        files: index.files.len() as u32,
        symbols: 0,
    };
    *INDEX.lock().unwrap() = Some(index);
    Ok(stats)
}

fn ensure_index(
    repo: &Repository,
    root: &Path,
    source: &ProjectSource,
    rel_files: &[String],
) -> AppResult<()> {
    let needs_build = match INDEX.lock().unwrap().as_ref() {
        Some(index) => index.root != root || index.source != *source,
        None => true,
    };
    if needs_build {
        build_index(repo, root, source, rel_files)?;
    }
    Ok(())
}

/// The name under `(line, col)` (a 0-based UTF-16 column) in `rel`, parsed fresh.
pub fn symbol_at(
    repo: &Repository,
    root: &Path,
    source: &ProjectSource,
    rel: &str,
    line: u32,
    col: u32,
) -> AppResult<Option<SymbolRef>> {
    let text = revision::read_file(repo, source, root, rel)?;
    if let Some(symbol) = style_symbol_at(rel, &text, line, col) {
        return Ok(Some(symbol));
    }
    let Some(parsed) = parse::parse(rel, &text) else {
        return Ok(None);
    };
    let code = parsed.code(&text);
    let Some(byte) = byte_at(&text, line, col) else {
        return Ok(None);
    };
    let (start, name, kind) = match find(&parsed, code, byte) {
        Some(Located::Tag(tag)) => (tag.byte, tag.name.clone(), SymbolKind::Identifier),
        Some(Located::Node(node)) => {
            let kind = if node.kind() == "type_identifier" {
                SymbolKind::Type
            } else {
                SymbolKind::Identifier
            };
            (node.start_byte(), parse::text(node, code).to_string(), kind)
        }
        None => return Ok(None),
    };
    let (line, col) = position(&text, start);
    Ok(Some(SymbolRef {
        name,
        kind,
        file: rel.to_string(),
        line,
        col,
    }))
}

pub fn find_definition(
    repo: &Repository,
    root: &Path,
    source: &ProjectSource,
    rel_files: &[String],
    symbol: &SymbolRef,
) -> AppResult<Vec<XrefResult>> {
    ensure_index(repo, root, source, rel_files)?;
    let guard = INDEX.lock().unwrap();
    let index = guard.as_ref().expect("index built");
    if let Some(mut results) = style_definition(index, symbol) {
        rank(&mut results, &symbol.file);
        return Ok(results);
    }
    let mut results = match index.locate(symbol) {
        Some((fi, located)) => match index.resolve_located(fi, &located) {
            Resolution::Found(t) => vec![index.result(&t, XrefKind::Definition)],
            Resolution::Ambiguous(ts) => ts.iter().map(|t| index.result(t, XrefKind::Definition)).collect(),
            // Known to be someone else's: a name match here would be a confident jump to
            // the wrong place.
            Resolution::External => Vec::new(),
            Resolution::Unresolved => index.name_fallback(symbol),
        },
        None => index.name_fallback(symbol),
    };
    rank(&mut results, &symbol.file);
    Ok(results)
}

pub fn find_references(
    repo: &Repository,
    root: &Path,
    source: &ProjectSource,
    rel_files: &[String],
    symbol: &SymbolRef,
) -> AppResult<Vec<XrefResult>> {
    ensure_index(repo, root, source, rel_files)?;
    let guard = INDEX.lock().unwrap();
    let index = guard.as_ref().expect("index built");
    let at_style = index
        .sheet_text(&symbol.file)
        .and_then(|text| byte_at(text, symbol.line, symbol.col))
        .and_then(|byte| index.style_token(&symbol.file, byte))
        .map(|(_, t)| t.clone());
    let want = match &at_style {
        Some(tok) => Some(index.resolve_style(&symbol.file, tok, 0)),
        None => index.locate(symbol).map(|(fi, located)| index.resolve_located(fi, &located)),
    };
    let found = match &want {
        Some(Resolution::Found(t)) => Some(t.clone()),
        _ => None,
    };
    // A module is imported by paths that never spell the symbol's name, but always its
    // file's.
    let stem = match &found {
        Some(Target::File(rel)) => Some(module_stem(rel).to_string()),
        _ => None,
    };
    // An Angular class is written in templates by its selectors and pipe name.
    let mut written_as = found.as_ref().map(|t| index.angular_names(t)).unwrap_or_default();
    let mut results = Vec::new();
    // A stylesheet's definition: its uses in stylesheets, and a CSS module class's in
    // scripts (`styles.cardTitle`) — only where they're proven, a class name being any word.
    let style = found.as_ref().and_then(|t| index.style_name(t));
    if let (Some(want), Some((space, name))) = (&found, &style) {
        for (file, byte, res) in index.style_references(want, name) {
            let confirmed = match &res {
                Resolution::Found(g) if g == want => true,
                Resolution::Found(_) | Resolution::External => continue,
                _ => false,
            };
            let text = index.sheet_text(&file).unwrap_or("");
            let (line, col) = position(text, byte);
            results.push(XrefResult {
                file: file.clone(),
                line,
                col,
                snippet: line_text(text, line as usize - 1),
                kind: XrefKind::Reference,
                symbol_kind: symbol.kind,
                confirmed,
            });
        }
        if *space != css::Space::Class {
            rank(&mut results, &symbol.file);
            return Ok(results);
        }
        written_as.push(name.clone());
        written_as.push(css::camel(name));
    }

    for fi in 0..index.files.len() {
        let src = &index.files[fi].source;
        let by_name = src.contains(&symbol.name);
        let by_stem = stem.as_ref().is_some_and(|s| src.contains(s.as_str()));
        let by_selector = written_as.iter().any(|w| src.contains(w.as_str()));
        if !by_name && !by_stem && !by_selector {
            continue;
        }
        let Some(parsed) = index.parsed(fi) else {
            continue;
        };
        let code = index.code(fi);
        // The names this file knows the symbol by: its own, and an import's alias.
        let mut names = vec![symbol.name.clone()];
        names.extend(written_as.iter().cloned());
        let proven_only = style.is_some();
        if let Some(want) = &found {
            for (local, imp) in &parsed.module.imports {
                // Renamed on the way in (`{ name as other }`), or a default or namespace
                // import, which names it however it likes.
                let candidate = match &imp.kind {
                    parse::ImportKind::Named(n) => n == &symbol.name,
                    _ => true,
                };
                if candidate && local != &symbol.name {
                    if let Resolution::Found(t) = index.resolve_import(fi, imp, 0) {
                        if &t == want {
                            names.push(local.clone());
                        }
                    }
                }
            }
        }
        let keep = |byte: usize, res: Resolution, results: &mut Vec<XrefResult>| {
            let confirmed = match &found {
                None => false,
                Some(w) => match &res {
                    Resolution::Found(g) if g == w => true,
                    // Provably a different symbol that happens to share a name.
                    Resolution::Found(_) | Resolution::External => return,
                    _ => false,
                },
            };
            let (line, col) = position(src, byte);
            results.push(XrefResult {
                file: index.files[fi].rel.clone(),
                line,
                col,
                snippet: line_text(src, line as usize - 1),
                kind: XrefKind::Reference,
                symbol_kind: symbol.kind,
                confirmed,
            });
        };
        let mut hits: Vec<(usize, Resolution)> = Vec::new();
        walk(parsed.tree.root_node(), &mut |n| {
            let named = NAME_KINDS.contains(&n.kind()) && names.iter().any(|x| x == text(n, code));
            let module = stem.is_some()
                && n.kind() == "string_fragment"
                && n.parent().is_some_and(|s| resolve::is_module_source(s, code));
            if named || module {
                hits.push((n.start_byte(), index.resolve(fi, n)));
            }
        });
        for tag in &parsed.template.tags {
            if names.iter().any(|x| x == &tag.name) {
                hits.push((tag.byte, index.resolve_tag(fi, tag, 0)));
            }
        }
        for (byte, res) in hits {
            if proven_only && !matches!(&res, Resolution::Found(g) if Some(g) == found.as_ref()) {
                continue;
            }
            keep(byte, res, &mut results);
        }
    }
    rank(&mut results, &symbol.file);
    Ok(results)
}

/// The stylesheet symbol at a viewer position of `rel` (a stylesheet, or a component's
/// `<style>`), read from `text`: its name as written.
fn style_symbol_at(rel: &str, text: &str, line: u32, col: u32) -> Option<SymbolRef> {
    let sheet = if css::is_stylesheet(rel) {
        css::Sheet::file(text.to_string(), rel)
    } else if matches!(rel.rsplit_once('.').map(|(_, e)| e), Some("vue" | "svelte" | "astro")) {
        css::Sheet::component(text)?
    } else {
        return None;
    };
    let byte = byte_at(text, line, col)?;
    sheet.region_at(byte)?;
    let toks = sheet.tokens(text);
    // `@use 'tokens'`: the path names the stylesheet.
    let (start, len) = match toks.loads.iter().find(|l| l.start <= byte && byte < l.start + l.spec.len()) {
        Some(load) => (load.start, load.spec.len()),
        None => {
            let tok = toks.tokens.iter().find(|t| t.start <= byte && byte < t.start + t.len)?;
            (tok.start, tok.len)
        }
    };
    let (line, col) = position(text, start);
    Some(SymbolRef {
        name: text[start..start + len].to_string(),
        kind: SymbolKind::Identifier,
        file: rel.to_string(),
        line,
        col,
    })
}

/// Where the stylesheet symbol `symbol` is defined; `None` when it isn't one.
fn style_definition(index: &JsIndex, symbol: &SymbolRef) -> Option<Vec<XrefResult>> {
    let text = index.sheet_text(&symbol.file)?;
    let byte = byte_at(text, symbol.line, symbol.col)?;
    if let Some(found) = index.style_load_at(&symbol.file, byte) {
        return Some(found.map(|t| vec![index.result(&t, XrefKind::Definition)]).unwrap_or_default());
    }
    let (_, tok) = index.style_token(&symbol.file, byte)?;
    Some(match index.resolve_style(&symbol.file, tok, 0) {
        Resolution::Found(t) => vec![index.result(&t, XrefKind::Definition)],
        Resolution::Ambiguous(ts) => ts.iter().map(|t| index.result(t, XrefKind::Definition)).collect(),
        Resolution::External => Vec::new(),
        // Every definition by that name: a variable some build config injects, say.
        Resolution::Unresolved => index
            .style_definitions(tok.space, &tok.name)
            .iter()
            .map(|t| index.result(t, XrefKind::Definition))
            .collect(),
    })
}

/// The occurrences of the stylesheet symbol at a position, in its sheet.
fn style_occurrences(index: &JsIndex, rel: &str, line: u32, col: u32) -> Option<Occurrences> {
    let text = index.sheet_text(rel)?;
    let byte = byte_at(text, line, col)?;
    let (at, tok) = index.style_token(rel, byte)?;
    let written = &text[tok.start..tok.start + tok.len];
    let want = index.resolve_style(rel, tok, 0);
    let tokens = &index.sheets.get(rel)?.tokens(text).tokens;
    let mut spans: Vec<Span> = tokens
        .iter()
        .enumerate()
        .filter(|(i, t)| {
            t.space == tok.space
                && &text[t.start..t.start + t.len] == written
                && (*i == at || !provably_different(&want, &index.resolve_style(rel, t, 0)))
        })
        .map(|(_, t)| {
            let (line, col) = position(text, t.start);
            Span { line, col }
        })
        .collect();
    spans.sort_by_key(|s| (s.line, s.col));
    Some(Occurrences { name: written.to_string(), spans })
}

/// `src/components/Button.vue` → `Button`; `src/util/index.ts` → `util`.
fn module_stem(rel: &str) -> &str {
    let name = project::file_name(rel);
    let stem = name.split('.').next().unwrap_or(name);
    if stem == "index" {
        project::file_name(project::parent(rel))
    } else {
        stem
    }
}

/// The occurrences in `rel` of the symbol at `(line, col)`, for highlighting: every
/// name match the resolver can't prove is a different symbol. `None` when the index
/// can't answer — not built for `source`, being built right now, or not reading `rel`.
pub fn occurrences(
    root: &Path,
    source: &ProjectSource,
    rel: &str,
    line: u32,
    col: u32,
) -> AppResult<Option<Occurrences>> {
    let Ok(guard) = INDEX.try_lock() else {
        return Ok(None);
    };
    let Some(index) = guard.as_ref() else {
        return Ok(None);
    };
    if index.root != root || index.source != *source {
        return Ok(None);
    }
    if let Some(found) = style_occurrences(index, rel, line, col) {
        return Ok(Some(found));
    }
    if css::is_stylesheet(rel) {
        return Ok(None);
    }
    let Some(&fi) = index.file_index.get(rel) else {
        return Ok(None);
    };
    let Some(parsed) = index.parsed(fi) else {
        return Ok(None);
    };
    let src = &index.files[fi].source;
    let code = index.code(fi);
    let none = || Ok(Some(Occurrences { name: String::new(), spans: Vec::new() }));
    let Some(byte) = byte_at(src, line, col) else {
        return none();
    };
    let Some(located) = find(parsed, code, byte) else {
        return none();
    };
    let (name, at) = match &located {
        Located::Node(n) if n.kind() != "string_fragment" => (text(*n, code).to_string(), n.start_byte()),
        Located::Tag(t) => (t.name.clone(), t.byte),
        _ => return none(),
    };
    let want = index.resolve_located(fi, &located);

    let mut spans = Vec::new();
    let mut push = |byte: usize| {
        let (line, col) = position(src, byte);
        spans.push(Span { line, col });
    };
    walk(parsed.tree.root_node(), &mut |n| {
        if NAME_KINDS.contains(&n.kind())
            && text(n, code) == name
            && (n.start_byte() == at || !provably_different(&want, &index.resolve(fi, n)))
        {
            push(n.start_byte());
        }
    });
    for tag in &parsed.template.tags {
        // Only as written: `<my-button>` doesn't read as `MyButton` in the viewer.
        if tag.name == name
            && src.get(tag.byte..tag.byte + tag.len) == Some(name.as_str())
            && (tag.byte == at || !provably_different(&want, &index.resolve_tag(fi, tag, 0)))
        {
            push(tag.byte);
        }
    }
    spans.sort_by_key(|s| (s.line, s.col));
    spans.dedup();
    Ok(Some(Occurrences { name, spans }))
}

/// How well a revision's imports resolve: every module specifier its scripts write,
/// sorted into the project's own files, the outside world's, and the ones nothing
/// accounts for — what makes resolution fall back to name matching in a project whose
/// setup it doesn't read yet.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Audit {
    pub files: u32,
    pub imports: u32,
    pub resolved: u32,
    pub external: u32,
    /// Every import nothing accounts for, where it's written.
    pub unresolved: Vec<XrefResult>,
    /// The unresolved ones by what they start with (`@/…`, `./…`, a package), most first.
    pub patterns: Vec<(String, u32)>,
}

pub fn audit(
    repo: &Repository,
    root: &Path,
    source: &ProjectSource,
    rel_files: &[String],
) -> AppResult<Audit> {
    ensure_index(repo, root, source, rel_files)?;
    let guard = INDEX.lock().unwrap();
    let index = guard.as_ref().expect("index built");
    let mut audit = Audit {
        files: index.files.len() as u32,
        imports: 0,
        resolved: 0,
        external: 0,
        unresolved: Vec::new(),
        patterns: Vec::new(),
    };
    let mut patterns: HashMap<String, u32> = HashMap::new();
    for fi in 0..index.files.len() {
        let Some(parsed) = index.parsed(fi) else {
            continue;
        };
        for (byte, spec) in &parsed.module.sources {
            audit.imports += 1;
            match index.module(fi, spec) {
                resolve::Module::Indexed(_) | resolve::Module::Other(_) => audit.resolved += 1,
                resolve::Module::External => audit.external += 1,
                resolve::Module::Unresolved => {
                    *patterns.entry(spec_pattern(spec)).or_default() += 1;
                    let src = &index.files[fi].source;
                    let (line, col) = position(src, *byte);
                    audit.unresolved.push(XrefResult {
                        file: index.files[fi].rel.clone(),
                        line,
                        col,
                        snippet: line_text(src, line as usize - 1),
                        kind: XrefKind::Reference,
                        symbol_kind: SymbolKind::Module,
                        // A fact about the import, not a guess about a name: listed plainly.
                        confirmed: true,
                    });
                }
            }
        }
    }
    let mut patterns: Vec<(String, u32)> = patterns.into_iter().collect();
    patterns.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    audit.patterns = patterns;
    Ok(audit)
}

/// What a specifier starts with, the way an alias or a package names it: `@/…`, `~/…`,
/// `$lib/…`, `./…`, `@scope/pkg`, `pkg`.
fn spec_pattern(spec: &str) -> String {
    if spec.starts_with("./") || spec.starts_with("../") {
        return "./…".to_string();
    }
    let (name, sub) = project::split_package(spec);
    if !project::is_package_name(name) {
        // An alias: its first segment.
        let first = spec.split('/').next().unwrap_or(spec);
        return if spec.len() > first.len() { format!("{first}/…") } else { first.to_string() };
    }
    if sub == "." {
        name.to_string()
    } else {
        format!("{name}/…")
    }
}

#[cfg(test)]
mod tests;
