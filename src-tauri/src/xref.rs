//! Java cross-references: a cached tree-sitter index plus a name/scope/type resolver.
//!
//! Everything here hangs off one primitive, [`resolve`], which answers "what
//! declaration does this identifier occurrence refer to?". Go-to-definition is
//! `resolve` at the cursor; find-references is `resolve` at every occurrence that
//! matches by name, keeping the ones that come back pointing at the same declaration.
//!
//! Resolution is *lazy* — the index stores syntax and declarations, never resolved
//! edges — so index build cost doesn't grow, and a query only pays for the
//! occurrences it actually looks at.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use git2::Repository;
use serde::{Deserialize, Serialize};
use streaming_iterator::StreamingIterator;
use tree_sitter::{Language, Node, Parser, Point, Query, QueryCursor, Tree};

use crate::error::{AppError, AppResult};
use crate::queries;
use crate::revision::{self, ProjectSource};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
    /// True when the resolver *proved* this occurrence refers to the symbol under the
    /// cursor. False means "matches by name, couldn't be decided" — never "wrong".
    /// Occurrences proven to mean something else are dropped instead of being flagged,
    /// so an unconfirmed result is always worth a look.
    pub confirmed: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub files: u32,
    pub symbols: u32,
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

type DefId = usize;

struct DefRec {
    name: String,
    kind: SymbolKind,
    /// Index into `JavaIndex::files`.
    file: usize,
    line: u32,
    col: u32,
    snippet: String,
    /// The type declaring this member; `None` for a top-level type.
    owner: Option<DefId>,
    /// Members declared directly in this type (types only).
    members: Vec<DefId>,
    /// Raw `extends`/`implements` names, resolved on demand against the *declaring*
    /// file's imports — which is why they're stored unresolved.
    supertypes: Vec<String>,
    /// Parameter count, for picking between overloads.
    arity: Option<usize>,
    /// A field's type or a method's return type, reduced to a base name (generics and
    /// array dimensions stripped) so it can be fed straight back into `resolve_type`.
    declared_type: Option<String>,
}

struct Import {
    /// Fully-qualified path, without any trailing `.*`.
    path: String,
    wildcard: bool,
    /// `import static`: the path names a member (or, with `.*`, every member) of a type.
    is_static: bool,
}

struct FileEntry {
    rel: String,
    source: String,
    tree: Tree,
    package: Option<String>,
    imports: Vec<Import>,
}

/// What a cached index was built from. A branch comparison browses a commit's tree,
/// so the same repo root can have several distinct indexes.
#[derive(PartialEq, Eq)]
struct IndexKey {
    root: PathBuf,
    source: ProjectSource,
}

struct JavaIndex {
    key: IndexKey,
    files: Vec<FileEntry>,
    defs: Vec<DefRec>,
    /// Name → declarations. The fallback path, used when resolution can't decide.
    by_name: HashMap<String, Vec<DefId>>,
    /// Fully-qualified name → type declaration. The backbone of type resolution.
    by_fqn: HashMap<String, DefId>,
    /// (file, type declaration node id) → definition; finds the type enclosing a node.
    type_by_node: HashMap<(usize, usize), DefId>,
    /// (file, name node id) → definition; recognises "the cursor is on a declaration".
    def_by_name_node: HashMap<(usize, usize), DefId>,
    file_index: HashMap<String, usize>,
}

// One cached project index. Rebuilt when the root or revision changes, or on
// explicit request.
static INDEX: Mutex<Option<JavaIndex>> = Mutex::new(None);

/// `INDEX` above is process-global, so two tests building their own fixtures in
/// parallel would clobber each other. Every test that builds or queries an index holds
/// this for its duration — including `xref_validate`, which lives in another module,
/// which is why it isn't private to `tests` below.
#[cfg(test)]
pub(crate) static TEST_LOCK: Mutex<()> = Mutex::new(());

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

fn is_type_kind(kind: SymbolKind) -> bool {
    matches!(
        kind,
        SymbolKind::Class | SymbolKind::Interface | SymbolKind::Enum
    )
}

/// Node kinds that carry a definition captured by `queries::java::DEFINITIONS`.
const DECL_KINDS: &[&str] = &[
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "record_declaration",
    "annotation_type_declaration",
    "method_declaration",
    "constructor_declaration",
    "compact_constructor_declaration",
    "field_declaration",
    "enum_constant",
];

const TYPE_DECL_KINDS: &[&str] = &[
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "record_declaration",
    "annotation_type_declaration",
];

// ---------------------------------------------------------------------------
// Java syntax helpers
// ---------------------------------------------------------------------------

/// The base name of a type node: `List<Foo>` → `List`, `a.b.C[]` → `C`. Primitives
/// and `void` yield `None`, since nothing in the project can define them.
fn base_type_name(node: Node, src: &str) -> Option<String> {
    match node.kind() {
        "type_identifier" => Some(src[node.byte_range()].to_string()),
        "generic_type" | "annotated_type" => {
            let mut cur = node.walk();
            let found = node.children(&mut cur).find_map(|c| base_type_name(c, src));
            found
        }
        "array_type" => node
            .child_by_field_name("element")
            .and_then(|c| base_type_name(c, src)),
        "scoped_type_identifier" => {
            let mut cur = node.walk();
            let found = node
                .children(&mut cur)
                .filter(|c| c.kind() == "type_identifier")
                .last()
                .map(|c| src[c.byte_range()].to_string());
            found
        }
        _ => None,
    }
}

/// The nearest enclosing declaration node for a captured name.
fn declaration_of(node: Node) -> Option<Node> {
    let mut cur = Some(node);
    while let Some(n) = cur {
        if DECL_KINDS.contains(&n.kind()) {
            return Some(n);
        }
        cur = n.parent();
    }
    None
}

/// The type declaration a node sits inside, if any (skipping the node itself).
fn enclosing_type_decl(node: Node) -> Option<Node> {
    let mut cur = node.parent();
    while let Some(n) = cur {
        if TYPE_DECL_KINDS.contains(&n.kind()) {
            return Some(n);
        }
        cur = n.parent();
    }
    None
}

fn collect_type_names(node: Node, src: &str, out: &mut Vec<String>) {
    let mut cur = node.walk();
    for child in node.children(&mut cur) {
        match child.kind() {
            "type_list" => collect_type_names(child, src, out),
            _ => {
                if let Some(name) = base_type_name(child, src) {
                    out.push(name);
                }
            }
        }
    }
}

/// `extends` / `implements` names on a type declaration, left unresolved.
fn supertype_names(decl: Node, src: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = decl.walk();
    for child in decl.children(&mut cur) {
        if matches!(
            child.kind(),
            "superclass" | "super_interfaces" | "extends_interfaces"
        ) {
            collect_type_names(child, src, &mut out);
        }
    }
    out
}

fn parameter_count(decl: Node) -> Option<usize> {
    let params = decl.child_by_field_name("parameters")?;
    let mut cur = params.walk();
    Some(params.named_children(&mut cur).count())
}

fn is_static_import(decl: Node) -> bool {
    let mut cur = decl.walk();
    let found = decl.children(&mut cur).any(|n| n.kind() == "static");
    found
}

/// A file's `package` name and `import`s.
fn file_header(tree: &Tree, src: &str) -> (Option<String>, Vec<Import>) {
    let root = tree.root_node();
    let mut package = None;
    let mut imports = Vec::new();
    let mut cur = root.walk();
    for child in root.children(&mut cur) {
        let named = || {
            let mut c = child.walk();
            let found = child
                .children(&mut c)
                .find(|n| matches!(n.kind(), "identifier" | "scoped_identifier"))
                .map(|n| src[n.byte_range()].to_string());
            found
        };
        match child.kind() {
            "package_declaration" => package = named(),
            "import_declaration" => {
                if let Some(path) = named() {
                    imports.push(Import {
                        path,
                        wildcard: src[child.byte_range()].contains(".*"),
                        is_static: is_static_import(child),
                    });
                }
            }
            _ => {}
        }
    }
    (package, imports)
}

