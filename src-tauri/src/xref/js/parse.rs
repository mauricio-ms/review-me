//! Reading a file into a tree, and the facts about its top level that resolution keeps
//! asking for: what it imports, exports and declares, and every module it names.

use std::collections::HashMap;

use tree_sitter::{Language, Node, Parser, Tree};

use super::sfc::{self, Template};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Grammar {
    Ts,
    Tsx,
    Js,
}

impl Grammar {
    pub fn language(self) -> Language {
        match self {
            Grammar::Ts => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Grammar::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Grammar::Js => tree_sitter_javascript::LANGUAGE.into(),
        }
    }
}

/// The grammar a script file reads with; `None` for anything else.
pub fn script_grammar(rel: &str) -> Option<Grammar> {
    let ext = rel.rsplit_once('.')?.1;
    Some(match ext {
        "ts" | "mts" | "cts" => Grammar::Ts,
        "tsx" => Grammar::Tsx,
        "js" | "jsx" | "mjs" | "cjs" => Grammar::Js,
        _ => return None,
    })
}

/// A local name an import binds.
#[derive(Debug, Clone)]
pub struct Import {
    pub spec: String,
    pub kind: ImportKind,
    /// Where the local name is written.
    pub local_byte: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportKind {
    /// `import { name }`, `import { name as local }`, `const { name } = require(..)`.
    Named(String),
    /// `import local from`.
    Default,
    /// The module itself: `import * as local`, `const local = require(..)`,
    /// `import local = require(..)`.
    Namespace,
}

/// What an exported name stands for.
#[derive(Debug, Clone)]
pub enum ExportTarget {
    /// A declaration in this file, by where its name is written.
    Decl(usize),
    /// A top-level binding of this file, by name — perhaps an import.
    Local(String),
    /// `export { name } from 'spec'`.
    From { spec: String, name: String },
    /// `export * as x from 'spec'`.
    Namespace(String),
    /// An anonymous value: `export default { .. }`, by where it starts.
    Expr(usize),
}

#[derive(Debug, Default)]
pub struct ModuleInfo {
    /// Whether the file is a module (imports or exports, ES or CommonJS) rather than a
    /// script, whose top-level declarations are global.
    pub is_module: bool,
    /// Local name → the import that binds it.
    pub imports: HashMap<String, Import>,
    pub exports: HashMap<String, ExportTarget>,
    /// `export * from 'spec'`.
    pub stars: Vec<String>,
    /// Top-level declarations by name (imports aside): where each name is written.
    pub top: HashMap<String, Vec<usize>>,
    /// Declarations visible everywhere: `declare global { .. }`, and a script's top level.
    pub globals: HashMap<String, Vec<usize>>,
    /// Every module specifier written — imports, re-exports, `require`, `import()` —
    /// by where its text starts.
    pub sources: Vec<(usize, String)>,
}

pub struct Parsed {
    /// The text the tree was parsed from when it isn't the file's own: a single-file
    /// component's script and template expressions, laid out at their own offsets.
    pub code: Option<String>,
    pub tree: Tree,
    pub module: ModuleInfo,
    pub template: Template,
    /// Whether the file is TypeScript, whose types make a miss on a fully visible
    /// declaration proof the member comes from elsewhere.
    pub typed: bool,
}

impl Parsed {
    pub fn code<'a>(&'a self, source: &'a str) -> &'a str {
        self.code.as_deref().unwrap_or(source)
    }
}

/// Parse a script or single-file component. `None` for anything else.
pub fn parse(rel: &str, source: &str) -> Option<Parsed> {
    let (grammar, code, template) = match script_grammar(rel) {
        Some(g) => (g, None, Template::default()),
        None => {
            let doc = sfc::virtual_doc(rel, source)?;
            (doc.grammar, Some(doc.code), doc.template)
        }
    };
    let mut parser = Parser::new();
    parser.set_language(&grammar.language()).ok()?;
    let text = code.as_deref().unwrap_or(source);
    let tree = parser.parse(text, None)?;
    let module = module_info(tree.root_node(), text, rel.ends_with(".d.ts"));
    Some(Parsed {
        typed: grammar != Grammar::Js,
        code,
        tree,
        module,
        template,
    })
}

pub fn text<'a>(node: Node, code: &'a str) -> &'a str {
    &code[node.byte_range()]
}

