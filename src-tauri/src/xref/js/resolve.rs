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
enum Ty<'a> {
    /// A class: its instances' members, or (`instance: false`) its static ones.
    Class { file: usize, decl: Node<'a>, instance: bool },
    /// Members by declaration: an interface, an object type or literal, an enum, a
    /// namespace.
    Shape { file: usize, node: Node<'a> },
    /// A module's exports.
    Module(usize),
    /// An intersection: the members of all of them.
    All(Vec<Ty<'a>>),
    Promise(Box<Ty<'a>>),
    External,
    Unknown,
}

enum Member {
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
                Some(s) => self.module_resolution(file, string_value(s, code)),
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
        if let Some(found) = self.resolve_top(file, name, space, depth) {
            return found;
        }
        if let Some(found) = self.resolve_template_name(file, node, name, depth) {
            return found;
        }
        self.resolve_global(file, name, space, depth)
    }

    /// A name at the top of `file`: an import, or a declaration in `space`.
    fn resolve_top(&self, file: usize, name: &str, space: Space, depth: usize) -> Option<Resolution> {
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
                if name == "default" && parsed.code.is_some() {
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
    fn typed(&self, ty: &Ty) -> bool {
        match ty {
            Ty::Class { file, .. } => self.parsed(*file).is_some_and(|p| p.typed),
            Ty::Shape { file, node } => {
                node.kind() != "object" && self.parsed(*file).is_some_and(|p| p.typed)
            }
            Ty::All(tys) => tys.iter().all(|t| self.typed(t)),
            _ => false,
        }
    }

    /// `{ name: alias } = value`: `name` is `value`'s member.
    fn resolve_destructured<'a>(&'a self, file: usize, pair: Node<'a>, name: &str, depth: usize) -> Resolution {
        let pattern = pair.parent().filter(|p| p.kind() == "object_pattern");
        let declarator = pattern.and_then(|p| p.parent()).filter(|d| d.kind() == "variable_declarator");
        match declarator.and_then(|d| d.child_by_field_name("value")) {
            Some(value) => self.resolve_member_of(file, value, name, depth + 1),
            None => Resolution::Unresolved,
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
        if tag.kind() == "identifier" && text(tag, self.code(file)).starts_with(|c: char| c.is_ascii_lowercase()) {
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

    /// A name a template uses that the component's script doesn't declare — Angular's
    /// component members, Vue's options (`templates.rs` fills this in).
    fn resolve_template_name(&self, _file: usize, _node: Node, _name: &str, _depth: usize) -> Option<Resolution> {
        None
    }

    /// A name a framework provides by convention: Nuxt's auto-imports.
    fn resolve_convention(&self, _file: usize, _name: &str, _depth: usize) -> Option<Resolution> {
        None
    }

    /// A component tag in a template.
    pub fn resolve_tag(&self, _file: usize, _tag: &super::sfc::Tag, _depth: usize) -> Resolution {
        Resolution::Unresolved
    }

    // -----------------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------------

    fn expr_type<'a>(&'a self, file: usize, node: Node<'a>, depth: usize) -> Ty<'a> {
        if depth > MAX_DEPTH {
            return Ty::Unknown;
        }
        let code = self.code(file);
        match node.kind() {
            "identifier" | "shorthand_property_identifier" => {
                match self.resolve_name(file, node, text(node, code), Space::Value, depth + 1) {
                    Resolution::Found(t) => self.target_type(&t, depth + 1),
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
                match self.resolve_member_of(file, object, text(prop, code), depth + 1) {
                    Resolution::Found(t) => self.target_type(&t, depth + 1),
                    Resolution::External => Ty::External,
                    _ => Ty::Unknown,
                }
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
                match resolved {
                    Resolution::Found(t) => self.return_type(&t, depth + 1),
                    Resolution::External => Ty::External,
                    _ => Ty::Unknown,
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
            "string" | "template_string" | "number" | "true" | "false" | "regex" | "array"
            | "null" | "undefined" => Ty::External,
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
            Target::Decl { file, byte } => match self.node_at(*file, *byte) {
                Some(node) => self.decl_type(*file, node, depth + 1),
                None => Ty::Unknown,
            },
        }
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
            "required_parameter" | "optional_parameter" => typed(parent).unwrap_or(Ty::Unknown),
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
            None => Ty::Unknown,
        }
    }

    /// The type a type annotation names.
    fn type_of<'a>(&'a self, file: usize, ty: Node<'a>, depth: usize) -> Ty<'a> {
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
                if matches!(text(name, code), "Promise" | "PromiseLike") {
                    let inner = ty
                        .child_by_field_name("type_arguments")
                        .and_then(|a| a.named_child(0))
                        .map(|a| self.type_of(file, a, depth + 1))
                        .unwrap_or(Ty::Unknown);
                    return Ty::Promise(Box::new(inner));
                }
                self.type_of(file, name, depth + 1)
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
                    _ => Ty::Unknown,
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
            "predefined_type" | "literal_type" | "array_type" | "tuple_type" | "function_type"
            | "template_literal_type" => Ty::External,
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

    // -----------------------------------------------------------------------------
    // Members
    // -----------------------------------------------------------------------------

    fn lookup_member(&self, ty: &Ty, name: &str, depth: usize) -> Member {
        if depth > MAX_DEPTH {
            return Member::Missing { complete: false };
        }
        match ty {
            Ty::Unknown => Member::Missing { complete: false },
            Ty::External | Ty::Promise(_) => Member::External,
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

/// `import x from 'here'`, `export .. from 'here'`, `require('here')`, `import('here')`.
pub fn is_module_source(string: Node, code: &str) -> bool {
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