// ---------------------------------------------------------------------------
// Index building
// ---------------------------------------------------------------------------

/// (Re)build the Java symbol index for `root` at `source` over the given
/// repo-relative files. Content is read from `source`, so an index built for a branch
/// comparison never mixes in the checkout's version of a file.
pub fn build_index(
    repo: &Repository,
    root: &Path,
    source: &ProjectSource,
    rel_files: &[String],
) -> AppResult<IndexStats> {
    let language = java_language();
    let def_query = Query::new(&language, queries::java::DEFINITIONS)
        .map_err(|e| AppError::TreeSitter(e.to_string()))?;
    let mut parser = java_parser()?;

    let mut files: Vec<FileEntry> = Vec::new();
    let mut file_index = HashMap::new();
    for rel in rel_files.iter().filter(|f| is_java(f)) {
        let text = match revision::read_file(repo, source, root, rel) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let tree = match parser.parse(&text, None) {
            Some(t) => t,
            None => continue,
        };
        let (package, imports) = file_header(&tree, &text);
        file_index.insert(rel.clone(), files.len());
        files.push(FileEntry {
            rel: rel.clone(),
            source: text,
            tree,
            package,
            imports,
        });
    }

    // Pass 1: every declaration, with the node it was declared by. Ownership is
    // resolved afterwards because a query yields matches in no particular order.
    let mut defs: Vec<DefRec> = Vec::new();
    let mut type_by_node: HashMap<(usize, usize), DefId> = HashMap::new();
    let mut def_by_name_node: HashMap<(usize, usize), DefId> = HashMap::new();
    let mut owner_nodes: Vec<Option<(usize, usize)>> = Vec::new();

    for (fi, entry) in files.iter().enumerate() {
        let src = &entry.source;
        let mut cursor = QueryCursor::new();
        let mut matches = cursor.matches(&def_query, entry.tree.root_node(), src.as_bytes());
        while let Some(m) = matches.next() {
            for cap in m.captures {
                let name_node = cap.node;
                let Some(decl) = declaration_of(name_node) else {
                    continue;
                };
                let kind = kind_from_capture(def_query.capture_names()[cap.index as usize]);
                let pos = name_node.start_position();
                let declared_type = if kind == SymbolKind::Field && decl.kind() == "enum_constant" {
                    // An enum constant's type is the enum that declares it.
                    enclosing_type_decl(decl)
                        .and_then(|t| t.child_by_field_name("name"))
                        .map(|n| src[n.byte_range()].to_string())
                } else {
                    decl.child_by_field_name("type")
                        .and_then(|t| base_type_name(t, src))
                };

                let id = defs.len();
                defs.push(DefRec {
                    name: src[name_node.byte_range()].to_string(),
                    kind,
                    file: fi,
                    line: pos.row as u32 + 1,
                    col: pos.column as u32,
                    snippet: line_text(src, pos.row),
                    owner: None,
                    members: Vec::new(),
                    supertypes: if is_type_kind(kind) {
                        supertype_names(decl, src)
                    } else {
                        Vec::new()
                    },
                    arity: if kind == SymbolKind::Method {
                        parameter_count(decl)
                    } else {
                        None
                    },
                    declared_type,
                });
                owner_nodes.push(enclosing_type_decl(decl).map(|t| (fi, t.id())));
                def_by_name_node.insert((fi, name_node.id()), id);
                if is_type_kind(kind) {
                    type_by_node.insert((fi, decl.id()), id);
                }
            }
        }
    }

    // Pass 2: link members to the type that declares them.
    for id in 0..defs.len() {
        if let Some(owner) = owner_nodes[id].and_then(|k| type_by_node.get(&k).copied()) {
            defs[id].owner = Some(owner);
            defs[owner].members.push(id);
        }
    }

    // Pass 3: name and fully-qualified-name lookup tables.
    let mut by_name: HashMap<String, Vec<DefId>> = HashMap::new();
    let mut by_fqn: HashMap<String, DefId> = HashMap::new();
    for id in 0..defs.len() {
        by_name.entry(defs[id].name.clone()).or_default().push(id);
        if is_type_kind(defs[id].kind) {
            let mut parts = Vec::new();
            let mut cur = Some(id);
            while let Some(i) = cur {
                parts.push(defs[i].name.as_str());
                cur = defs[i].owner;
            }
            parts.reverse();
            let path = parts.join(".");
            let fqn = match &files[defs[id].file].package {
                Some(pkg) => format!("{pkg}.{path}"),
                None => path,
            };
            by_fqn.insert(fqn, id);
        }
    }

    let stats = IndexStats {
        files: files.len() as u32,
        symbols: defs.len() as u32,
    };
    *INDEX.lock().unwrap() = Some(JavaIndex {
        key: IndexKey {
            root: root.to_path_buf(),
            source: source.clone(),
        },
        files,
        defs,
        by_name,
        by_fqn,
        type_by_node,
        def_by_name_node,
        file_index,
    });
    Ok(stats)
}