/// A string literal's contents (`'./x'` → `./x`), empty for `''`.
pub fn string_value<'a>(node: Node, code: &'a str) -> &'a str {
    let mut cur = node.walk();
    let found = node
        .named_children(&mut cur)
        .find(|c| c.kind() == "string_fragment")
        .map(|c| text(c, code))
        .unwrap_or("");
    found
}

/// Where a string literal's contents start (just inside the quote).
fn string_start(node: Node) -> usize {
    node.start_byte() + 1
}

/// The names a declaration statement introduces, by their name nodes.
pub fn declared_names<'t>(decl: Node<'t>) -> Vec<Node<'t>> {
    match decl.kind() {
        "lexical_declaration" | "variable_declaration" => {
            let mut out = Vec::new();
            let mut cur = decl.walk();
            for d in decl.named_children(&mut cur) {
                if d.kind() == "variable_declarator" {
                    if let Some(name) = d.child_by_field_name("name") {
                        pattern_bindings(name, &mut out);
                    }
                }
            }
            out
        }
        "function_declaration" | "generator_function_declaration" | "function_signature"
        | "class_declaration" | "abstract_class_declaration" | "interface_declaration"
        | "type_alias_declaration" | "enum_declaration" | "internal_module" => decl
            .child_by_field_name("name")
            .filter(|n| n.kind() != "string")
            .into_iter()
            .collect(),
        "ambient_declaration" | "expression_statement" => {
            let mut cur = decl.walk();
            let found = decl
                .named_children(&mut cur)
                .flat_map(|c| declared_names(c))
                .collect();
            found
        }
        "export_statement" => decl
            .child_by_field_name("declaration")
            .map(declared_names)
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// The identifiers a binding pattern binds: `{ a, b: [c], ...d }` → a, c, d.
pub fn pattern_bindings<'t>(pattern: Node<'t>, out: &mut Vec<Node<'t>>) {
    match pattern.kind() {
        "identifier" | "shorthand_property_identifier_pattern" => out.push(pattern),
        "pair_pattern" => {
            if let Some(v) = pattern.child_by_field_name("value") {
                pattern_bindings(v, out);
            }
        }
        "assignment_pattern" | "object_assignment_pattern" => {
            if let Some(l) = pattern.child_by_field_name("left") {
                pattern_bindings(l, out);
            }
        }
        "required_parameter" | "optional_parameter" => {
            if let Some(p) = pattern.child_by_field_name("pattern") {
                pattern_bindings(p, out);
            }
        }
        "object_pattern" | "array_pattern" | "rest_pattern" | "formal_parameters" => {
            let mut cur = pattern.walk();
            for c in pattern.named_children(&mut cur) {
                pattern_bindings(c, out);
            }
        }
        _ => {}
    }
}

/// `require('x')` or `import('x')`: the string it names.
pub fn required<'t>(call: Node<'t>, code: &str) -> Option<Node<'t>> {
    if call.kind() != "call_expression" {
        return None;
    }
    let f = call.child_by_field_name("function")?;
    let is_require = (f.kind() == "identifier" && text(f, code) == "require") || f.kind() == "import";
    if !is_require {
        return None;
    }
    let args = call.child_by_field_name("arguments")?;
    let first = args.named_child(0)?;
    (first.kind() == "string").then_some(first)
}

