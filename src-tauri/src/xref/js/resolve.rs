//! What a name refers to. Everything hangs off [`JsIndex::resolve`]: a name used in a
//! scope resolves through local scopes, the module's top level (an import leads on into
//! the module it names, through re-exports), then the project's globals; a member
//! (`a.b`, `A.B`) resolves on the type of what's left of the dot, worked out from
//! declarations — annotations, `new`, declared return types, object literals — never by
//! inference a compiler would do.

use tree_sitter::Node;

use super::builtins;
use super::parse::{required, string_value, text, ExportTarget, Import, ImportKind};
use super::project::ModuleRes;
use super::scope::{self, in_space, Space};
use super::JsIndex;

/// Depth cap for the mutually recursive walks (types, exports, members).
const MAX_DEPTH: usize = 24;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    /// A declaration (or an anonymous default export), by where it's written.
    Decl { file: usize, byte: usize },
    /// A module as a whole: an indexed file, or any other (a stylesheet, an image).
    File(String),
}

#[derive(Debug)]
pub enum Resolution {
    Found(Target),
    /// Several candidates, none provably right — this is what surfaces a picker.
    Ambiguous(Vec<Target>),
    /// Something outside the project: a package, the runtime, the DOM. Nothing declared
    /// here is the answer, so no fallback, and references drop it.
    External,
    /// Genuinely undecidable: an inferred type, an alias we couldn't read, a member of
    /// something we can't see. A name match is still the best guess.
    Unresolved,
}

pub fn finish(mut hits: Vec<Target>) -> Resolution {
    hits.dedup();
    match hits.len() {
        0 => Resolution::Unresolved,
        1 => Resolution::Found(hits.pop().unwrap()),
        _ => Resolution::Ambiguous(hits),
    }
}

/// What a module specifier leads to, from the index's point of view.
pub enum Module {
    Indexed(usize),
    Other(String),
    External,
    Unresolved,
}