/// Build the index if it's missing or was built for a different repo root/revision.
fn ensure_index(
    repo: &Repository,
    root: &Path,
    source: &ProjectSource,
    rel_files: &[String],
) -> AppResult<()> {
    let needs_build = {
        let guard = INDEX.lock().unwrap();
        match guard.as_ref() {
            Some(index) => index.key.root != root || index.key.source != *source,
            None => true,
        }
    };
    if needs_build {
        build_index(repo, root, source, rel_files)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/// What an identifier occurrence refers to. Locals aren't indexed — there are far too
/// many and each is visible inside one method — so they're identified positionally.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Target {
    Def(DefId),
    Local { file: usize, byte: usize },
}

enum Resolution {
    Found(Target),
    /// Several candidates, none provably right — this is what surfaces a picker.
    Ambiguous(Vec<DefId>),
    /// Resolved to something *outside* the project: a JDK or jar type, or a member of
    /// one. Nothing declared here can be the answer, so falling back to a name match
    /// would be provably wrong — `books.add(..)` on a `List` must not land on some
    /// unrelated `add` in this repo. Proof of difference, so references drop it.
    External,
    /// Genuinely undecidable: `var`, a generic element type, a member of a type that
    /// extends something we can't see, or an expression form we don't model. A name
    /// match is still the best guess.
    Unresolved,
}

/// What the receiver of a member access turned out to be. Mirrors `Resolution`'s
/// external/unknown split, which is the distinction that keeps navigation honest.
enum RecvType {
    Known(DefId),
    External,
    Unknown,
}

/// Depth cap for the mutually-recursive walks (receiver types, supertype chains).
const MAX_DEPTH: usize = 16;

fn finish(hits: Vec<DefId>) -> Resolution {
    match hits.len() {
        0 => Resolution::Unresolved,
        1 => Resolution::Found(Target::Def(hits[0])),
        _ => Resolution::Ambiguous(hits),
    }
}

fn resolve(index: &JavaIndex, file: usize, node: Node) -> Resolution {
    resolve_at(index, file, node, 0)
}

fn resolve_at(index: &JavaIndex, file: usize, node: Node, depth: usize) -> Resolution {
    if depth > MAX_DEPTH {
        return Resolution::Unresolved;
    }
    let src = &index.files[file].source;
    let name = &src[node.byte_range()];

    // The cursor is on a declaration's own name.
    if let Some(&id) = index.def_by_name_node.get(&(file, node.id())) {
        return Resolution::Found(Target::Def(id));
    }
    if is_local_declaration_name(node) {
        return Resolution::Found(Target::Local {
            file,
            byte: node.start_byte(),
        });
    }

    if let Some(found) = resolve_in_import(index, file, node) {
        return found;
    }

    if node.kind() == "type_identifier" {
        return match resolve_type(index, file, name) {
            // Definitely a type, and definitely not one of ours.
            Resolution::Unresolved => Resolution::External,
            other => other,
        };
    }

    if let Some(parent) = node.parent() {
        let is_field = |field: &str| {
            parent.child_by_field_name(field).map(|n| n.id()) == Some(node.id())
        };
        match parent.kind() {
            "method_invocation" if is_field("name") => {
                return resolve_member(index, file, parent, name, true, depth);
            }
            "field_access" if is_field("field") => {
                return resolve_member(index, file, parent, name, false, depth);
            }
            _ => {}
        }
    }

    resolve_bare(index, file, node, name, depth)
}

/// A bare identifier: a local/parameter, then a field of the enclosing types (or their
/// supertypes), then one brought in by `import static`, then a type name used
/// statically.
fn resolve_bare(
    index: &JavaIndex,
    file: usize,
    node: Node,
    name: &str,
    depth: usize,
) -> Resolution {
    let src = &index.files[file].source;
    if let Some(decl) = find_local(node, src, name) {
        return Resolution::Found(Target::Local {
            file,
            byte: decl.start_byte(),
        });
    }
    let (hits, _) = enclosing_members(index, file, node, name, false, None, depth);
    if !hits.is_empty() {
        return finish(hits);
    }
    match statically_imported(index, file, name, false, None, depth) {
        Imported::Members(hits) => return finish(hits),
        // `import static java.lang.Math.PI`.
        Imported::External => return Resolution::External,
        // Not a field after all: a type name, or a package.
        Imported::Nothing { .. } => {}
    }
    match resolve_type(index, file, name) {
        Resolution::Unresolved if looks_like_type_name(name) => Resolution::External,
        other => other,
    }
}

/// Java capitalises type names and SHOUTS constants. An unresolvable identifier shaped
/// like a type — `System`, `Math`, `Objects` — is one from the JDK or a jar, and
/// saying so beats letting a name match send `System.out.println` to some `println`
/// in this repo. ALL_CAPS is excluded: those are constants — inherited, perhaps, from
/// a type we can't see — where a name match really is the best guess available.
fn looks_like_type_name(name: &str) -> bool {
    name.starts_with(char::is_uppercase) && name.chars().any(char::is_lowercase)
}

/// A member reached through `recv.name(..)` or `recv.field`, or with no receiver at all.
fn resolve_member(
    index: &JavaIndex,
    file: usize,
    access: Node,
    name: &str,
    want_method: bool,
    depth: usize,
) -> Resolution {
    let arity = if want_method {
        access.child_by_field_name("arguments").map(|args| {
            let mut cur = args.walk();
            args.named_children(&mut cur).count()
        })
    } else {
        None
    };
    let owner = match access.child_by_field_name("object") {
        None => return resolve_unqualified(index, file, access, name, want_method, arity, depth),
        Some(obj) => match expr_type(index, file, obj, depth + 1) {
            RecvType::Known(id) => id,
            RecvType::External => return Resolution::External,
            RecvType::Unknown => return Resolution::Unresolved,
        },
    };

    let (hits, chain_complete) = lookup_member(index, owner, name, want_method, arity, depth);
    if hits.is_empty() {
        // We searched a type we fully understand and the member isn't in it, so it
        // must come from outside — unless part of the supertype chain was itself
        // invisible, in which case we genuinely can't tell.
        return if chain_complete {
            Resolution::External
        } else {
            Resolution::Unresolved
        };
    }
    finish(hits)
}

/// A member called with no receiver — `foo(..)`: the enclosing types, then what
/// `import static` brings in. Only when everything that could declare it was in full
/// view is a miss proof that it comes from outside.
fn resolve_unqualified(
    index: &JavaIndex,
    file: usize,
    access: Node,
    name: &str,
    want_method: bool,
    arity: Option<usize>,
    depth: usize,
) -> Resolution {
    let (hits, enclosing_complete) =
        enclosing_members(index, file, access, name, want_method, arity, depth);
    if !hits.is_empty() {
        return finish(hits);
    }
    match statically_imported(index, file, name, want_method, arity, depth) {
        Imported::Members(hits) => finish(hits),
        Imported::External => Resolution::External,
        Imported::Nothing { complete } if complete && enclosing_complete => Resolution::External,
        Imported::Nothing { .. } => Resolution::Unresolved,
    }
}

/// Members named `name` that code inside `node` reaches without a receiver: those of
/// the enclosing types, innermost first and each up its supertype chain — a nested class
/// sees its outer class's members. Also whether every chain searched was fully visible;
/// outside any type, nothing was.
fn enclosing_members(
    index: &JavaIndex,
    file: usize,
    node: Node,
    name: &str,
    want_method: bool,
    arity: Option<usize>,
    depth: usize,
) -> (Vec<DefId>, bool) {
    let mut searched = false;
    let mut complete = true;
    let mut decl = enclosing_type_decl(node);
    while let Some(d) = decl {
        if let Some(&owner) = index.type_by_node.get(&(file, d.id())) {
            let (hits, chain_complete) =
                lookup_member(index, owner, name, want_method, arity, depth);
            if !hits.is_empty() {
                return (hits, true);
            }
            searched = true;
            complete &= chain_complete;
        }
        decl = enclosing_type_decl(d);
    }
    (Vec::new(), searched && complete)
}

/// What `import static` brings into a file under one name.
enum Imported {
    /// Members of a project type.
    Members(Vec<DefId>),
    /// A single static import names it, from a type outside the project.
    External,
    /// No import supplies it: provably so, unless an imported project type extends
    /// something we can't see.
    Nothing { complete: bool },
}

/// Members named `name` that `import static` brings into `file`. As in Java, a single
/// import naming it shadows the on-demand ones (`.*`).
fn statically_imported(
    index: &JavaIndex,
    file: usize,
    name: &str,
    want_method: bool,
    arity: Option<usize>,
    depth: usize,
) -> Imported {
    let imports = index.files[file].imports.iter().filter(|i| i.is_static);
    let singles = imports
        .clone()
        .filter(|i| !i.wildcard)
        .filter_map(|i| i.path.rsplit_once('.'))
        .filter(|&(_, member)| member == name)
        .map(|(owner, _)| (owner, true));
    let on_demand = imports
        .filter(|i| i.wildcard)
        .map(|i| (i.path.as_str(), false));
    let mut complete = true;
    for (owner, single) in singles.chain(on_demand) {
        match index.by_fqn.get(owner) {
            Some(&owner) => {
                let (hits, chain_complete) =
                    lookup_member(index, owner, name, want_method, arity, depth + 1);
                if !hits.is_empty() {
                    return Imported::Members(hits);
                }
                complete &= chain_complete;
            }
            // `import static org.junit.Assert.assertEquals`: that's where it comes from.
            None if single => return Imported::External,
            // A jar's `.*` may well supply it, but proves nothing about our own types.
            None => {}
        }
    }
    Imported::Nothing { complete }
}

/// A name inside an `import`: the type its path spells out so far, else — in an
/// `import static` — the members of the type before it. Anything else there (a package,
/// a jar's type) is nothing declared in this project. `None` outside imports.
fn resolve_in_import(index: &JavaIndex, file: usize, node: Node) -> Option<Resolution> {
    let mut decl = node.parent()?;
    while decl.kind() == "scoped_identifier" {
        decl = decl.parent()?;
    }
    if decl.kind() != "import_declaration" {
        return None;
    }
    // The path up to this name: the scoped identifier it ends, or just the name.
    let path_node = node
        .parent()
        .filter(|p| {
            p.kind() == "scoped_identifier"
                && p.child_by_field_name("name").map(|n| n.id()) == Some(node.id())
        })
        .unwrap_or(node);
    let src = &index.files[file].source;
    let path: String = src[path_node.byte_range()].split_whitespace().collect();
    if let Some(&id) = index.by_fqn.get(&path) {
        return Some(Resolution::Found(Target::Def(id)));
    }
    if is_static_import(decl) {
        if let Some((owner, member)) = path.rsplit_once('.') {
            if let Some(&owner) = index.by_fqn.get(owner) {
                // `import static` brings in every member by that name, field or method.
                let (mut hits, _) = lookup_member(index, owner, member, true, None, 0);
                hits.extend(lookup_member(index, owner, member, false, None, 0).0);
                if !hits.is_empty() {
                    return Some(finish(hits));
                }
            }
        }
    }
    Some(Resolution::External)
}

/// Resolve a type *name* against a file's imports, then its package, then wildcards,
/// falling back to a project-wide name match.
fn resolve_type(index: &JavaIndex, file: usize, name: &str) -> Resolution {
    let entry = &index.files[file];

    for import in entry.imports.iter().filter(|i| !i.wildcard) {
        if import.path.rsplit('.').next() == Some(name) {
            if let Some(&id) = index.by_fqn.get(&import.path) {
                return Resolution::Found(Target::Def(id));
            }
        }
    }

    match &entry.package {
        Some(pkg) => {
            if let Some(&id) = index.by_fqn.get(&format!("{pkg}.{name}")) {
                return Resolution::Found(Target::Def(id));
            }
        }
        None => {
            if let Some(&id) = index.by_fqn.get(name) {
                return Resolution::Found(Target::Def(id));
            }
        }
    }

    for import in entry.imports.iter().filter(|i| i.wildcard) {
        if let Some(&id) = index.by_fqn.get(&format!("{}.{}", import.path, name)) {
            return Resolution::Found(Target::Def(id));
        }
    }

    // Nested types referenced by their simple name, and anything else that only a
    // plain name match can reach.
    finish(
        index
            .by_name
            .get(name)
            .map(|ids| {
                ids.iter()
                    .copied()
                    .filter(|&id| is_type_kind(index.defs[id].kind))
                    .collect()
            })
            .unwrap_or_default(),
    )
}

/// Classify a type *name* mentioned in `file`: ours, someone else's, or unknowable.
fn recv_from_type_name(index: &JavaIndex, file: usize, name: &str) -> RecvType {
    match named_type(index, file, name) {
        Some(id) => RecvType::Known(id),
        // `var` is the one name that means "inference we don't do" rather than a type.
        None if name == "var" => RecvType::Unknown,
        None => RecvType::External,
    }
}

/// The type of an expression — the heart of receiver resolution.
fn expr_type(index: &JavaIndex, file: usize, node: Node, depth: usize) -> RecvType {
    if depth > MAX_DEPTH {
        return RecvType::Unknown;
    }
    let src = &index.files[file].source;
    let declared_of = |id: DefId| match &index.defs[id].declared_type {
        Some(name) => recv_from_type_name(index, index.defs[id].file, name),
        None => RecvType::Unknown,
    };
    match node.kind() {
        "identifier" => match resolve_at(index, file, node, depth) {
            // A type used statically (`Files.readString(..)`) is already the owner.
            Resolution::Found(Target::Def(id)) if is_type_kind(index.defs[id].kind) => {
                RecvType::Known(id)
            }
            Resolution::Found(Target::Def(id)) => declared_of(id),
            Resolution::Found(Target::Local { file: lf, byte }) => {
                match local_declared_type(index, lf, byte) {
                    Some(declared) => recv_from_type_name(index, lf, &declared),
                    None => RecvType::Unknown,
                }
            }
            Resolution::External => RecvType::External,
            _ => RecvType::Unknown,
        },
        "this" => match enclosing_type_id(index, file, node) {
            Some(id) => RecvType::Known(id),
            None => RecvType::Unknown,
        },
        "super" => match enclosing_type_id(index, file, node)
            .and_then(|id| supertype_ids(index, id).into_iter().next())
        {
            Some(id) => RecvType::Known(id),
            None => RecvType::Unknown,
        },
        "field_access" | "method_invocation" => {
            let name_field = if node.kind() == "field_access" {
                "field"
            } else {
                "name"
            };
            let Some(inner) = node.child_by_field_name(name_field) else {
                return RecvType::Unknown;
            };
            match resolve_at(index, file, inner, depth) {
                Resolution::Found(Target::Def(id)) => declared_of(id),
                Resolution::External => RecvType::External,
                _ => RecvType::Unknown,
            }
        }
        "object_creation_expression" | "cast_expression" => {
            match node
                .child_by_field_name("type")
                .and_then(|ty| base_type_name(ty, src))
            {
                Some(name) => recv_from_type_name(index, file, &name),
                None => RecvType::Unknown,
            }
        }
        "parenthesized_expression" => match node.named_child(0) {
            Some(inner) => expr_type(index, file, inner, depth + 1),
            None => RecvType::Unknown,
        },
        // Every literal's type is a JDK one.
        "string_literal" | "character_literal" | "decimal_integer_literal"
        | "decimal_floating_point_literal" | "true" | "false" => RecvType::External,
        _ => RecvType::Unknown,
    }
}

/// `resolve_type`, but only accepting an unambiguous answer.
fn named_type(index: &JavaIndex, file: usize, name: &str) -> Option<DefId> {
    match resolve_type(index, file, name) {
        Resolution::Found(Target::Def(id)) if is_type_kind(index.defs[id].kind) => Some(id),
        _ => None,
    }
}

/// Members named `name` on `owner`, then up its supertype chain. Overloads are
/// narrowed by argument count when that leaves at least one candidate.
///
/// Also reports whether the supertype chain was *fully* visible. A miss on a complete
/// chain proves the member comes from outside the project; a miss on an incomplete one
/// (something extends a jar class) proves nothing, so the caller must not treat it as
/// evidence.
fn lookup_member(
    index: &JavaIndex,
    owner: DefId,
    name: &str,
    want_method: bool,
    arity: Option<usize>,
    depth: usize,
) -> (Vec<DefId>, bool) {
    if depth > MAX_DEPTH {
        return (Vec::new(), false);
    }
    let mut hits: Vec<DefId> = index.defs[owner]
        .members
        .iter()
        .copied()
        .filter(|&m| {
            index.defs[m].name == name
                && if want_method {
                    index.defs[m].kind == SymbolKind::Method
                } else {
                    index.defs[m].kind == SymbolKind::Field
                }
        })
        .collect();

    if want_method && hits.len() > 1 {
        if let Some(n) = arity {
            let exact: Vec<DefId> = hits
                .iter()
                .copied()
                .filter(|&m| index.defs[m].arity == Some(n))
                .collect();
            if !exact.is_empty() {
                hits = exact;
            }
        }
    }
    if !hits.is_empty() {
        return (hits, true);
    }

    let file = index.defs[owner].file;
    let mut chain_complete = true;
    for super_name in &index.defs[owner].supertypes {
        match named_type(index, file, super_name) {
            Some(sup) if sup != owner => {
                let (inherited, sub_complete) =
                    lookup_member(index, sup, name, want_method, arity, depth + 1);
                if !inherited.is_empty() {
                    return (inherited, true);
                }
                chain_complete &= sub_complete;
            }
            Some(_) => {}
            // A supertype we can't see — anything could be hiding in it.
            None => chain_complete = false,
        }
    }
    (Vec::new(), chain_complete)
}

/// Supertypes of `owner`, resolved against the imports of the file that declares it.
fn supertype_ids(index: &JavaIndex, owner: DefId) -> Vec<DefId> {
    let file = index.defs[owner].file;
    index.defs[owner]
        .supertypes
        .iter()
        .filter_map(|name| named_type(index, file, name))
        .filter(|&id| id != owner)
        .collect()
}

fn enclosing_type_id(index: &JavaIndex, file: usize, node: Node) -> Option<DefId> {
    let decl = enclosing_type_decl(node)?;
    index.type_by_node.get(&(file, decl.id())).copied()
}

/// True when this identifier *is* a local/parameter declaration's name.
fn is_local_declaration_name(node: Node) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    let is_name = parent.child_by_field_name("name").map(|n| n.id()) == Some(node.id());
    match parent.kind() {
        "variable_declarator" => {
            is_name
                && parent
                    .parent()
                    .map(|g| g.kind() != "field_declaration")
                    .unwrap_or(false)
        }
        "formal_parameter" | "catch_formal_parameter" | "enhanced_for_statement" => is_name,
        "inferred_parameters" => true,
        "lambda_expression" => {
            parent.child_by_field_name("parameters").map(|n| n.id()) == Some(node.id())
        }
        _ => false,
    }
}