/// The top-level facts of a parsed file.
pub fn module_info(root: Node, code: &str, declaration_file: bool) -> ModuleInfo {
    let mut m = ModuleInfo::default();
    let mut cur = root.walk();
    for stmt in root.named_children(&mut cur) {
        match stmt.kind() {
            "import_statement" => {
                m.is_module = true;
                import_statement(stmt, code, &mut m);
            }
            "export_statement" => {
                m.is_module = true;
                export_statement(stmt, code, &mut m);
            }
            "lexical_declaration" | "variable_declaration" => {
                let mut dc = stmt.walk();
                for d in stmt.named_children(&mut dc) {
                    if d.kind() != "variable_declarator" {
                        continue;
                    }
                    if require_declarator(d, code, &mut m) {
                        m.is_module = true;
                        continue;
                    }
                    if let Some(name) = d.child_by_field_name("name") {
                        let mut names = Vec::new();
                        pattern_bindings(name, &mut names);
                        for n in names {
                            add(&mut m.top, text(n, code), n.start_byte());
                        }
                    }
                }
            }
            "ambient_declaration" => {
                let mut ac = stmt.walk();
                let global = stmt.children(&mut ac).any(|c| c.kind() == "global");
                if global {
                    let mut bc = stmt.walk();
                    for block in stmt.named_children(&mut bc).filter(|c| c.kind() == "statement_block") {
                        let mut sc = block.walk();
                        for inner in block.named_children(&mut sc) {
                            for n in declared_names(inner) {
                                add(&mut m.globals, text(n, code), n.start_byte());
                            }
                        }
                    }
                } else {
                    for n in declared_names(stmt) {
                        add(&mut m.top, text(n, code), n.start_byte());
                    }
                }
            }
            "expression_statement" => {
                if cjs_export(stmt, code, &mut m) {
                    m.is_module = true;
                } else {
                    for n in declared_names(stmt) {
                        add(&mut m.top, text(n, code), n.start_byte());
                    }
                }
            }
            _ => {
                for n in declared_names(stmt) {
                    add(&mut m.top, text(n, code), n.start_byte());
                }
            }
        }
    }
    // Every `require(..)` and `import(..)`, wherever it is.
    collect_requires(root, code, &mut m.sources);
    if !m.is_module || (declaration_file && m.imports.is_empty() && m.exports.is_empty() && m.stars.is_empty()) {
        for (name, bytes) in &m.top {
            for &b in bytes {
                add(&mut m.globals, name, b);
            }
        }
    }
    m
}

fn add(map: &mut HashMap<String, Vec<usize>>, name: &str, byte: usize) {
    map.entry(name.to_string()).or_default().push(byte);
}

fn import_statement(stmt: Node, code: &str, m: &mut ModuleInfo) {
    let Some(source) = stmt.child_by_field_name("source") else {
        // `import x = require('y')`.
        let mut cur = stmt.walk();
        for c in stmt.named_children(&mut cur) {
            if c.kind() == "import_require_clause" {
                if let (Some(local), Some(src)) = (c.named_child(0), c.child_by_field_name("source")) {
                    let spec = string_value(src, code).to_string();
                    m.sources.push((string_start(src), spec.clone()));
                    m.imports.insert(
                        text(local, code).to_string(),
                        Import { spec, kind: ImportKind::Namespace, local_byte: local.start_byte() },
                    );
                }
            }
        }
        return;
    };
    let spec = string_value(source, code).to_string();
    m.sources.push((string_start(source), spec.clone()));
    let mut cur = stmt.walk();
    for clause in stmt.named_children(&mut cur) {
        match clause.kind() {
            "import_clause" => {
                let mut cc = clause.walk();
                for part in clause.named_children(&mut cc) {
                    match part.kind() {
                        "identifier" => {
                            m.imports.insert(
                                text(part, code).to_string(),
                                Import { spec: spec.clone(), kind: ImportKind::Default, local_byte: part.start_byte() },
                            );
                        }
                        "namespace_import" => {
                            if let Some(local) = part.named_child(0) {
                                m.imports.insert(
                                    text(local, code).to_string(),
                                    Import { spec: spec.clone(), kind: ImportKind::Namespace, local_byte: local.start_byte() },
                                );
                            }
                        }
                        "named_imports" => {
                            let mut sc = part.walk();
                            for s in part.named_children(&mut sc).filter(|s| s.kind() == "import_specifier") {
                                let Some(name) = s.child_by_field_name("name") else {
                                    continue;
                                };
                                let local = s.child_by_field_name("alias").unwrap_or(name);
                                let imported = name_text(name, code);
                                let kind = if imported == "default" {
                                    ImportKind::Default
                                } else {
                                    ImportKind::Named(imported.to_string())
                                };
                                m.imports.insert(
                                    name_text(local, code).to_string(),
                                    Import { spec: spec.clone(), kind, local_byte: local.start_byte() },
                                );
                            }
                        }
                        _ => {}
                    }
                }
            }
            "import_require_clause" => {
                if let Some(local) = clause.named_child(0) {
                    m.imports.insert(
                        text(local, code).to_string(),
                        Import { spec: spec.clone(), kind: ImportKind::Namespace, local_byte: local.start_byte() },
                    );
                }
            }
            _ => {}
        }
    }
}