/// The type of an expression, as far as declarations say.
#[derive(Clone)]
pub(super) enum Ty<'a> {
    /// A class: its instances' members, or (`instance: false`) its static ones.
    Class { file: usize, decl: Node<'a>, instance: bool },
    /// Members by declaration: an interface, an object type or literal, an enum, a
    /// namespace.
    Shape { file: usize, node: Node<'a> },
    /// A module's exports.
    Module(usize),
    /// An intersection: the members of all of them.
    All(Vec<Ty<'a>>),
    /// A union: a member is any variant's that declares it — the one a narrowed
    /// discriminated union means, or all of them for the discriminant itself.
    Any(Vec<Ty<'a>>),
    Promise(Box<Ty<'a>>),
    /// `T[]`, `Array<T>`: its own members are the runtime's, its elements a `T`.
    Array(Box<Ty<'a>>),
    /// `[A, B]`, and what `useState` returns.
    Tuple(Vec<Ty<'a>>),
    /// A library's wrapper whose one member holds the value: a ref's `.current` or
    /// `.value`.
    Boxed { key: &'static str, inner: Box<Ty<'a>> },
    External,
    Unknown,
}

pub(super) enum Member {
    Hits(Vec<Target>),
    External,
    /// Not there: provably (`complete`), or not as far as we can see.
    Missing { complete: bool },
}

impl JsIndex {
    pub fn module(&self, from: usize, spec: &str) -> Module {
        match self.project.resolve(&self.files[from].rel, spec) {
            ModuleRes::File(rel) => match self.file_index.get(&rel) {
                Some(&fi) => Module::Indexed(fi),
                None => Module::Other(rel),
            },
            ModuleRes::External => Module::External,
            ModuleRes::Unresolved => Module::Unresolved,
        }
    }

    fn module_resolution(&self, from: usize, spec: &str) -> Resolution {
        match self.module(from, spec) {
            Module::Indexed(fi) => Resolution::Found(Target::File(self.files[fi].rel.clone())),
            Module::Other(rel) => Resolution::Found(Target::File(rel)),
            Module::External => Resolution::External,
            Module::Unresolved => Resolution::Unresolved,
        }
    }

    /// What the name at `node` refers to.
    pub fn resolve<'a>(&'a self, file: usize, node: Node<'a>) -> Resolution {
        self.resolve_at(file, node, 0)
    }

    fn resolve_at<'a>(&'a self, file: usize, node: Node<'a>, depth: usize) -> Resolution {
        if depth > MAX_DEPTH {
            return Resolution::Unresolved;
        }
        let Some(parsed) = self.parsed(file) else {
            return Resolution::Unresolved;
        };
        let code = self.code(file);
        let name = text(node, code);

        if matches!(node.kind(), "string_fragment" | "string") {
            let s = if node.kind() == "string" { Some(node) } else { node.parent() };
            return match s.filter(|s| is_module_source(*s, code)) {
                Some(s) => {
                    // `templateUrl: 'hero.component.html'` is relative, `./` or not.
                    let spec = string_value(s, code);
                    let spec = if is_module_specifier(s, code) || spec.starts_with('.') {
                        spec.to_string()
                    } else {
                        format!("./{spec}")
                    };
                    self.module_resolution(file, &spec)
                }
                None => Resolution::Unresolved,
            };
        }
        let Some(parent) = node.parent() else {
            return Resolution::Unresolved;
        };
        let is_field = |field: &str| parent.child_by_field_name(field).map(|n| n.id()) == Some(node.id());

        match parent.kind() {
            "import_specifier" => {
                let local = parent.child_by_field_name("alias").unwrap_or(node);
                let local = local_name(local, code);
                return match parsed.module.imports.get(local) {
                    Some(imp) => self.resolve_import(file, imp, depth + 1),
                    None => Resolution::Unresolved,
                };
            }
            "import_clause" | "namespace_import" | "import_require_clause" => {
                if let Some(imp) = parsed.module.imports.get(name) {
                    return self.resolve_import(file, imp, depth + 1);
                }
            }
            "export_specifier" => {
                let Some(local) = parent.child_by_field_name("name") else {
                    return Resolution::Unresolved;
                };
                let local = local_name(local, code);
                let stmt = parent.parent().and_then(|c| c.parent());
                return match stmt.and_then(|s| s.child_by_field_name("source")) {
                    Some(src) => match self.module(file, string_value(src, code)) {
                        Module::Indexed(fi) => self.resolve_export(fi, local, depth + 1, &mut Vec::new()),
                        Module::Other(rel) => Resolution::Found(Target::File(rel)),
                        Module::External => Resolution::External,
                        Module::Unresolved => Resolution::Unresolved,
                    },
                    None => self.resolve_local_export(file, local, depth + 1),
                };
            }
            "member_expression" if is_field("property") => {
                let Some(object) = parent.child_by_field_name("object") else {
                    return Resolution::Unresolved;
                };
                return self.resolve_member_of(file, object, name, depth + 1);
            }
            "nested_type_identifier" if is_field("name") => {
                let Some(object) = parent.child_by_field_name("module") else {
                    return Resolution::Unresolved;
                };
                return self.resolve_member_of(file, object, name, depth + 1);
            }
            "nested_identifier" if parent.named_child(parent.named_child_count().saturating_sub(1)).map(|n| n.id()) == Some(node.id()) => {
                let Some(object) = parent.named_child(0) else {
                    return Resolution::Unresolved;
                };
                return self.resolve_member_of(file, object, name, depth + 1);
            }
            "jsx_attribute" if parent.named_child(0).map(|n| n.id()) == Some(node.id()) => {
                return self.resolve_prop(file, parent, name, depth + 1);
            }
            "jsx_opening_element" | "jsx_self_closing_element" | "jsx_closing_element"
                if is_field("name") && name.starts_with(|c: char| c.is_ascii_lowercase()) =>
            {
                // `<div>`: an intrinsic element.
                return Resolution::External;
            }
            "jsx_namespace_name" => return Resolution::External,
            "pair_pattern" if is_field("key") => {
                return self.resolve_destructured(file, parent, name, depth + 1);
            }
            _ => {}
        }

        if scope::is_declaration_name(node) {
            // `const x = require('./m')` binds an import: it leads on into the module.
            if let Some(imp) = parsed.module.imports.get(name).filter(|i| i.local_byte == node.start_byte()) {
                return self.resolve_import(file, imp, depth + 1);
            }
            return Resolution::Found(Target::Decl { file, byte: node.start_byte() });
        }

        match node.kind() {
            "identifier" | "shorthand_property_identifier" => {
                self.resolve_name(file, node, name, Space::Value, depth + 1)
            }
            "type_identifier" => self.resolve_name(file, node, name, Space::Type, depth + 1),
            _ => Resolution::Unresolved,
        }
    }

    /// A name used at `node`: local scopes, the template, the module's top, the globals.
    pub fn resolve_name<'a>(&'a self, file: usize, node: Node<'a>, name: &str, space: Space, depth: usize) -> Resolution {
        let code = self.code(file);
        if let Some(decl) = scope::find_local(node, code, name, space) {
            return Resolution::Found(Target::Decl { file, byte: decl.start_byte() });
        }
        if let Some(parsed) = self.parsed(file) {
            if let Some(b) = parsed.template.binding(name, node.start_byte()) {
                return Resolution::Found(Target::Decl { file, byte: b.byte });
            }
        }
        // An Angular template sees its component's members, not the module around it.
        if let Some(found) = self.resolve_angular_name(file, node, name, depth) {
            return found;
        }
        if let Some(found) = self.resolve_top(file, name, space, depth) {
            return found;
        }
        if let Some(found) = self.resolve_template_name(file, node, name, depth) {
            return found;
        }
        self.resolve_global(file, name, space, depth)
    }

    /// A name at the top of `file`: an import, or a declaration in `space`.
    pub(super) fn resolve_top(&self, file: usize, name: &str, space: Space, depth: usize) -> Option<Resolution> {
        let m = &self.parsed(file)?.module;
        if let Some(imp) = m.imports.get(name) {
            return Some(self.resolve_import(file, imp, depth + 1));
        }
        let nodes: Vec<Node> = m
            .top
            .get(name)?
            .iter()
            .filter_map(|&b| self.node_at(file, b))
            .filter(|n| in_space(*n, space))
            .collect();
        // An overloaded function: its implementation over its signatures.
        let pick = nodes
            .iter()
            .find(|n| n.parent().is_some_and(|p| p.kind() != "function_signature"))
            .or(nodes.first())?;
        Some(Resolution::Found(Target::Decl { file, byte: pick.start_byte() }))
    }

    /// `export { local }` with no `from`: the top-level binding, value or type.
    fn resolve_local_export(&self, file: usize, local: &str, depth: usize) -> Resolution {
        self.resolve_top(file, local, Space::Value, depth)
            .or_else(|| self.resolve_top(file, local, Space::Type, depth))
            .unwrap_or(Resolution::Unresolved)
    }

    pub fn resolve_import(&self, file: usize, imp: &Import, depth: usize) -> Resolution {
        if depth > MAX_DEPTH {
            return Resolution::Unresolved;
        }
        if let Some(found) = self.virtual_import(file, imp, depth) {
            return found;
        }
        match self.module(file, &imp.spec) {
            Module::Indexed(fi) => match &imp.kind {
                ImportKind::Named(n) => self.resolve_export(fi, n, depth + 1, &mut Vec::new()),
                ImportKind::Default => self.resolve_export(fi, "default", depth + 1, &mut Vec::new()),
                ImportKind::Namespace => Resolution::Found(Target::File(self.files[fi].rel.clone())),
            },
            Module::Other(rel) => Resolution::Found(Target::File(rel)),
            Module::External => Resolution::External,
            Module::Unresolved => Resolution::Unresolved,
        }
    }

    /// What module `file` exports as `name`, through re-exports and `export *`.
    pub fn resolve_export(&self, file: usize, name: &str, depth: usize, seen: &mut Vec<(usize, String)>) -> Resolution {
        if depth > MAX_DEPTH || seen.iter().any(|(f, n)| *f == file && n == name) {
            return Resolution::Unresolved;
        }
        seen.push((file, name.to_string()));
        let Some(parsed) = self.parsed(file) else {
            return Resolution::Unresolved;
        };
        let m = &parsed.module;
        let via = |spec: &str, inner: &dyn Fn(usize, &mut Vec<(usize, String)>) -> Resolution, seen: &mut Vec<(usize, String)>| {
            match self.module(file, spec) {
                Module::Indexed(fi) => inner(fi, seen),
                Module::Other(rel) => Resolution::Found(Target::File(rel)),
                Module::External => Resolution::External,
                Module::Unresolved => Resolution::Unresolved,
            }
        };
        match m.exports.get(name) {
            Some(ExportTarget::Decl(b)) | Some(ExportTarget::Expr(b)) => {
                Resolution::Found(Target::Decl { file, byte: *b })
            }
            Some(ExportTarget::Local(local)) => self.resolve_local_export(file, local, depth + 1),
            Some(ExportTarget::From { spec, name: inner }) => via(
                spec,
                &|fi, seen| self.resolve_export(fi, inner, depth + 1, seen),
                seen,
            ),
            Some(ExportTarget::Namespace(spec)) => via(
                spec,
                &|fi, _| Resolution::Found(Target::File(self.files[fi].rel.clone())),
                seen,
            ),
            None => {
                // A single-file component is its own default export.
                if name == "default" && parsed.component {
                    return Resolution::Found(Target::File(self.files[file].rel.clone()));
                }
                let mut external = false;
                for spec in &m.stars {
                    match self.module(file, spec) {
                        Module::Indexed(fi) => match self.resolve_export(fi, name, depth + 1, seen) {
                            Resolution::Unresolved => {}
                            Resolution::External => external = true,
                            found => return found,
                        },
                        Module::External => external = true,
                        _ => {}
                    }
                }
                if external {
                    Resolution::External
                } else {
                    Resolution::Unresolved
                }
            }
        }
    }

    /// A name no scope of the file declares: a global declaration somewhere in the
    /// project, a framework's convention, the runtime's.
    fn resolve_global(&self, file: usize, name: &str, space: Space, depth: usize) -> Resolution {
        let hits: Vec<Target> = self
            .global_decls(name)
            .into_iter()
            .filter(|t| match t {
                Target::Decl { file, byte } => self.node_at(*file, *byte).is_some_and(|n| in_space(n, space)),
                Target::File(_) => true,
            })
            .collect();
        if hits.len() == 1 {
            // `const ref: typeof import('vue')['ref']` — an auto-import's declaration —
            // leads on to what it imports.
            if let Some(found) = self.follow_type_import(&hits[0], depth) {
                return found;
            }
        }
        if !hits.is_empty() {
            return finish(hits);
        }
        if let Some(found) = self.resolve_convention(file, name, depth) {
            return found;
        }
        if builtins::is_global(name) || space == Space::Type {
            // An undeclared type is a library's: the DOM's, `@types/*`.
            return Resolution::External;
        }
        Resolution::Unresolved
    }

    /// Declarations visible everywhere under `name`, cached by name.
    fn global_decls(&self, name: &str) -> Vec<Target> {
        if let Some(found) = self.globals.borrow().get(name) {
            return found.clone();
        }
        let mut out = Vec::new();
        for (fi, f) in self.files.iter().enumerate() {
            if !f.source.contains(name) {
                continue;
            }
            if let Some(bytes) = self.parsed(fi).and_then(|p| p.module.globals.get(name)) {
                out.extend(bytes.iter().map(|&byte| Target::Decl { file: fi, byte }));
            }
        }
        self.globals.borrow_mut().insert(name.to_string(), out.clone());
        out
    }

    /// The declaration `typeof import('spec')['name']` stands for, when `target` is
    /// declared so.
    fn follow_type_import(&self, target: &Target, depth: usize) -> Option<Resolution> {
        let Target::Decl { file, byte } = target else {
            return None;
        };
        let node = self.node_at(*file, *byte)?;
        let ty = node
            .parent()?
            .child_by_field_name("type")
            .map(|t| if t.kind() == "type_annotation" { t.named_child(0).unwrap_or(t) } else { t })?;
        self.type_import(*file, ty, depth)
    }

    /// `typeof import('spec')['name']`: the export it names.
    pub fn type_import(&self, file: usize, ty: Node, depth: usize) -> Option<Resolution> {
        let code = self.code(file);
        if ty.kind() != "lookup_type" {
            return None;
        }
        let query = ty.named_child(0).filter(|q| q.kind() == "type_query")?;
        let call = query.named_child(0).filter(|c| c.kind() == "call_expression")?;
        let src = required(call, code)?;
        let key = ty.named_child(1).filter(|k| k.kind() == "literal_type")?.named_child(0)?;
        let name = string_value(key, code);
        Some(match self.module(file, string_value(src, code)) {
            Module::Indexed(fi) => self.resolve_export(fi, name, depth + 1, &mut Vec::new()),
            Module::Other(rel) => Resolution::Found(Target::File(rel)),
            Module::External => Resolution::External,
            Module::Unresolved => Resolution::Unresolved,
        })
    }

    /// `object.name`, or `Type.Name`.
    pub fn resolve_member_of<'a>(&'a self, file: usize, object: Node<'a>, name: &str, depth: usize) -> Resolution {
        let ty = self.expr_type(file, object, depth + 1);
        let typed = self.typed(&ty);
        match self.lookup_member(&ty, name, depth + 1) {
            Member::Hits(hits) => finish(hits),
            Member::External => Resolution::External,
            // Everything that could declare it was in view and none does: it's the
            // runtime's (`toString`, `length`) — in TypeScript, which would say so.
            Member::Missing { complete: true } if typed => Resolution::External,
            Member::Missing { .. } => Resolution::Unresolved,
        }
    }

    /// Whether a miss on `ty` is proof: its declarations are TypeScript, closed to
    /// members added on the fly.
    pub(super) fn typed(&self, ty: &Ty) -> bool {
        match ty {
            Ty::Class { file, .. } => self.parsed(*file).is_some_and(|p| p.typed),
            Ty::Shape { file, node } => {
                node.kind() != "object" && self.parsed(*file).is_some_and(|p| p.typed)
            }
            Ty::All(tys) | Ty::Any(tys) => tys.iter().all(|t| self.typed(t)),
            _ => false,
        }
    }

    /// `{ name: alias } = value`: `name` is a member of what the pattern destructures.
    fn resolve_destructured<'a>(&'a self, file: usize, pair: Node<'a>, name: &str, depth: usize) -> Resolution {
        let Some(pattern) = pair.parent().filter(|p| p.kind() == "object_pattern") else {
            return Resolution::Unresolved;
        };
        let owner = self.pattern_type(file, pattern, depth + 1);
        let typed = self.typed(&owner);
        match self.lookup_member(&owner, name, depth + 1) {
            Member::Hits(hits) => finish(hits),
            Member::External => Resolution::External,
            Member::Missing { complete: true } if typed => Resolution::External,
            Member::Missing { .. } => Resolution::Unresolved,
        }
    }

    /// A JSX attribute: the component's prop of that name — a destructured parameter, or
    /// a member of its props type.
    fn resolve_prop<'a>(&'a self, file: usize, attr: Node<'a>, name: &str, depth: usize) -> Resolution {
        let Some(element) = attr.parent() else {
            return Resolution::Unresolved;
        };
        let Some(tag) = element.child_by_field_name("name") else {
            return Resolution::Unresolved;
        };
        let intrinsic =
            tag.kind() == "identifier" && text(tag, self.code(file)).starts_with(|c: char| c.is_ascii_lowercase());
        // `key` and `ref` are React's, whatever the element.
        if intrinsic || matches!(name, "key" | "ref") {
            return Resolution::External;
        }
        let component = match self.resolve_at(file, tag, depth + 1) {
            Resolution::Found(Target::Decl { file, byte }) => (file, byte),
            Resolution::External => return Resolution::External,
            _ => return Resolution::Unresolved,
        };
        let Some(func) = self.node_at(component.0, component.1).and_then(component_function) else {
            return Resolution::Unresolved;
        };
        let cfile = component.0;
        let Some(first) = func
            .child_by_field_name("parameters")
            .and_then(|p| p.named_child(0))
            .or_else(|| func.child_by_field_name("parameter"))
        else {
            return Resolution::Unresolved;
        };
        let pattern = first.child_by_field_name("pattern").unwrap_or(first);
        if pattern.kind() == "object_pattern" {
            let ccode = self.code(cfile);
            let mut cur = pattern.walk();
            for p in pattern.named_children(&mut cur) {
                let key = match p.kind() {
                    "shorthand_property_identifier_pattern" => Some(p),
                    "pair_pattern" => p.child_by_field_name("key"),
                    "object_assignment_pattern" => p.child_by_field_name("left"),
                    _ => None,
                };
                if let Some(k) = key.filter(|k| text(*k, ccode) == name) {
                    return Resolution::Found(Target::Decl { file: cfile, byte: k.start_byte() });
                }
            }
        }
        match first.child_by_field_name("type") {
            Some(ty) => {
                let ty = self.type_of(cfile, ty, depth + 1);
                match self.lookup_member(&ty, name, depth + 1) {
                    Member::Hits(hits) => finish(hits),
                    _ => Resolution::Unresolved,
                }
            }
            None => Resolution::Unresolved,
        }
    }

    // -----------------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------------

    pub(super) fn expr_type<'a>(&'a self, file: usize, node: Node<'a>, depth: usize) -> Ty<'a> {
        if depth > MAX_DEPTH {
            return Ty::Unknown;
        }
        let code = self.code(file);
        match node.kind() {
            "identifier" | "shorthand_property_identifier" => {
                // `React` in `React.UIEvent`: a namespace named in a type, where an undeclared
                // one is a library's like any undeclared type.
                let in_type = node.parent().is_some_and(|p| p.kind() == "nested_type_identifier");
                let space = if in_type { Space::Type } else { Space::Value };
                match self.resolve_name(file, node, text(node, code), space, depth + 1) {
                    Resolution::Found(t) => {
                        let ty = self.target_type(&t, depth + 1);
                        // A Vue template reads refs unwrapped: `count`, not `count.value`.
                        match ty {
                            Ty::Boxed { key: "value", inner } if self.in_vue_template(file, node.start_byte()) => *inner,
                            ty => ty,
                        }
                    }
                    Resolution::External => Ty::External,
                    _ => Ty::Unknown,
                }
            }
            "this" => self.this_type(file, node),
            "super" => match enclosing_class(node).and_then(heritage) {
                Some(h) => match self.expr_type(file, h, depth + 1) {
                    Ty::Class { file, decl, .. } => Ty::Class { file, decl, instance: true },
                    other => other,
                },
                None => Ty::Unknown,
            },
            "member_expression" | "nested_identifier" | "nested_type_identifier" => {
                let (object, prop) = match node.kind() {
                    "member_expression" => (node.child_by_field_name("object"), node.child_by_field_name("property")),
                    "nested_type_identifier" => (node.child_by_field_name("module"), node.child_by_field_name("name")),
                    _ => (node.named_child(0), node.named_child(node.named_child_count().saturating_sub(1))),
                };
                let (Some(object), Some(prop)) = (object, prop) else {
                    return Ty::Unknown;
                };
                let owner = self.expr_type(file, object, depth + 1);
                self.member_type(&owner, text(prop, code), depth + 1)
            }
            "subscript_expression" => {
                let (Some(object), Some(index)) = (node.child_by_field_name("object"), node.child_by_field_name("index")) else {
                    return Ty::Unknown;
                };
                let owner = self.expr_type(file, object, depth + 1);
                match index.kind() {
                    "string" => self.member_type(&owner, string_value(index, code), depth + 1),
                    "number" => index_type(owner, text(index, code).parse().ok()),
                    _ => index_type(owner, None),
                }
            }
            "array" => {
                let first = node.named_child(0).map(|e| self.expr_type(file, e, depth + 1));
                Ty::Array(Box::new(first.unwrap_or(Ty::Unknown)))
            }
            "call_expression" => {
                if let Some(src) = required(node, code) {
                    let module = match self.module(file, string_value(src, code)) {
                        Module::Indexed(fi) => Ty::Module(fi),
                        Module::External => Ty::External,
                        _ => Ty::Unknown,
                    };
                    let dynamic = node.child_by_field_name("function").is_some_and(|f| f.kind() == "import");
                    return if dynamic { Ty::Promise(Box::new(module)) } else { module };
                }
                let Some(callee) = node.child_by_field_name("function") else {
                    return Ty::Unknown;
                };
                let resolved = match callee.kind() {
                    "identifier" => self.resolve_name(file, callee, text(callee, code), Space::Value, depth + 1),
                    "member_expression" => match (callee.child_by_field_name("object"), callee.child_by_field_name("property")) {
                        (Some(o), Some(p)) => self.resolve_member_of(file, o, text(p, code), depth + 1),
                        _ => Resolution::Unresolved,
                    },
                    _ => Resolution::Unresolved,
                };
                if callee.kind() == "identifier" {
                    if let Some(state) = self.store_state(file, callee, depth + 1) {
                        // `useStore()` is the state; `useStore((s) => s.x)` what the selector picks.
                        let selector = node.child_by_field_name("arguments").and_then(|a| a.named_child(0));
                        return match selector {
                            None => state,
                            Some(f) if f.kind() == "arrow_function" => match f.child_by_field_name("body") {
                                Some(body) if body.kind() != "statement_block" => self.expr_type(file, body, depth + 1),
                                _ => Ty::Unknown,
                            },
                            Some(_) => Ty::Unknown,
                        };
                    }
                }
                match resolved {
                    Resolution::Found(t) => self.return_type(&t, depth + 1),
                    // A library's — or an auto-import's — function: its type is ours to
                    // know only for the few whose shape is the point of them.
                    other => {
                        let name = match callee.kind() {
                            "member_expression" => callee.child_by_field_name("property").map(|p| text(p, code)),
                            _ => Some(text(callee, code)),
                        };
                        match name.and_then(|n| self.known_call(file, node, n, depth + 1)) {
                            Some(ty) => ty,
                            None if matches!(other, Resolution::External) => Ty::External,
                            None => Ty::Unknown,
                        }
                    }
                }
            }
            "new_expression" => match node.child_by_field_name("constructor") {
                Some(c) => match self.expr_type(file, c, depth + 1) {
                    Ty::Class { file, decl, .. } => Ty::Class { file, decl, instance: true },
                    Ty::External => Ty::External,
                    _ => Ty::Unknown,
                },
                None => Ty::Unknown,
            },
            "parenthesized_expression" | "non_null_expression" => match node.named_child(0) {
                Some(inner) => self.expr_type(file, inner, depth + 1),
                None => Ty::Unknown,
            },
            "as_expression" | "satisfies_expression" => {
                let declared = node
                    .named_child(1)
                    .map(|t| self.type_of(file, t, depth + 1))
                    .unwrap_or(Ty::Unknown);
                match declared {
                    Ty::Unknown if node.kind() == "satisfies_expression" => match node.named_child(0) {
                        Some(e) => self.expr_type(file, e, depth + 1),
                        None => Ty::Unknown,
                    },
                    t => t,
                }
            }
            "await_expression" => match node.named_child(0).map(|e| self.expr_type(file, e, depth + 1)) {
                Some(Ty::Promise(inner)) => *inner,
                Some(other) => other,
                None => Ty::Unknown,
            },
            "object" => Ty::Shape { file, node },
            "class" => Ty::Class { file, decl: node, instance: false },
            "string" | "template_string" | "number" | "true" | "false" | "regex" | "null"
            | "undefined" => Ty::External,
            _ => Ty::Unknown,
        }
    }

    /// What `this` is at `node`: the class around a method or field (arrow functions see
    /// through), the object around an object literal's method; unknown in a plain
    /// function.
    fn this_type<'a>(&'a self, file: usize, node: Node<'a>) -> Ty<'a> {
        let mut cur = node.parent();
        while let Some(n) = cur {
            match n.kind() {
                "method_definition" | "public_field_definition" | "field_definition" => {
                    let holder = n.parent().and_then(|b| if b.kind() == "class_body" { b.parent() } else { Some(b) });
                    return match holder {
                        Some(h) if h.kind() == "object" => Ty::Shape { file, node: h },
                        Some(h) if is_class(h.kind()) => Ty::Class { file, decl: h, instance: !is_static(n) },
                        _ => Ty::Unknown,
                    };
                }
                "function_declaration" | "function_expression" | "generator_function"
                | "generator_function_declaration" => return Ty::Unknown,
                _ => {}
            }
            cur = n.parent();
        }
        Ty::Unknown
    }

    /// The type of the value a target denotes.
    fn target_type<'a>(&'a self, target: &Target, depth: usize) -> Ty<'a> {
        match target {
            Target::File(rel) => match self.file_index.get(rel) {
                Some(&fi) => Ty::Module(fi),
                None => Ty::Unknown,
            },
            Target::Decl { file, byte } => {
                if let Some(ty) = self.template_binding_type(*file, *byte, depth + 1) {
                    return ty;
                }
                match self.node_at(*file, *byte) {
                    Some(node) => self.decl_type(*file, node, depth + 1),
                    None => Ty::Unknown,
                }
            }
        }
    }

    /// A template binding's type: the value it's bound to, or that value's elements.
    fn template_binding_type<'a>(&'a self, file: usize, byte: usize, depth: usize) -> Option<Ty<'a>> {
        let parsed = self.parsed(file)?;
        let (a, b, element) = parsed.template.bindings.iter().find(|t| t.byte == byte)?.of?;
        let text = &self.code(file)[a..b];
        let a = a + (text.len() - text.trim_start().len());
        let b = b - (text.len() - text.trim_end().len());
        let mut node = parsed.tree.root_node().named_descendant_for_byte_range(a, b)?;
        while let Some(p) = node.parent().filter(|p| p.start_byte() == a && p.end_byte() <= b) {
            node = p;
        }
        let ty = self.expr_type(file, node, depth + 1);
        Some(if element { index_type(ty, None) } else { ty })
    }

    /// The type of what the declaration named at `node` declares (or of the expression
    /// at `node`, for an anonymous default export).
    fn decl_type<'a>(&'a self, file: usize, node: Node<'a>, depth: usize) -> Ty<'a> {
        if depth > MAX_DEPTH {
            return Ty::Unknown;
        }
        let Some(parent) = node.parent() else {
            return Ty::Unknown;
        };
        let typed = |p: Node<'a>| p.child_by_field_name("type").map(|t| self.type_of(file, t, depth + 1));
        let value = |p: Node<'a>| p.child_by_field_name("value").map(|v| self.expr_type(file, v, depth + 1));
        match parent.kind() {
            "variable_declarator" | "public_field_definition" | "property_signature" | "field_definition" => {
                typed(parent).or_else(|| value(parent)).unwrap_or(Ty::Unknown)
            }
            "required_parameter" | "optional_parameter" => typed(parent)
                .or_else(|| self.contextual_param(file, parent, depth + 1))
                .unwrap_or(Ty::Unknown),
            "formal_parameters" | "arrow_function" => {
                self.contextual_param(file, node, depth + 1).unwrap_or(Ty::Unknown)
            }
            "for_in_statement" => self.iterated(file, parent, depth + 1),
            "object_pattern" | "array_pattern" | "pair_pattern" | "object_assignment_pattern"
            | "assignment_pattern" => self.pattern_type(file, node, depth + 1),
            "pair" => value(parent).unwrap_or(Ty::Unknown),
            k if is_class(k) => Ty::Class { file, decl: parent, instance: false },
            "interface_declaration" | "enum_declaration" | "internal_module" => Ty::Shape { file, node: parent },
            "type_alias_declaration" => parent
                .child_by_field_name("value")
                .map(|v| self.type_of(file, v, depth + 1))
                .unwrap_or(Ty::Unknown),
            "enum_body" | "enum_assignment" => Ty::External,
            "member_expression" => {
                // `this.x = value`: what was assigned.
                let assign = parent.parent().filter(|a| a.kind() == "assignment_expression");
                match assign.and_then(|a| a.child_by_field_name("right")) {
                    Some(right) => self.expr_type(file, right, depth + 1),
                    None => Ty::Unknown,
                }
            }
            "export_statement" => self.expr_type(file, node, depth + 1),
            _ if matches!(node.kind(), "object" | "class" | "call_expression" | "new_expression") => {
                self.expr_type(file, node, depth + 1)
            }
            _ => Ty::Unknown,
        }
    }

    /// The type a call to the target returns, by its declared return type.
    fn return_type<'a>(&'a self, target: &Target, depth: usize) -> Ty<'a> {
        let Target::Decl { file, byte } = target else {
            return Ty::Unknown;
        };
        let Some(node) = self.node_at(*file, *byte) else {
            return Ty::Unknown;
        };
        let Some(parent) = node.parent() else {
            return Ty::Unknown;
        };
        let func = match parent.kind() {
            "variable_declarator" | "public_field_definition" | "field_definition" | "pair" => {
                // Angular's signals and inputs: calling one reads its value.
                if let Some(held) = parent
                    .child_by_field_name("value")
                    .and_then(|v| self.signal_value(*file, v, depth + 1))
                {
                    return held;
                }
                match parent.child_by_field_name("value").and_then(component_function_value) {
                    Some(f) => f,
                    None => {
                        // A declared function type: `fetch: (id: string) => Promise<User>`.
                        let declared = parent
                            .child_by_field_name("type")
                            .and_then(|t| t.named_child(0))
                            .filter(|t| t.kind() == "function_type");
                        match declared.and_then(|f| f.child_by_field_name("return_type")) {
                            Some(r) => return self.type_of(*file, r, depth + 1),
                            None => return Ty::Unknown,
                        }
                    }
                }
            }
            "property_signature" => {
                let declared = parent
                    .child_by_field_name("type")
                    .and_then(|t| t.named_child(0))
                    .filter(|t| t.kind() == "function_type");
                match declared.and_then(|f| f.child_by_field_name("return_type")) {
                    Some(r) => return self.type_of(*file, r, depth + 1),
                    None => return Ty::Unknown,
                }
            }
            _ => parent,
        };
        match func.child_by_field_name("return_type") {
            Some(r) => self.type_of(*file, r, depth + 1),
            // Undeclared: what its one `return` (or its expression body) gives back — a
            // composable's `return { user, login }`.
            None => match returned_expression(func) {
                Some(e) => self.expr_type(*file, e, depth + 1),
                None => Ty::Unknown,
            },
        }
    }

    /// The type a type annotation names.
    pub(super) fn type_of<'a>(&'a self, file: usize, ty: Node<'a>, depth: usize) -> Ty<'a> {
        if depth > MAX_DEPTH {
            return Ty::Unknown;
        }
        let code = self.code(file);
        match ty.kind() {
            "type_annotation" | "parenthesized_type" | "readonly_type" => match ty.named_child(0) {
                Some(inner) => self.type_of(file, inner, depth + 1),
                None => Ty::Unknown,
            },
            "type_identifier" => match self.resolve_name(file, ty, text(ty, code), Space::Type, depth + 1) {
                Resolution::Found(t) => self.type_target(&t, depth + 1),
                Resolution::External => Ty::External,
                _ => Ty::Unknown,
            },
            "nested_type_identifier" => match self.resolve_at(file, ty.child_by_field_name("name").unwrap_or(ty), depth + 1) {
                Resolution::Found(t) => self.type_target(&t, depth + 1),
                Resolution::External => Ty::External,
                _ => Ty::Unknown,
            },
            "generic_type" => {
                let Some(name) = ty.child_by_field_name("name") else {
                    return Ty::Unknown;
                };
                let inner = || {
                    ty.child_by_field_name("type_arguments")
                        .and_then(|a| a.named_child(0))
                        .map(|a| self.type_of(file, a, depth + 1))
                        .unwrap_or(Ty::Unknown)
                };
                match text(name, code) {
                    "Promise" | "PromiseLike" => Ty::Promise(Box::new(inner())),
                    "Array" | "ReadonlyArray" => Ty::Array(Box::new(inner())),
                    "Ref" | "ShallowRef" | "ComputedRef" | "WritableComputedRef" => {
                        Ty::Boxed { key: "value", inner: Box::new(inner()) }
                    }
                    "RefObject" | "MutableRefObject" => Ty::Boxed { key: "current", inner: Box::new(inner()) },
                    "Readonly" | "Partial" | "Required" | "NonNullable" | "DeepReadonly" => inner(),
                    _ => self.type_of(file, name, depth + 1),
                }
            }
            "object_type" => Ty::Shape { file, node: ty },
            "intersection_type" => {
                let mut cur = ty.walk();
                let parts: Vec<Node> = ty.named_children(&mut cur).collect();
                Ty::All(parts.into_iter().map(|p| self.type_of(file, p, depth + 1)).collect())
            }
            "union_type" => {
                // `Foo | null | undefined` is a `Foo` once checked; anything wider isn't one type.
                let mut members = Vec::new();
                flatten_union(ty, code, &mut members);
                match members.as_slice() {
                    [one] => self.type_of(file, *one, depth + 1),
                    many => Ty::Any(many.iter().map(|m| self.type_of(file, *m, depth + 1)).collect()),
                }
            }
            "type_query" => match ty.named_child(0) {
                Some(e) => self.expr_type(file, e, depth + 1),
                None => Ty::Unknown,
            },
            "lookup_type" => match self.type_import(file, ty, depth + 1) {
                Some(Resolution::Found(t)) => self.target_type(&t, depth + 1),
                Some(Resolution::External) => Ty::External,
                _ => Ty::Unknown,
            },
            "array_type" => match ty.named_child(0) {
                Some(e) => Ty::Array(Box::new(self.type_of(file, e, depth + 1))),
                None => Ty::External,
            },
            "tuple_type" => {
                let mut cur = ty.walk();
                let parts: Vec<Node> = ty.named_children(&mut cur).collect();
                Ty::Tuple(parts.into_iter().map(|p| self.type_of(file, p, depth + 1)).collect())
            }
            "predefined_type" | "literal_type" | "function_type" | "template_literal_type" => Ty::External,
            _ => Ty::Unknown,
        }
    }

    /// The type a type name's target stands for: a class's instances, an interface.
    fn type_target<'a>(&'a self, target: &Target, depth: usize) -> Ty<'a> {
        match target {
            Target::Decl { file, byte } => {
                let Some(node) = self.node_at(*file, *byte) else {
                    return Ty::Unknown;
                };
                match node.parent() {
                    Some(p) if is_class(p.kind()) => Ty::Class { file: *file, decl: p, instance: true },
                    Some(p) if matches!(p.kind(), "interface_declaration" | "internal_module") => {
                        Ty::Shape { file: *file, node: p }
                    }
                    Some(p) if p.kind() == "type_alias_declaration" => p
                        .child_by_field_name("value")
                        .map(|v| self.type_of(*file, v, depth + 1))
                        .unwrap_or(Ty::Unknown),
                    Some(p) if p.kind() == "enum_declaration" => Ty::External,
                    _ => Ty::Unknown,
                }
            }
            Target::File(rel) => match self.file_index.get(rel) {
                Some(&fi) => Ty::Module(fi),
                None => Ty::Unknown,
            },
        }
    }

    /// The type of `owner`'s member `name`: what its declaration declares, or what a
    /// wrapper holds.
    fn member_type<'a>(&'a self, owner: &Ty<'a>, name: &str, depth: usize) -> Ty<'a> {
        if let Ty::Boxed { key, inner } = owner {
            if *key == name {
                return (**inner).clone();
            }
        }
        match self.lookup_member(owner, name, depth + 1) {
            Member::Hits(hits) if hits.len() == 1 => self.target_type(&hits[0], depth + 1),
            Member::External => Ty::External,
            _ => Ty::Unknown,
        }
    }

    /// The type of a name a destructuring pattern binds: the type of what's destructured,
    /// followed key by key and index by index down to the name.
    fn pattern_type<'a>(&'a self, file: usize, binding: Node<'a>, depth: usize) -> Ty<'a> {
        enum Step {
            Key(String),
            Index(usize),
        }
        let code = self.code(file);
        let mut steps = Vec::new();
        let mut child = binding;
        let root = loop {
            let Some(p) = child.parent() else {
                return Ty::Unknown;
            };
            let is = |field: &str| p.child_by_field_name(field).map(|n| n.id()) == Some(child.id());
            match p.kind() {
                "object_pattern" => {
                    if child.kind() == "shorthand_property_identifier_pattern" {
                        steps.push(Step::Key(text(child, code).to_string()));
                    }
                }
                "object_assignment_pattern" => {
                    if !is("left") {
                        return Ty::Unknown;
                    }
                    steps.push(Step::Key(text(child, code).to_string()));
                }
                "pair_pattern" => match p.child_by_field_name("key") {
                    Some(k) if is("value") => steps.push(Step::Key(member_name(k, code).to_string())),
                    _ => return Ty::Unknown,
                },
                "array_pattern" => {
                    let mut cur = p.walk();
                    let at = p.named_children(&mut cur).position(|c| c.id() == child.id());
                    steps.push(Step::Index(at.unwrap_or(0)));
                }
                "assignment_pattern" => {
                    if !is("left") {
                        return Ty::Unknown;
                    }
                }
                "variable_declarator" => {
                    let declared = p.child_by_field_name("type").map(|t| self.type_of(file, t, depth + 1));
                    break declared
                        .or_else(|| p.child_by_field_name("value").map(|v| self.expr_type(file, v, depth + 1)))
                        .unwrap_or(Ty::Unknown);
                }
                "required_parameter" | "optional_parameter" => {
                    break p
                        .child_by_field_name("type")
                        .map(|t| self.type_of(file, t, depth + 1))
                        .or_else(|| self.contextual_param(file, p, depth + 1))
                        .unwrap_or(Ty::Unknown);
                }
                "formal_parameters" => break self.contextual_param(file, child, depth + 1).unwrap_or(Ty::Unknown),
                "for_in_statement" => break self.iterated(file, p, depth + 1),
                _ => return Ty::Unknown,
            }
            child = p;
        };
        let mut ty = root;
        for step in steps.into_iter().rev() {
            ty = match step {
                Step::Key(k) => self.member_type(&ty, &k, depth + 1),
                Step::Index(i) => index_type(ty, Some(i)),
            };
        }
        ty
    }

    /// An unannotated callback parameter's type from the call it's passed to:
    /// `items.map((item) => ..)` gives `item` the array's element type, `.then((v) => ..)`
    /// the promised one.
    fn contextual_param<'a>(&'a self, file: usize, param: Node<'a>, depth: usize) -> Option<Ty<'a>> {
        let holder = param.parent()?;
        let (func, index) = match holder.kind() {
            "formal_parameters" => {
                let mut cur = holder.walk();
                let index = holder.named_children(&mut cur).position(|c| c.id() == param.id())?;
                (holder.parent()?, index)
            }
            "arrow_function" => (holder, 0),
            _ => return None,
        };
        if !matches!(func.kind(), "arrow_function" | "function_expression") {
            return None;
        }
        // `onClick={(e) => ..}` on an intrinsic element: a DOM event, the runtime's.
        let attr = func.parent().filter(|p| p.kind() == "jsx_expression").and_then(|p| p.parent());
        if let Some(attr) = attr.filter(|a| a.kind() == "jsx_attribute") {
            let element = attr.parent().and_then(|e| e.child_by_field_name("name"));
            let intrinsic = element.is_some_and(|n| {
                n.kind() == "identifier" && text(n, self.code(file)).starts_with(|c: char| c.is_ascii_lowercase())
            });
            return intrinsic.then_some(Ty::External);
        }
        let args = func.parent().filter(|a| a.kind() == "arguments")?;
        let mut cur = args.walk();
        let arg_pos = args.named_children(&mut cur).position(|c| c.id() == func.id())?;
        let call = args.parent().filter(|c| c.kind() == "call_expression")?;
        let callee = call.child_by_field_name("function")?;
        if callee.kind() == "identifier" {
            // A store hook's selector: `useStore((s) => s.x)` reads the store's state.
            return match (self.store_state(file, callee, depth + 1), arg_pos, index) {
                (Some(state), 0, 0) => Some(state),
                _ => None,
            };
        }
        let callee = Some(callee).filter(|f| f.kind() == "member_expression")?;
        let method = text(callee.child_by_field_name("property")?, self.code(file));
        let receiver = self.expr_type(file, callee.child_by_field_name("object")?, depth + 1);
        match (receiver, method, arg_pos, index) {
            (
                Ty::Array(e),
                "map" | "forEach" | "filter" | "find" | "findLast" | "some" | "every" | "flatMap"
                | "findIndex" | "findLastIndex" | "toSorted",
                0,
                0,
            ) => Some(*e),
            (Ty::Array(e), "sort" | "toSorted", 0, 0 | 1) => Some(*e),
            (Ty::Array(e), "reduce" | "reduceRight", 0, 1) => Some(*e),
            (Ty::Promise(inner), "then", 0, 0) => Some(*inner),
            _ => None,
        }
    }

    /// The state of a store hook `callee` names — `const useStore = create<State>(..)`,
    /// Zustand's (or `create<State>()(..)`, its curried TypeScript form).
    fn store_state<'a>(&'a self, file: usize, callee: Node<'a>, depth: usize) -> Option<Ty<'a>> {
        let name = text(callee, self.code(file));
        if !name.starts_with("use") {
            return None;
        }
        let Resolution::Found(Target::Decl { file: df, byte }) = self.resolve_name(file, callee, name, Space::Value, depth + 1) else {
            return None;
        };
        let decl = self.node_at(df, byte)?.parent().filter(|p| p.kind() == "variable_declarator")?;
        let dcode = self.code(df);
        let mut call = decl.child_by_field_name("value").filter(|v| v.kind() == "call_expression")?;
        // `create<State>()(...)`: the type argument is on the inner call.
        while let Some(inner) = call.child_by_field_name("function").filter(|f| f.kind() == "call_expression") {
            call = inner;
        }
        let creator = text(call.child_by_field_name("function")?, dcode);
        if !matches!(creator, "create" | "createStore" | "createWithEqualityFn" | "zustand.create") {
            return None;
        }
        let state = call.child_by_field_name("type_arguments")?.named_child(0)?;
        Some(self.type_of(df, state, depth + 1))
    }

    /// The value an Angular signal holds — `signal<T>(..)`, `computed(() => ..)`,
    /// `input<T>()`, `input.required<T>()`, `model<T>()`, `toSignal(..)` — which calling it
    /// reads. `None` for anything else.
    fn signal_value<'a>(&'a self, file: usize, value: Node<'a>, depth: usize) -> Option<Ty<'a>> {
        if value.kind() != "call_expression" {
            return None;
        }
        let code = self.code(file);
        let callee = text(value.child_by_field_name("function")?, code);
        if !matches!(callee, "signal" | "computed" | "input" | "input.required" | "model" | "model.required" | "linkedSignal" | "toSignal") {
            return None;
        }
        let type_arg = value.child_by_field_name("type_arguments").and_then(|a| a.named_child(0));
        if let Some(t) = type_arg {
            return Some(self.type_of(file, t, depth + 1));
        }
        let arg = value.child_by_field_name("arguments").and_then(|a| a.named_child(0))?;
        Some(match arg.kind() {
            "arrow_function" => match arg.child_by_field_name("body") {
                Some(body) if body.kind() != "statement_block" => self.expr_type(file, body, depth + 1),
                _ => Ty::Unknown,
            },
            _ => self.expr_type(file, arg, depth + 1),
        })
    }

    /// The type a `for (.. of x)` binding takes: an element of `x`.
    fn iterated<'a>(&'a self, file: usize, stmt: Node<'a>, depth: usize) -> Ty<'a> {
        let mut cur = stmt.walk();
        let of = stmt.children(&mut cur).any(|c| c.kind() == "of");
        match stmt.child_by_field_name("right") {
            Some(right) if of => index_type(self.expr_type(file, right, depth + 1), None),
            // `for (.. in x)`: its keys, strings.
            _ => Ty::External,
        }
    }

    /// What a call to one of the few library functions whose type is the point of them
    /// returns: React's `useState`/`useRef`/`useMemo`, Vue's `ref`/`computed`/`reactive`/
    /// `defineProps`, Svelte's runes.
    fn known_call<'a>(&'a self, file: usize, call: Node<'a>, name: &str, depth: usize) -> Option<Ty<'a>> {
        let type_arg = || {
            call.child_by_field_name("type_arguments")
                .and_then(|a| a.named_child(0))
                .map(|t| self.type_of(file, t, depth + 1))
        };
        let arg = call.child_by_field_name("arguments").and_then(|a| a.named_child(0));
        // An initializer's value, or what a lazy initializer or getter returns.
        let value = || match arg {
            Some(a) if matches!(a.kind(), "arrow_function" | "function_expression") => {
                let body = a.child_by_field_name("body")?;
                if body.kind() == "statement_block" {
                    a.child_by_field_name("return_type").map(|r| self.type_of(file, r, depth + 1))
                } else {
                    Some(self.expr_type(file, body, depth + 1))
                }
            }
            Some(a) => Some(self.expr_type(file, a, depth + 1)),
            None => None,
        };
        let held = || type_arg().or_else(value).unwrap_or(Ty::Unknown);
        Some(match name {
            "useState" | "useSignal" => Ty::Tuple(vec![held(), Ty::External]),
            "useRef" | "createRef" => Ty::Boxed { key: "current", inner: Box::new(held()) },
            "useMemo" | "useDeferredValue" | "$derived" => held(),
            "ref" | "shallowRef" | "toRef" | "computed" => Ty::Boxed { key: "value", inner: Box::new(held()) },
            "reactive" | "shallowReactive" | "readonly" | "markRaw" | "toRaw" | "$state"
            | "structuredClone" | "freeze" | "withDefaults" => held(),
            "defineProps" | "inject" | "useContext" => type_arg().or_else(|| match arg {
                Some(a) if a.kind() == "object" => Some(Ty::Shape { file, node: a }),
                _ => None,
            })?,
            _ => return None,
        })
    }

    // -----------------------------------------------------------------------------
    // Members
    // -----------------------------------------------------------------------------

    pub(super) fn lookup_member(&self, ty: &Ty, name: &str, depth: usize) -> Member {
        if depth > MAX_DEPTH {
            return Member::Missing { complete: false };
        }
        match ty {
            Ty::Unknown => Member::Missing { complete: false },
            Ty::External | Ty::Promise(_) | Ty::Array(_) | Ty::Tuple(_) | Ty::Boxed { .. } => Member::External,
            Ty::Module(fi) => match self.resolve_export(*fi, name, depth + 1, &mut Vec::new()) {
                Resolution::Found(t) => Member::Hits(vec![t]),
                Resolution::Ambiguous(ts) => Member::Hits(ts),
                Resolution::External => Member::External,
                Resolution::Unresolved => self.cjs_member(*fi, name, depth + 1),
            },
            Ty::All(parts) => {
                let mut hits = Vec::new();
                let mut complete = true;
                let mut external = false;
                for p in parts {
                    match self.lookup_member(p, name, depth + 1) {
                        Member::Hits(h) => hits.extend(h),
                        Member::External => external = true,
                        Member::Missing { complete: c } => complete &= c,
                    }
                }
                if !hits.is_empty() {
                    Member::Hits(hits)
                } else if external {
                    Member::Missing { complete: false }
                } else {
                    Member::Missing { complete }
                }
            }
            Ty::Any(variants) => {
                let mut hits = Vec::new();
                let mut complete = true;
                let mut external = 0;
                for v in variants {
                    match self.lookup_member(v, name, depth + 1) {
                        Member::Hits(h) => hits.extend(h.into_iter().filter(|t| !hits.contains(t)).collect::<Vec<_>>()),
                        Member::External => external += 1,
                        Member::Missing { complete: c } => complete &= c,
                    }
                }
                if !hits.is_empty() {
                    Member::Hits(hits)
                } else if external == variants.len() {
                    Member::External
                } else {
                    Member::Missing { complete }
                }
            }
            Ty::Class { file, decl, instance } => self.class_member(*file, *decl, *instance, name, depth + 1),
            Ty::Shape { file, node } => self.shape_member(*file, *node, name, depth + 1),
        }
    }

    /// A CommonJS module's member reached through `module.exports = value`.
    fn cjs_member(&self, file: usize, name: &str, depth: usize) -> Member {
        let Some(parsed) = self.parsed(file) else {
            return Member::Missing { complete: false };
        };
        match parsed.module.exports.get("default") {
            Some(ExportTarget::Expr(_) | ExportTarget::Local(_)) => {
                let target = match self.resolve_export(file, "default", depth + 1, &mut Vec::new()) {
                    Resolution::Found(t) => t,
                    _ => return Member::Missing { complete: false },
                };
                let ty = self.target_type(&target, depth + 1);
                match ty {
                    Ty::Module(fi) if fi == file => Member::Missing { complete: false },
                    ty => match self.lookup_member(&ty, name, depth + 1) {
                        Member::Hits(h) => Member::Hits(h),
                        _ => Member::Missing { complete: false },
                    },
                }
            }
            _ => Member::Missing { complete: false },
        }
    }

    fn class_member(&self, file: usize, decl: Node, instance: bool, name: &str, depth: usize) -> Member {
        let code = self.code(file);
        let Some(body) = decl.child_by_field_name("body") else {
            return Member::Missing { complete: false };
        };
        let mut hits = Vec::new();
        let mut open = false;
        let mut cur = body.walk();
        for m in body.named_children(&mut cur) {
            let key = match m.kind() {
                "method_definition" | "abstract_method_signature" | "method_signature"
                | "public_field_definition" | "property_signature" => m.child_by_field_name("name"),
                "field_definition" => m.child_by_field_name("property"),
                "index_signature" => {
                    open = true;
                    None
                }
                _ => None,
            };
            let Some(key) = key else {
                continue;
            };
            if member_name(key, code) == name && is_static(m) != instance {
                hits.push(Target::Decl { file, byte: key.start_byte() });
            }
            // `constructor(private readonly svc: Service)` declares a member too.
            if instance && m.kind() == "method_definition" && text(key, code) == "constructor" {
                if let Some(params) = m.child_by_field_name("parameters") {
                    let mut pc = params.walk();
                    for p in params.named_children(&mut pc) {
                        let mut tc = p.walk();
                        let property = p
                            .children(&mut tc)
                            .any(|c| matches!(c.kind(), "accessibility_modifier" | "readonly" | "override_modifier"));
                        let pat = p.child_by_field_name("pattern");
                        if let Some(pat) = pat.filter(|n| property && n.kind() == "identifier" && text(*n, code) == name) {
                            hits.push(Target::Decl { file, byte: pat.start_byte() });
                        }
                    }
                }
            }
        }
        if hits.is_empty() && instance {
            // `this.name = ..` in a method: how plain JavaScript declares fields.
            if let Some(found) = this_assignment(body, code, name) {
                hits.push(Target::Decl { file, byte: found.start_byte() });
            }
        }
        if !hits.is_empty() {
            // A getter and its setter, overload signatures: the first says where it is.
            hits.truncate(1);
            return Member::Hits(hits);
        }
        match heritage(decl) {
            None => Member::Missing { complete: !open },
            Some(h) => match self.expr_type(file, h, depth + 1) {
                Ty::Class { file: f, decl: d, .. } if d.id() != decl.id() => {
                    match self.class_member(f, d, instance, name, depth + 1) {
                        Member::Missing { complete } => Member::Missing { complete: complete && !open },
                        found => found,
                    }
                }
                // Something we can't see could declare it.
                _ => Member::Missing { complete: false },
            },
        }
    }

    fn shape_member(&self, file: usize, node: Node, name: &str, depth: usize) -> Member {
        let code = self.code(file);
        let mut hits = Vec::new();
        let mut complete = true;
        let check = |key: Option<Node>, hits: &mut Vec<Target>| {
            if let Some(k) = key.filter(|k| member_name(*k, code) == name) {
                hits.push(Target::Decl { file, byte: k.start_byte() });
            }
        };
        match node.kind() {
            "interface_declaration" | "object_type" => {
                let body = if node.kind() == "object_type" { Some(node) } else { node.child_by_field_name("body") };
                if let Some(body) = body {
                    let mut cur = body.walk();
                    for m in body.named_children(&mut cur) {
                        match m.kind() {
                            "property_signature" | "method_signature" => check(m.child_by_field_name("name"), &mut hits),
                            "index_signature" => complete = false,
                            _ => {}
                        }
                    }
                }
                if hits.is_empty() && node.kind() == "interface_declaration" {
                    let mut cur = node.walk();
                    let clauses: Vec<Node> = node
                        .named_children(&mut cur)
                        .filter(|c| c.kind() == "extends_type_clause")
                        .collect();
                    for clause in clauses {
                        let mut cc = clause.walk();
                        let supers: Vec<Node> = clause.named_children(&mut cc).collect();
                        for s in supers {
                            match self.lookup_member(&self.type_of(file, s, depth + 1), name, depth + 1) {
                                Member::Hits(h) => return Member::Hits(h),
                                Member::Missing { complete: true } => {}
                                _ => complete = false,
                            }
                        }
                    }
                }
            }
            "object" => {
                let mut cur = node.walk();
                for m in node.named_children(&mut cur) {
                    match m.kind() {
                        "pair" => check(m.child_by_field_name("key"), &mut hits),
                        "method_definition" => check(m.child_by_field_name("name"), &mut hits),
                        "shorthand_property_identifier" => check(Some(m), &mut hits),
                        "spread_element" => complete = false,
                        _ => {}
                    }
                }
            }
            "enum_declaration" => {
                if let Some(body) = node.child_by_field_name("body") {
                    let mut cur = body.walk();
                    for m in body.named_children(&mut cur) {
                        match m.kind() {
                            "property_identifier" | "string" => check(Some(m), &mut hits),
                            "enum_assignment" => check(m.child_by_field_name("name"), &mut hits),
                            _ => {}
                        }
                    }
                }
            }
            "internal_module" => {
                if let Some(body) = node.child_by_field_name("body") {
                    let mut cur = body.walk();
                    for stmt in body.named_children(&mut cur).filter(|s| s.kind() == "export_statement") {
                        for n in super::parse::declared_names(stmt) {
                            check(Some(n), &mut hits);
                        }
                    }
                }
            }
            _ => complete = false,
        }
        if hits.is_empty() {
            Member::Missing { complete }
        } else {
            hits.truncate(1);
            Member::Hits(hits)
        }
    }
}