/// Walk enclosing scopes for a local, parameter, or catch/for binding named `name`.
/// Stops at the type boundary — fields are a separate lookup with different rules.
fn find_local<'t>(node: Node<'t>, src: &str, name: &str) -> Option<Node<'t>> {
    let mut child = node;
    let mut cur = node.parent();
    while let Some(scope) = cur {
        match scope.kind() {
            "method_declaration"
            | "constructor_declaration"
            | "compact_constructor_declaration"
            | "lambda_expression" => {
                if let Some(found) = param_named(scope, src, name) {
                    return Some(found);
                }
            }
            "enhanced_for_statement" => {
                if let Some(n) = scope.child_by_field_name("name") {
                    if src[n.byte_range()] == *name {
                        return Some(n);
                    }
                }
            }
            "catch_clause" | "for_statement" | "try_with_resources_statement" => {
                if let Some(found) = binding_named(scope, src, name) {
                    return Some(found);
                }
            }
            "block" | "constructor_body" | "switch_block" | "switch_block_statement_group"
            | "program" => {
                // Java requires declaration before use, so only look above the cursor.
                if let Some(found) = local_in_block(scope, src, name, child.start_byte()) {
                    return Some(found);
                }
            }
            k if TYPE_DECL_KINDS.contains(&k) => return None,
            _ => {}
        }
        child = scope;
        cur = scope.parent();
    }
    None
}