/// An identifier's text, or a string's contents (`import { "a-b" as c }`).
fn name_text<'a>(node: Node, code: &'a str) -> &'a str {
    if node.kind() == "string" {
        string_value(node, code)
    } else {
        text(node, code)
    }
}

fn export_statement(stmt: Node, code: &str, m: &mut ModuleInfo) {
    let source = stmt.child_by_field_name("source");
    let spec = source.map(|s| string_value(s, code).to_string());
    if let (Some(s), Some(spec)) = (source, &spec) {
        m.sources.push((string_start(s), spec.clone()));
    }
    let mut cur = stmt.walk();
    let is_default = stmt.children(&mut cur).any(|c| c.kind() == "default");

    if let Some(decl) = stmt.child_by_field_name("declaration") {
        let names = declared_names(decl);
        for n in &names {
            add(&mut m.top, text(*n, code), n.start_byte());
            if !is_default {
                m.exports.insert(text(*n, code).to_string(), ExportTarget::Decl(n.start_byte()));
            }
        }
        if is_default {
            let target = match names.first() {
                Some(n) => ExportTarget::Decl(n.start_byte()),
                None => ExportTarget::Expr(decl.start_byte()),
            };
            m.exports.insert("default".into(), target);
        }
        return;
    }
    if let Some(value) = stmt.child_by_field_name("value") {
        let target = match value.kind() {
            "identifier" => ExportTarget::Local(text(value, code).to_string()),
            // `export default function named() {}` parsed as an expression still names it.
            "function_expression" | "class" | "generator_function" => match value.child_by_field_name("name") {
                Some(n) => ExportTarget::Decl(n.start_byte()),
                None => ExportTarget::Expr(value.start_byte()),
            },
            _ => ExportTarget::Expr(value.start_byte()),
        };
        m.exports.insert("default".into(), target);
        return;
    }
    let mut cur = stmt.walk();
    let mut clause_seen = false;
    for c in stmt.named_children(&mut cur) {
        match c.kind() {
            "export_clause" => {
                clause_seen = true;
                let mut sc = c.walk();
                for s in c.named_children(&mut sc).filter(|s| s.kind() == "export_specifier") {
                    let Some(name) = s.child_by_field_name("name") else {
                        continue;
                    };
                    let local = name_text(name, code).to_string();
                    let exported = s
                        .child_by_field_name("alias")
                        .map(|a| name_text(a, code).to_string())
                        .unwrap_or_else(|| local.clone());
                    let target = match &spec {
                        Some(spec) => ExportTarget::From { spec: spec.clone(), name: local },
                        None => ExportTarget::Local(local),
                    };
                    m.exports.insert(exported, target);
                }
            }
            "namespace_export" => {
                clause_seen = true;
                if let (Some(n), Some(spec)) = (c.named_child(0), &spec) {
                    m.exports.insert(name_text(n, code).to_string(), ExportTarget::Namespace(spec.clone()));
                }
            }
            // `export = Foo`.
            "identifier" if spec.is_none() => {
                clause_seen = true;
                m.exports.insert("default".into(), ExportTarget::Local(text(c, code).to_string()));
            }
            _ => {}
        }
    }
    if !clause_seen {
        if let Some(spec) = spec {
            m.stars.push(spec);
        }
    }
}