/// `import x from 'here'`, `export .. from 'here'`, `require('here')`, `import('here')` —
/// or a file an Angular decorator names (`templateUrl`, `styleUrl`, `styleUrls`).
pub fn is_module_source(string: Node, code: &str) -> bool {
    if is_module_specifier(string, code) {
        return true;
    }
    let Some(parent) = string.parent() else {
        return false;
    };
    let key = |pair: Node| pair.child_by_field_name("key").map(|k| text(k, code).trim_matches(['\'', '"']).to_string());
    match parent.kind() {
        "pair" => {
            parent.child_by_field_name("value").map(|v| v.id()) == Some(string.id())
                && matches!(key(parent).as_deref(), Some("templateUrl" | "styleUrl"))
        }
        "array" => parent
            .parent()
            .filter(|p| p.kind() == "pair")
            .is_some_and(|p| key(p).as_deref() == Some("styleUrls")),
        _ => false,
    }
}

/// `import x from 'here'`, `export .. from 'here'`, `require('here')`, `import('here')`.
fn is_module_specifier(string: Node, code: &str) -> bool {
    let Some(parent) = string.parent() else {
        return false;
    };
    match parent.kind() {
        "import_statement" | "export_statement" | "import_require_clause" => {
            parent.child_by_field_name("source").map(|s| s.id()) == Some(string.id())
        }
        "arguments" => parent.parent().is_some_and(|call| required(call, code).is_some()),
        _ => false,
    }
}