fn param_named<'t>(scope: Node<'t>, src: &str, name: &str) -> Option<Node<'t>> {
    let params = scope.child_by_field_name("parameters")?;
    if params.kind() == "identifier" {
        return (src[params.byte_range()] == *name).then_some(params);
    }
    let mut cur = params.walk();
    for param in params.named_children(&mut cur) {
        let candidate = param
            .child_by_field_name("name")
            .or(if param.kind() == "identifier" {
                Some(param)
            } else {
                None
            });
        if let Some(n) = candidate {
            if src[n.byte_range()] == *name {
                return Some(n);
            }
        }
    }
    None
}

fn binding_named<'t>(scope: Node<'t>, src: &str, name: &str) -> Option<Node<'t>> {
    let mut cur = scope.walk();
    for child in scope.named_children(&mut cur) {
        match child.kind() {
            "catch_formal_parameter" | "resource" => {
                if let Some(n) = child.child_by_field_name("name") {
                    if src[n.byte_range()] == *name {
                        return Some(n);
                    }
                }
            }
            "local_variable_declaration" => {
                if let Some(n) = declarator_named(child, src, name) {
                    return Some(n);
                }
            }
            "resource_specification" | "catch_type" => {
                if let Some(n) = binding_named(child, src, name) {
                    return Some(n);
                }
            }
            _ => {}
        }
    }
    None
}

fn local_in_block<'t>(
    block: Node<'t>,
    src: &str,
    name: &str,
    before: usize,
) -> Option<Node<'t>> {
    let mut cur = block.walk();
    for stmt in block.named_children(&mut cur) {
        if stmt.start_byte() > before {
            break;
        }
        if stmt.kind() == "local_variable_declaration" {
            if let Some(n) = declarator_named(stmt, src, name) {
                return Some(n);
            }
        }
    }
    None
}

fn declarator_named<'t>(decl: Node<'t>, src: &str, name: &str) -> Option<Node<'t>> {
    let mut cur = decl.walk();
    for d in decl.named_children(&mut cur) {
        if d.kind() != "variable_declarator" {
            continue;
        }
        if let Some(n) = d.child_by_field_name("name") {
            if src[n.byte_range()] == *name {
                return Some(n);
            }
        }
    }
    None
}