/// `const x = require('m')` / `const { a, b: c } = require('m')`: imports, not
/// declarations. Whether it was one.
fn require_declarator(d: Node, code: &str, m: &mut ModuleInfo) -> bool {
    let (Some(name), Some(value)) = (d.child_by_field_name("name"), d.child_by_field_name("value")) else {
        return false;
    };
    // `require('m').thing` names one export.
    let (call, member) = match value.kind() {
        "member_expression" => match (value.child_by_field_name("object"), value.child_by_field_name("property")) {
            (Some(o), Some(p)) => (o, Some(text(p, code).to_string())),
            _ => return false,
        },
        _ => (value, None),
    };
    let Some(src) = required(call, code) else {
        return false;
    };
    if call.child_by_field_name("function").is_some_and(|f| f.kind() == "import") {
        return false;
    }
    let spec = string_value(src, code).to_string();
    match name.kind() {
        "identifier" => {
            let kind = match member {
                Some(member) => ImportKind::Named(member),
                None => ImportKind::Namespace,
            };
            m.imports.insert(
                text(name, code).to_string(),
                Import { spec, kind, local_byte: name.start_byte() },
            );
        }
        "object_pattern" if member.is_none() => {
            let mut cur = name.walk();
            for p in name.named_children(&mut cur) {
                let (imported, local) = match p.kind() {
                    "shorthand_property_identifier_pattern" => (p, p),
                    "pair_pattern" => match (p.child_by_field_name("key"), p.child_by_field_name("value")) {
                        (Some(k), Some(v)) if v.kind() == "identifier" => (k, v),
                        _ => continue,
                    },
                    _ => continue,
                };
                m.imports.insert(
                    text(local, code).to_string(),
                    Import {
                        spec: spec.clone(),
                        kind: ImportKind::Named(text(imported, code).to_string()),
                        local_byte: local.start_byte(),
                    },
                );
            }
        }
        _ => return false,
    }
    true
}

/// `module.exports = ..`, `module.exports.x = ..`, `exports.x = ..`. Whether it was one.
fn cjs_export(stmt: Node, code: &str, m: &mut ModuleInfo) -> bool {
    let Some(assign) = stmt.named_child(0).filter(|a| a.kind() == "assignment_expression") else {
        return false;
    };
    let (Some(left), Some(right)) = (assign.child_by_field_name("left"), assign.child_by_field_name("right")) else {
        return false;
    };
    let target_of = |right: Node| match right.kind() {
        "identifier" => ExportTarget::Local(text(right, code).to_string()),
        _ => ExportTarget::Expr(right.start_byte()),
    };
    match text(left, code) {
        "module.exports" => {
            m.exports.insert("default".into(), target_of(right));
            if right.kind() == "object" {
                let mut cur = right.walk();
                for prop in right.named_children(&mut cur) {
                    match prop.kind() {
                        "shorthand_property_identifier" => {
                            let name = text(prop, code).to_string();
                            m.exports.insert(name.clone(), ExportTarget::Local(name));
                        }
                        "pair" => {
                            if let (Some(k), Some(v)) = (prop.child_by_field_name("key"), prop.child_by_field_name("value")) {
                                let target = match v.kind() {
                                    "identifier" => ExportTarget::Local(text(v, code).to_string()),
                                    _ => ExportTarget::Decl(k.start_byte()),
                                };
                                m.exports.insert(name_text(k, code).to_string(), target);
                            }
                        }
                        "method_definition" => {
                            if let Some(k) = prop.child_by_field_name("name") {
                                m.exports.insert(text(k, code).to_string(), ExportTarget::Decl(k.start_byte()));
                            }
                        }
                        _ => {}
                    }
                }
            }
            true
        }
        l if l.starts_with("module.exports.") || l.starts_with("exports.") => {
            let Some(prop) = left.child_by_field_name("property") else {
                return false;
            };
            let target = match right.kind() {
                "identifier" => ExportTarget::Local(text(right, code).to_string()),
                _ => ExportTarget::Decl(prop.start_byte()),
            };
            m.exports.insert(text(prop, code).to_string(), target);
            true
        }
        _ => false,
    }
}