/// An import specifier's local name.
fn local_name<'a>(node: Node, code: &'a str) -> &'a str {
    if node.kind() == "string" {
        string_value(node, code)
    } else {
        text(node, code)
    }
}

/// A member's key as written: `name`, `'quoted-name'`, `#private`.
fn member_name<'a>(key: Node, code: &'a str) -> &'a str {
    if key.kind() == "string" {
        string_value(key, code)
    } else {
        text(key, code)
    }
}

pub fn is_class(kind: &str) -> bool {
    matches!(kind, "class_declaration" | "abstract_class_declaration" | "class")
}

fn is_static(member: Node) -> bool {
    let mut cur = member.walk();
    let found = member.children(&mut cur).any(|c| c.kind() == "static");
    found
}

fn enclosing_class(node: Node) -> Option<Node> {
    let mut cur = node.parent();
    while let Some(n) = cur {
        if is_class(n.kind()) {
            return Some(n);
        }
        cur = n.parent();
    }
    None
}

/// What a class `extends`: TypeScript's `extends_clause`, JavaScript's bare expression.
fn heritage(class: Node) -> Option<Node> {
    let mut cur = class.walk();
    let h = class.named_children(&mut cur).find(|c| c.kind() == "class_heritage")?;
    let mut hc = h.walk();
    let first = h.named_children(&mut hc).next()?;
    if first.kind() == "extends_clause" {
        first.child_by_field_name("value")
    } else if first.kind() == "implements_clause" {
        None
    } else {
        Some(first)
    }
}