/// The declared type of a local found by the scope walk. `var` yields `None`, which is
/// what makes an inferred receiver honestly unresolvable.
fn local_declared_type(index: &JavaIndex, file: usize, byte: usize) -> Option<String> {
    let entry = &index.files[file];
    let node = entry.tree.root_node().descendant_for_byte_range(byte, byte)?;
    let mut cur = node.parent();
    while let Some(n) = cur {
        if matches!(
            n.kind(),
            "local_variable_declaration"
                | "formal_parameter"
                | "catch_formal_parameter"
                | "enhanced_for_statement"
                | "resource"
        ) {
            let ty = n.child_by_field_name("type")?;
            return base_type_name(ty, &entry.source);
        }
        cur = n.parent();
    }
    None
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/// The identifier under `(line, col)` in `rel`, parsed fresh from `source`.
pub fn symbol_at(
    repo: &Repository,
    root: &Path,
    source: &ProjectSource,
    rel: &str,
    line: u32,
    col: u32,
) -> AppResult<Option<SymbolRef>> {
    if !is_java(rel) {
        return Ok(None);
    }
    let source = revision::read_file(repo, source, root, rel)?;
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

/// The indexed node a `SymbolRef` points at.
fn locate<'i>(index: &'i JavaIndex, symbol: &SymbolRef) -> Option<(usize, Node<'i>)> {
    let file = *index.file_index.get(&symbol.file)?;
    let point = Point::new(
        symbol.line.saturating_sub(1) as usize,
        symbol.col as usize,
    );
    let node = index.files[file]
        .tree
        .root_node()
        .descendant_for_point_range(point, point)?;
    Some((file, node))
}

fn def_result(index: &JavaIndex, id: DefId) -> XrefResult {
    let def = &index.defs[id];
    XrefResult {
        file: index.files[def.file].rel.clone(),
        line: def.line,
        col: def.col,
        snippet: def.snippet.clone(),
        kind: XrefKind::Definition,
        symbol_kind: def.kind,
        confirmed: true,
    }
}

fn target_result(index: &JavaIndex, target: Target) -> Option<XrefResult> {
    match target {
        Target::Def(id) => Some(def_result(index, id)),
        Target::Local { file, byte } => {
            let entry = &index.files[file];
            let node = entry
                .tree
                .root_node()
                .descendant_for_byte_range(byte, byte)?;
            let pos = node.start_position();
            Some(XrefResult {
                file: entry.rel.clone(),
                line: pos.row as u32 + 1,
                col: pos.column as u32,
                snippet: line_text(&entry.source, pos.row),
                kind: XrefKind::Definition,
                symbol_kind: SymbolKind::Identifier,
                confirmed: true,
            })
        }
    }
}

/// Every declaration matching by name — the pre-resolution behaviour, kept as the
/// fallback for symbols the resolver can't decide.
fn name_fallback(index: &JavaIndex, symbol: &SymbolRef) -> Vec<XrefResult> {
    index
        .by_name
        .get(&symbol.name)
        .map(|ids| {
            ids.iter()
                .copied()
                .filter(|&id| {
                    symbol.kind != SymbolKind::Type || is_type_kind(index.defs[id].kind)
                })
                .map(|id| def_result(index, id))
                .collect()
        })
        .unwrap_or_default()
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

    let mut results = match locate(index, symbol) {
        Some((file, node)) => match resolve(index, file, node) {
            Resolution::Found(target) => target_result(index, target)
                .map(|r| vec![r])
                .unwrap_or_default(),
            Resolution::Ambiguous(ids) => {
                ids.into_iter().map(|id| def_result(index, id)).collect()
            }
            // Known to live outside the project: a name match here would be a
            // confident jump to the wrong place, so say nothing instead.
            Resolution::External => Vec::new(),
            Resolution::Unresolved => name_fallback(index, symbol),
        },
        None => name_fallback(index, symbol),
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
    let language = java_language();
    let ref_query = Query::new(&language, queries::java::REFERENCES)
        .map_err(|e| AppError::TreeSitter(e.to_string()))?;

    let guard = INDEX.lock().unwrap();
    let index = guard.as_ref().expect("index built");

    // What the cursor is actually on. Without it every hit stays unconfirmed rather
    // than being silently dropped.
    let target = locate(index, symbol).and_then(|(file, node)| match resolve(index, file, node) {
        Resolution::Found(t) => Some(t),
        _ => None,
    });

    let mut results = Vec::new();
    for (fi, entry) in index.files.iter().enumerate() {
        let mut cursor = QueryCursor::new();
        let mut matches =
            cursor.matches(&ref_query, entry.tree.root_node(), entry.source.as_bytes());
        while let Some(m) = matches.next() {
            for cap in m.captures {
                let node = cap.node;
                // Name equality is the cheap prefilter; only survivors get resolved.
                if entry.source[node.byte_range()] != symbol.name {
                    continue;
                }
                let confirmed = match target {
                    None => false,
                    Some(want) => match resolve(index, fi, node) {
                        Resolution::Found(got) if got == want => true,
                        // Provably a different symbol that happens to share a name —
                        // either another declaration here, or one from a jar.
                        Resolution::Found(_) | Resolution::External => continue,
                        _ => false,
                    },
                };
                let pos = node.start_position();
                results.push(XrefResult {
                    file: entry.rel.clone(),
                    line: pos.row as u32 + 1,
                    col: pos.column as u32,
                    snippet: line_text(&entry.source, pos.row),
                    kind: XrefKind::Reference,
                    symbol_kind: symbol.kind,
                    confirmed,
                });
            }
        }
    }

    rank(&mut results, &symbol.file);
    Ok(results)
}

/// Order results: proven hits first, then the file the cursor is in, then by path/line.
fn rank(results: &mut [XrefResult], same_file: &str) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::MutexGuard;

    /// Build a repo of Java files and index it. Returns the tempdir (keep it alive),
    /// the repo, the file list, and the serialising guard.
    fn fixture(
        files: &[(&str, &str)],
    ) -> (
        tempfile::TempDir,
        Repository,
        Vec<String>,
        MutexGuard<'static, ()>,
    ) {
        let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut rels = Vec::new();
        for (name, body) in files {
            let path = root.join(name);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, body).unwrap();
            rels.push((*name).to_string());
        }
        // The index reads through `revision`, so it needs a repo handle even for the
        // plain working-tree source.
        let repo = Repository::init(root).unwrap();
        build_index(&repo, root, &ProjectSource::Worktree, &rels).unwrap();
        (dir, repo, rels, guard)
    }

    fn sym(name: &str, file: &str, line: u32, col: u32) -> SymbolRef {
        SymbolRef {
            name: name.to_string(),
            kind: SymbolKind::Identifier,
            file: file.to_string(),
            line,
            col,
        }
    }

    /// Resolve the symbol at a position and return the single definition it lands on.
    fn def_at(
        repo: &Repository,
        root: &Path,
        rels: &[String],
        symbol: &SymbolRef,
    ) -> Vec<XrefResult> {
        find_definition(repo, root, &ProjectSource::Worktree, rels, symbol).unwrap()
    }

    #[test]
    fn finds_java_definitions_and_references() {
        let (dir, repo, rels, _lock) = fixture(&[
            (
                "Greeter.java",
                "class Greeter {\n    String greet() { return \"hi\"; }\n}\n",
            ),
            (
                "Main.java",
                "class Main {\n    void run() {\n        Greeter g = new Greeter();\n        g.greet();\n    }\n}\n",
            ),
        ]);
        let root = dir.path();

        // `Greeter` on line 3 of Main.java is a type use.
        let at = symbol_at(&repo, root, &ProjectSource::Worktree, "Main.java", 3, 8)
            .unwrap()
            .unwrap();
        assert_eq!(at.name, "Greeter");

        let defs = def_at(&repo, root, &rels, &at);
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].file, "Greeter.java");

        let refs =
            find_references(&repo, root, &ProjectSource::Worktree, &rels, &at).unwrap();
        assert!(refs.iter().any(|r| r.file == "Greeter.java"));
        assert!(refs.iter().any(|r| r.file == "Main.java"));
    }

    #[test]
    fn resolves_locals_and_parameters() {
        let (dir, repo, rels, _lock) = fixture(&[(
            "A.java",
            "class A {\n    void run(int width) {\n        int height = 2;\n        int area = width * height;\n    }\n}\n",
        )]);
        let root = dir.path();

        // `width` in the expression resolves to the parameter, not to anything global.
        let defs = def_at(&repo, root, &rels, &sym("width", "A.java", 4, 20));
        assert_eq!(defs.len(), 1, "parameter should resolve uniquely");
        assert_eq!(defs[0].line, 2);

        // `height` resolves to the local declared above it.
        let defs = def_at(&repo, root, &rels, &sym("height", "A.java", 4, 28));
        assert_eq!(defs.len(), 1, "local should resolve uniquely");
        assert_eq!(defs[0].line, 3);
    }

    #[test]
    fn local_shadows_field_of_same_name() {
        let (dir, repo, rels, _lock) = fixture(&[(
            "A.java",
            "class A {\n    int value = 1;\n    void run() {\n        int value = 2;\n        int x = value;\n    }\n}\n",
        )]);
        let root = dir.path();

        let defs = def_at(&repo, root, &rels, &sym("value", "A.java", 5, 16));
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].line, 4, "the local, not the field on line 2");
    }

    #[test]
    fn resolves_type_by_import_over_same_named_class() {
        let (dir, repo, rels, _lock) = fixture(&[
            ("a/Thing.java", "package a;\npublic class Thing {}\n"),
            ("b/Thing.java", "package b;\npublic class Thing {}\n"),
            (
                "c/Use.java",
                "package c;\nimport b.Thing;\nclass Use {\n    Thing t;\n}\n",
            ),
        ]);
        let root = dir.path();

        let defs = def_at(&repo, root, &rels, &sym("Thing", "c/Use.java", 4, 4));
        assert_eq!(defs.len(), 1, "the import decides between a.Thing and b.Thing");
        assert_eq!(defs[0].file, "b/Thing.java");
    }

    #[test]
    fn resolves_type_in_same_package_without_import() {
        let (dir, repo, rels, _lock) = fixture(&[
            ("a/Thing.java", "package a;\npublic class Thing {}\n"),
            ("b/Thing.java", "package b;\npublic class Thing {}\n"),
            ("a/Use.java", "package a;\nclass Use {\n    Thing t;\n}\n"),
        ]);
        let root = dir.path();

        let defs = def_at(&repo, root, &rels, &sym("Thing", "a/Use.java", 3, 4));
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].file, "a/Thing.java");
    }

    #[test]
    fn resolves_type_by_wildcard_import() {
        let (dir, repo, rels, _lock) = fixture(&[
            ("a/Thing.java", "package a;\npublic class Thing {}\n"),
            ("b/Thing.java", "package b;\npublic class Thing {}\n"),
            (
                "c/Use.java",
                "package c;\nimport a.*;\nclass Use {\n    Thing t;\n}\n",
            ),
        ]);
        let root = dir.path();

        let defs = def_at(&repo, root, &rels, &sym("Thing", "c/Use.java", 4, 4));
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].file, "a/Thing.java");
    }

    #[test]
    fn resolves_method_on_typed_receiver_not_the_same_name_elsewhere() {
        let (dir, repo, rels, _lock) = fixture(&[
            ("Dog.java", "class Dog {\n    void speak() {}\n}\n"),
            ("Cat.java", "class Cat {\n    void speak() {}\n}\n"),
            (
                "Main.java",
                "class Main {\n    void run() {\n        Dog d = new Dog();\n        d.speak();\n    }\n}\n",
            ),
        ]);
        let root = dir.path();

        let defs = def_at(&repo, root, &rels, &sym("speak", "Main.java", 4, 10));
        assert_eq!(defs.len(), 1, "Cat.speak must not be offered");
        assert_eq!(defs[0].file, "Dog.java");
    }

    #[test]
    fn walks_the_supertype_chain() {
        let (dir, repo, rels, _lock) = fixture(&[
            ("Base.java", "class Base {\n    void inherited() {}\n}\n"),
            ("Child.java", "class Child extends Base {}\n"),
            (
                "Main.java",
                "class Main {\n    void run() {\n        Child c = new Child();\n        c.inherited();\n    }\n}\n",
            ),
        ]);
        let root = dir.path();

        let defs = def_at(&repo, root, &rels, &sym("inherited", "Main.java", 4, 10));
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].file, "Base.java");
    }

    #[test]
    fn picks_the_overload_by_argument_count() {
        let (dir, repo, rels, _lock) = fixture(&[
            (
                "Box.java",
                "class Box {\n    void put() {}\n    void put(int a) {}\n    void put(int a, int b) {}\n}\n",
            ),
            (
                "Main.java",
                "class Main {\n    void run() {\n        Box b = new Box();\n        b.put(1, 2);\n    }\n}\n",
            ),
        ]);
        let root = dir.path();

        let defs = def_at(&repo, root, &rels, &sym("put", "Main.java", 4, 10));
        assert_eq!(defs.len(), 1, "two arguments picks the two-parameter overload");
        assert_eq!(defs[0].line, 4);
    }

    #[test]
    fn follows_a_chained_call_through_its_return_type() {
        let (dir, repo, rels, _lock) = fixture(&[
            ("Inner.java", "class Inner {\n    void deep() {}\n}\n"),
            ("Outer.java", "class Outer {\n    Inner inner() { return null; }\n}\n"),
            (
                "Main.java",
                "class Main {\n    void run() {\n        Outer o = new Outer();\n        o.inner().deep();\n    }\n}\n",
            ),
        ]);
        let root = dir.path();

        let defs = def_at(&repo, root, &rels, &sym("deep", "Main.java", 4, 18));
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].file, "Inner.java");
    }

    #[test]
    fn var_receiver_is_unresolved_and_falls_back_to_name_matching() {
        let (dir, repo, rels, _lock) = fixture(&[
            ("Dog.java", "class Dog {\n    void speak() {}\n}\n"),
            ("Cat.java", "class Cat {\n    void speak() {}\n}\n"),
            (
                "Main.java",
                "class Main {\n    void run() {\n        var d = new Dog();\n        d.speak();\n    }\n}\n",
            ),
        ]);
        let root = dir.path();

        // `var` defeats the resolver, so both candidates come back — the picker case.
        let defs = def_at(&repo, root, &rels, &sym("speak", "Main.java", 4, 10));
        assert_eq!(defs.len(), 2, "both speak() declarations are offered");
    }

    #[test]
    fn references_drop_same_named_methods_of_other_classes() {
        let (dir, repo, rels, _lock) = fixture(&[
            ("Dog.java", "class Dog {\n    void speak() {}\n}\n"),
            ("Cat.java", "class Cat {\n    void speak() {}\n}\n"),
            (
                "Main.java",
                "class Main {\n    void run() {\n        Dog d = new Dog();\n        d.speak();\n        Cat c = new Cat();\n        c.speak();\n    }\n}\n",
            ),
        ]);
        let root = dir.path();

        // Start from Dog.speak's own declaration.
        let refs = find_references(
            &repo,
            root,
            &ProjectSource::Worktree,
            &rels,
            &sym("speak", "Dog.java", 2, 9),
        )
        .unwrap();

        let confirmed: Vec<_> = refs.iter().filter(|r| r.confirmed).collect();
        assert!(
            confirmed.iter().any(|r| r.file == "Main.java" && r.line == 4),
            "d.speak() is a confirmed reference"
        );
        assert!(
            !refs.iter().any(|r| r.file == "Main.java" && r.line == 6),
            "c.speak() is provably Cat.speak and must be dropped entirely"
        );
        assert!(
            !refs.iter().any(|r| r.file == "Cat.java"),
            "Cat's own declaration must be dropped"
        );
    }

    #[test]
    fn unprovable_references_are_kept_as_unconfirmed() {
        let (dir, repo, rels, _lock) = fixture(&[
            ("Dog.java", "class Dog {\n    void speak() {}\n}\n"),
            (
                "Main.java",
                "class Main {\n    void run() {\n        var d = new Dog();\n        d.speak();\n    }\n}\n",
            ),
        ]);
        let root = dir.path();

        let refs = find_references(
            &repo,
            root,
            &ProjectSource::Worktree,
            &rels,
            &sym("speak", "Dog.java", 2, 9),
        )
        .unwrap();

        let hit = refs
            .iter()
            .find(|r| r.file == "Main.java")
            .expect("a var-typed call must never be silently dropped");
        assert!(!hit.confirmed, "it can't be proven, so it stays unconfirmed");
    }

    #[test]
    fn receiver_typed_by_a_missing_class_yields_nothing() {
        // `Widget` isn't in the project, so no `render` here can be the answer —
        // guessing `Painter.render` would be a confident jump to the wrong place.
        let (dir, repo, rels, _lock) = fixture(&[
            ("Painter.java", "class Painter {\n    void render() {}\n}\n"),
            (
                "Holder.java",
                "class Holder {\n    Widget widget;\n    void run() {\n        widget.render();\n    }\n}\n",
            ),
        ]);
        let defs = def_at(&repo, dir.path(), &rels, &sym("render", "Holder.java", 4, 15));
        assert!(defs.is_empty(), "got {defs:?}");
    }

    #[test]
    fn member_missing_from_a_fully_known_type_yields_nothing() {
        // `Known` has no supertypes, so we've seen all of it: `missing` must come
        // from outside, and `Other.missing` is not it.
        let (dir, repo, rels, _lock) = fixture(&[
            ("Known.java", "class Known {\n    void present() {}\n}\n"),
            ("Other.java", "class Other {\n    void missing() {}\n}\n"),
            (
                "Use.java",
                "class Use {\n    void run() {\n        Known k = new Known();\n        k.missing();\n    }\n}\n",
            ),
        ]);
        let defs = def_at(&repo, dir.path(), &rels, &sym("missing", "Use.java", 4, 10));
        assert!(defs.is_empty(), "got {defs:?}");
    }

    #[test]
    fn an_invisible_supertype_keeps_the_name_fallback() {
        // `Sub extends Unseen`, so `ping` could genuinely be inherited from a class we
        // can't read. That's not proof of anything — fall back rather than deny.
        let (dir, repo, rels, _lock) = fixture(&[
            ("Helper.java", "class Helper {\n    void ping() {}\n}\n"),
            ("Sub.java", "class Sub extends Unseen {\n}\n"),
            (
                "Use.java",
                "class Use {\n    void run() {\n        Sub s = new Sub();\n        s.ping();\n    }\n}\n",
            ),
        ]);
        let defs = def_at(&repo, dir.path(), &rels, &sym("ping", "Use.java", 4, 10));
        assert_eq!(defs.len(), 1, "an unreadable supertype means we can't rule it out");
        assert_eq!(defs[0].file, "Helper.java");
    }

    const STRINGS: (&str, &str) = (
        "util/Strings.java",
        "package util;\n\npublic class Strings {\n    public static String shout(String s) { return s; }\n    public static final String SEP = \"/\";\n}\n",
    );
    /// A same-named method a name match would also offer.
    const MEGAPHONE: (&str, &str) = (
        "other/Megaphone.java",
        "package other;\n\npublic class Megaphone {\n    public String shout(String s) { return s; }\n}\n",
    );

    #[test]
    fn resolves_what_a_static_import_names() {
        let (dir, repo, rels, _lock) = fixture(&[
            STRINGS,
            MEGAPHONE,
            (
                "app/Use.java",
                "package app;\n\nimport static util.Strings.shout;\nimport static util.Strings.SEP;\n\nclass Use {\n    String run() {\n        return shout(\"x\") + SEP;\n    }\n}\n",
            ),
        ]);
        let root = dir.path();
        let lands_on = |symbol: SymbolRef| {
            let defs = def_at(&repo, root, &rels, &symbol);
            assert_eq!(defs.len(), 1, "{symbol:?}: {defs:?}");
            (defs[0].file.clone(), defs[0].line)
        };

        assert_eq!(lands_on(sym("shout", "app/Use.java", 8, 15)), ("util/Strings.java".into(), 4));
        assert_eq!(lands_on(sym("SEP", "app/Use.java", 8, 28)), ("util/Strings.java".into(), 5));
        // The name in the import itself.
        assert_eq!(lands_on(sym("shout", "app/Use.java", 3, 27)), ("util/Strings.java".into(), 4));

        let refs = find_references(
            &repo,
            root,
            &ProjectSource::Worktree,
            &rels,
            &sym("shout", "util/Strings.java", 4, 25),
        )
        .unwrap();
        let confirmed = |line| refs.iter().any(|r| r.file == "app/Use.java" && r.line == line && r.confirmed);
        assert!(confirmed(8), "the call is a confirmed reference: {refs:?}");
        assert!(confirmed(3), "so is the import naming it: {refs:?}");
        assert!(
            !refs.iter().any(|r| r.file == "other/Megaphone.java"),
            "Megaphone.shout is another method: {refs:?}"
        );
    }

    #[test]
    fn resolves_an_on_demand_static_import() {
        let (dir, repo, rels, _lock) = fixture(&[
            STRINGS,
            MEGAPHONE,
            (
                "app/Use.java",
                "package app;\n\nimport static util.Strings.*;\n\nclass Use {\n    String run() {\n        return shout(\"x\");\n    }\n}\n",
            ),
        ]);
        let defs = def_at(&repo, dir.path(), &rels, &sym("shout", "app/Use.java", 7, 15));
        assert_eq!(defs.len(), 1, "{defs:?}");
        assert_eq!((defs[0].file.as_str(), defs[0].line), ("util/Strings.java", 4));
    }

    #[test]
    fn an_enclosing_class_shadows_a_static_import_even_from_a_nested_class() {
        let (dir, repo, rels, _lock) = fixture(&[
            STRINGS,
            (
                "app/Use.java",
                "package app;\n\nimport static util.Strings.shout;\n\nclass Use {\n    String shout(String s) { return s; }\n    class Inner {\n        String run() {\n            return shout(\"x\");\n        }\n    }\n}\n",
            ),
        ]);
        let defs = def_at(&repo, dir.path(), &rels, &sym("shout", "app/Use.java", 9, 19));
        assert_eq!(defs.len(), 1, "{defs:?}");
        assert_eq!((defs[0].file.as_str(), defs[0].line), ("app/Use.java", 6));
    }

    #[test]
    fn a_static_import_from_a_jar_is_external() {
        let (dir, repo, rels, _lock) = fixture(&[
            (
                "util/Checks.java",
                "package util;\n\npublic class Checks {\n    public static void assertEquals(Object a, Object b) {}\n}\n",
            ),
            (
                "app/UseTest.java",
                "package app;\n\nimport static org.junit.Assert.assertEquals;\n\nclass UseTest {\n    void check() {\n        assertEquals(1, 1);\n    }\n}\n",
            ),
        ]);
        let root = dir.path();
        let defs = def_at(&repo, root, &rels, &sym("assertEquals", "app/UseTest.java", 7, 8));
        assert!(defs.is_empty(), "JUnit's assertEquals is not Checks': {defs:?}");

        let refs = find_references(
            &repo,
            root,
            &ProjectSource::Worktree,
            &rels,
            &sym("assertEquals", "util/Checks.java", 4, 23),
        )
        .unwrap();
        assert!(!refs.iter().any(|r| r.file == "app/UseTest.java"), "{refs:?}");
    }

    #[test]
    fn a_jdk_style_receiver_is_treated_as_external() {
        // `System` is unresolvable and shaped like a type, so `System.out.println`
        // must not land on this project's own `println`.
        let (dir, repo, rels, _lock) = fixture(&[
            ("Logger.java", "class Logger {\n    void println(String s) {}\n}\n"),
            (
                "Use.java",
                "class Use {\n    void run() {\n        System.out.println(\"x\");\n    }\n}\n",
            ),
        ]);
        let defs = def_at(&repo, dir.path(), &rels, &sym("println", "Use.java", 3, 19));
        assert!(defs.is_empty(), "got {defs:?}");
    }

    #[test]
    fn references_drop_calls_proven_to_be_external() {
        let (dir, repo, rels, _lock) = fixture(&[
            ("Painter.java", "class Painter {\n    void render() {}\n}\n"),
            (
                "Holder.java",
                "class Holder {\n    Widget widget;\n    void run() {\n        widget.render();\n    }\n}\n",
            ),
        ]);
        let refs = find_references(
            &repo,
            dir.path(),
            &ProjectSource::Worktree,
            &rels,
            &sym("render", "Painter.java", 2, 9),
        )
        .unwrap();
        assert!(
            !refs.iter().any(|r| r.file == "Holder.java"),
            "widget.render() belongs to a type we don't have — provably not this one"
        );
    }

    #[test]
    fn confirmed_references_rank_above_unconfirmed() {
        let (dir, repo, rels, _lock) = fixture(&[
            ("Dog.java", "class Dog {\n    void speak() {}\n}\n"),
            (
                "Zoo.java",
                "class Zoo {\n    void run() {\n        var a = new Dog();\n        a.speak();\n    }\n}\n",
            ),
            (
                "Aviary.java",
                "class Aviary {\n    void run() {\n        Dog b = new Dog();\n        b.speak();\n    }\n}\n",
            ),
        ]);
        let root = dir.path();

        let refs = find_references(
            &repo,
            root,
            &ProjectSource::Worktree,
            &rels,
            &sym("speak", "Dog.java", 2, 9),
        )
        .unwrap();

        let first_unconfirmed = refs.iter().position(|r| !r.confirmed);
        let last_confirmed = refs.iter().rposition(|r| r.confirmed);
        if let (Some(first), Some(last)) = (first_unconfirmed, last_confirmed) {
            assert!(last < first, "every confirmed hit sorts before any unconfirmed");
        }
    }
}