fn collect_requires(node: Node, code: &str, out: &mut Vec<(usize, String)>) {
    let mut cur = node.walk();
    let mut stack = vec![node];
    while let Some(n) = stack.pop() {
        if let Some(src) = required(n, code) {
            let entry = (string_start(src), string_value(src, code).to_string());
            if !out.contains(&entry) {
                out.push(entry);
            }
        }
        for c in n.named_children(&mut cur) {
            stack.push(c);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(rel: &str, src: &str) -> ModuleInfo {
        parse(rel, src).unwrap().module
    }

    #[test]
    fn reads_imports_exports_and_declarations() {
        let m = info(
            "a.ts",
            "import D, { a, b as c } from './x';\nimport * as ns from './y';\nexport { d, e as f } from './z';\nexport * from './w';\nexport * as g from './v';\nexport default function foo() {}\nexport const h = 1, [i] = arr;\nexport class K {}\ninterface I {}\nconst local = 1;\nexport { local as renamed };\n",
        );
        assert!(m.is_module);
        assert_eq!(m.imports["D"].kind, ImportKind::Default);
        assert_eq!(m.imports["a"].kind, ImportKind::Named("a".into()));
        assert_eq!(m.imports["c"].kind, ImportKind::Named("b".into()));
        assert_eq!(m.imports["ns"].kind, ImportKind::Namespace);
        assert!(matches!(&m.exports["d"], ExportTarget::From { spec, name } if spec == "./z" && name == "d"));
        assert!(matches!(&m.exports["f"], ExportTarget::From { name, .. } if name == "e"));
        assert!(matches!(&m.exports["g"], ExportTarget::Namespace(spec) if spec == "./v"));
        assert!(matches!(m.exports["default"], ExportTarget::Decl(_)));
        assert!(matches!(m.exports["h"], ExportTarget::Decl(_)));
        assert!(matches!(m.exports["i"], ExportTarget::Decl(_)));
        assert!(matches!(&m.exports["renamed"], ExportTarget::Local(l) if l == "local"));
        assert_eq!(m.stars, vec!["./w".to_string()]);
        for name in ["foo", "h", "i", "K", "I", "local"] {
            assert!(m.top.contains_key(name), "{name} is declared at the top");
        }
        let specs: Vec<&str> = m.sources.iter().map(|(_, s)| s.as_str()).collect();
        assert_eq!(specs, vec!["./x", "./y", "./z", "./w", "./v"]);
        assert!(m.globals.is_empty());
    }

    #[test]
    fn reads_commonjs() {
        let m = info(
            "a.js",
            "const fs = require('fs');\nconst { join, resolve: res } = require('path');\nconst one = require('./m').one;\nfunction helper() {}\nmodule.exports = { helper, other: 1 };\nexports.extra = () => 2;\n",
        );
        assert!(m.is_module);
        assert_eq!(m.imports["fs"].kind, ImportKind::Namespace);
        assert_eq!(m.imports["join"].kind, ImportKind::Named("join".into()));
        assert_eq!(m.imports["res"].kind, ImportKind::Named("resolve".into()));
        assert_eq!(m.imports["one"].kind, ImportKind::Named("one".into()));
        assert!(matches!(&m.exports["helper"], ExportTarget::Local(l) if l == "helper"));
        assert!(matches!(m.exports["other"], ExportTarget::Decl(_)));
        assert!(matches!(m.exports["extra"], ExportTarget::Decl(_)));
        assert!(matches!(m.exports["default"], ExportTarget::Expr(_)));
    }

    #[test]
    fn scripts_and_global_declarations_are_global() {
        let script = info("legacy.js", "function util() {}\nvar config = {};\n");
        assert!(!script.is_module);
        assert!(script.globals.contains_key("util") && script.globals.contains_key("config"));

        let dts = info(
            "env.d.ts",
            "export {};\ndeclare global {\n  interface Window { app: App }\n  const VERSION: string;\n}\n",
        );
        assert!(dts.globals.contains_key("Window") && dts.globals.contains_key("VERSION"));

        let ambient = info("globals.d.ts", "declare const API_URL: string;\ninterface Theme { dark: boolean }\n");
        assert!(ambient.globals.contains_key("API_URL") && ambient.globals.contains_key("Theme"));
    }
}