/// The first `this.name = ..` in a class body.
fn this_assignment<'t>(body: Node<'t>, code: &str, name: &str) -> Option<Node<'t>> {
    let mut stack = vec![body];
    let mut cur = body.walk();
    while let Some(n) = stack.pop() {
        if n.kind() == "assignment_expression" {
            if let Some(left) = n.child_by_field_name("left").filter(|l| l.kind() == "member_expression") {
                let on_this = left.child_by_field_name("object").is_some_and(|o| o.kind() == "this");
                if let Some(p) = left.child_by_field_name("property").filter(|p| on_this && text(*p, code) == name) {
                    return Some(p);
                }
            }
        }
        let children: Vec<Node> = n.named_children(&mut cur).collect();
        stack.extend(children.into_iter().rev());
    }
    None
}

/// The function a component is: declared, assigned, or wrapped (`memo(..)`, `forwardRef(..)`).
fn component_function(name: Node) -> Option<Node> {
    let parent = name.parent()?;
    match parent.kind() {
        "function_declaration" | "function_expression" => Some(parent),
        "variable_declarator" => parent.child_by_field_name("value").and_then(component_function_value),
        _ => None,
    }
}

fn component_function_value(value: Node) -> Option<Node> {
    match value.kind() {
        "arrow_function" | "function_expression" => Some(value),
        "call_expression" => value
            .child_by_field_name("arguments")
            .and_then(|a| a.named_child(0))
            .and_then(component_function_value),
        "parenthesized_expression" | "as_expression" | "satisfies_expression" => {
            value.named_child(0).and_then(component_function_value)
        }
        _ => None,
    }
}

/// What a function without a declared return type returns, when that's one expression:
/// an arrow's expression body, or the argument of the body's only `return`.
fn returned_expression(func: Node) -> Option<Node> {
    let body = func.child_by_field_name("body")?;
    if body.kind() != "statement_block" {
        return Some(body);
    }
    let mut found = None;
    let mut stack = vec![body];
    let mut cursor = body.walk();
    while let Some(n) = stack.pop() {
        for c in n.named_children(&mut cursor) {
            if scope::is_function(c.kind()) || is_class(c.kind()) {
                continue;
            }
            if c.kind() == "return_statement" {
                if found.is_some() {
                    return None;
                }
                found = Some(c.named_child(0)?);
            } else {
                stack.push(c);
            }
        }
    }
    found
}

/// An element of an array or tuple: the `index`-th, or any.
fn index_type(ty: Ty, index: Option<usize>) -> Ty {
    match (ty, index) {
        (Ty::Array(e), _) => *e,
        (Ty::Tuple(mut parts), Some(i)) if i < parts.len() => parts.swap_remove(i),
        _ => Ty::Unknown,
    }
}

/// A union's members, `null` and `undefined` left out.
fn flatten_union<'t>(ty: Node<'t>, code: &str, out: &mut Vec<Node<'t>>) {
    let mut cur = ty.walk();
    for part in ty.named_children(&mut cur) {
        match part.kind() {
            "union_type" => flatten_union(part, code, out),
            "literal_type" if matches!(text(part, code), "null" | "undefined") => {}
            "predefined_type" if matches!(text(part, code), "undefined" | "null" | "void") => {}
            _ => out.push(part),
        }
    }
}
