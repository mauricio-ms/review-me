//! What templates and framework conventions add to resolution: component tags, the names
//! a Vue template sees beyond the script's scope (props, the Options API), Svelte's
//! `$store` subscriptions, globally registered components, and Nuxt's auto-imports —
//! `components/`, `composables/`, `utils/`, `#components`, `#imports`.

use std::collections::HashMap;

use tree_sitter::Node;

use super::builtins;
use super::parse::{string_value, text, ExportTarget, Import, ImportKind};
use super::project::{file_name, join, parent};
use super::resolve::{Member, Resolution, Target};
use super::scope::Space;
use super::sfc::{Tag, TagKind};
use super::{walk, JsIndex};

/// Extensions a component may be written in.
const COMPONENT_EXTENSIONS: &[&str] = &["vue", "svelte", "astro", "tsx", "jsx", "ts", "js"];

impl JsIndex {
    /// Whether `byte` of `file` is in a Vue template's expressions.
    pub(super) fn in_vue_template(&self, file: usize, byte: usize) -> bool {
        self.files[file].rel.ends_with(".vue")
            && self.parsed(file).is_some_and(|p| p.template.in_template(byte))
    }

    /// A name a component's script doesn't declare but its template (or Svelte's `$`
    /// prefix) still reaches.
    pub(super) fn resolve_template_name(&self, file: usize, node: Node, name: &str, depth: usize) -> Option<Resolution> {
        if self.files[file].rel.ends_with(".svelte") {
            // `$count` reads the store `count`.
            let store = name.strip_prefix('$').filter(|s| !s.is_empty())?;
            return self.resolve_top(file, store, Space::Value, depth + 1);
        }
        if !self.in_vue_template(file, node.start_byte()) {
            return None;
        }
        self.vue_member(file, name, depth + 1)
    }

    /// A Vue component's own member: a prop (`defineProps`, or the Options API's
    /// `props`), or what `data`, `computed`, `methods`, `inject` and `setup` give it.
    fn vue_member(&self, file: usize, name: &str, depth: usize) -> Option<Resolution> {
        let parsed = self.parsed(file)?;
        let code = self.code(file);
        let mut found: Option<Resolution> = None;
        walk(parsed.tree.root_node(), &mut |n| {
            if found.is_some() || n.kind() != "call_expression" {
                return;
            }
            let callee = n.child_by_field_name("function").map(|f| text(f, code));
            if callee != Some("defineProps") {
                return;
            }
            let type_arg = n.child_by_field_name("type_arguments").and_then(|a| a.named_child(0));
            let arg = n.child_by_field_name("arguments").and_then(|a| a.named_child(0));
            found = match (type_arg, arg) {
                (Some(t), _) => {
                    let ty = self.type_of(file, t, depth + 1);
                    match self.lookup_member(&ty, name, depth + 1) {
                        Member::Hits(hits) => Some(super::resolve::finish(hits)),
                        _ => None,
                    }
                }
                (None, Some(a)) => declared_key(a, code, name).map(|k| Resolution::Found(Target::Decl { file, byte: k.start_byte() })),
                _ => None,
            };
        });
        if found.is_some() {
            return found;
        }
        // The Options API: `export default { .. }` or `defineComponent({ .. })`.
        let options = match parsed.module.exports.get("default") {
            Some(ExportTarget::Expr(b)) => self.node_at(file, *b),
            _ => None,
        }?;
        let options = expression_at(options);
        let options = match options.kind() {
            "call_expression" => options.child_by_field_name("arguments")?.named_child(0)?,
            _ => options,
        };
        if options.kind() != "object" {
            return None;
        }
        let mut cur = options.walk();
        for section in options.named_children(&mut cur) {
            let (key, value) = match section.kind() {
                "pair" => (section.child_by_field_name("key"), section.child_by_field_name("value")),
                "method_definition" => (section.child_by_field_name("name"), Some(section)),
                _ => continue,
            };
            let (Some(key), Some(value)) = (key, value) else {
                continue;
            };
            let returned = || returned_object(value);
            let hit = match text(key, code) {
                "props" | "computed" | "methods" | "inject" => declared_key(value, code, name),
                "data" | "setup" => returned().and_then(|o| declared_key(o, code, name)),
                _ => None,
            };
            if let Some(k) = hit {
                // `setup() { return { count } }`: the local it returns.
                if k.kind() == "shorthand_property_identifier" {
                    return Some(self.resolve(file, k));
                }
                return Some(Resolution::Found(Target::Decl { file, byte: k.start_byte() }));
            }
        }
        None
    }

    /// A component tag: what the script imports or declares under its name, a globally
    /// registered component, a framework convention's, or the framework's own.
    pub fn resolve_tag(&self, file: usize, tag: &Tag, depth: usize) -> Resolution {
        if tag.kind != TagKind::Component {
            return self.resolve_angular_tag(tag, depth);
        }
        let name = tag.name.as_str();
        if let Some(found) = self.resolve_top(file, name, Space::Value, depth + 1) {
            return found;
        }
        if let Some(found) = self.vue_member(file, name, depth + 1).filter(|_| self.files[file].rel.ends_with(".vue")) {
            return found;
        }
        if let Some(found) = self.global_component(name, depth + 1) {
            return found;
        }
        if let Some(found) = self.nuxt_component(file, name) {
            return found;
        }
        if builtins::is_builtin_component(name) {
            return Resolution::External;
        }
        Resolution::Unresolved
    }

    /// A component registered for every template: `GlobalComponents` declarations
    /// (`components.d.ts`, unplugin-vue-components') and `app.component('Name', X)`.
    fn global_component(&self, name: &str, depth: usize) -> Option<Resolution> {
        let kebab = kebab(name);
        for fi in 0..self.files.len() {
            let src = &self.files[fi].source;
            if !src.contains(name) && !src.contains(&kebab) {
                continue;
            }
            let declares = src.contains("GlobalComponents");
            let registers = src.contains(".component(");
            if !declares && !registers {
                continue;
            }
            let Some(parsed) = self.parsed(fi) else {
                continue;
            };
            let code = self.code(fi);
            let mut found: Option<Resolution> = None;
            walk(parsed.tree.root_node(), &mut |n| {
                if found.is_some() {
                    return;
                }
                match n.kind() {
                    "property_signature" if declares => {
                        let in_global = n
                            .parent()
                            .and_then(|b| b.parent())
                            .and_then(|i| i.child_by_field_name("name"))
                            .is_some_and(|i| text(i, code) == "GlobalComponents");
                        let named = n.child_by_field_name("name").is_some_and(|k| text(k, code) == name);
                        if in_global && named {
                            let ty = n.child_by_field_name("type").and_then(|t| t.named_child(0));
                            found = ty.and_then(|t| self.type_import(fi, t, depth + 1)).or(Some(Resolution::Found(
                                Target::Decl { file: fi, byte: n.child_by_field_name("name").unwrap().start_byte() },
                            )));
                        }
                    }
                    "call_expression" if registers => {
                        let method = n
                            .child_by_field_name("function")
                            .filter(|f| f.kind() == "member_expression")
                            .and_then(|f| f.child_by_field_name("property"))
                            .map(|p| text(p, code));
                        if method != Some("component") {
                            return;
                        }
                        let args = n.child_by_field_name("arguments");
                        let first = args.and_then(|a| a.named_child(0)).filter(|a| a.kind() == "string");
                        let registered = first.is_some_and(|s| {
                            let v = string_value(s, code);
                            v == name || v == kebab
                        });
                        if let (true, Some(value)) = (registered, args.and_then(|a| a.named_child(1))) {
                            found = Some(match value.kind() {
                                "identifier" => self.resolve(fi, value),
                                _ => Resolution::Found(Target::Decl { file: fi, byte: value.start_byte() }),
                            });
                        }
                    }
                    _ => {}
                }
            });
            if found.is_some() {
                return found;
            }
        }
        None
    }

    /// A component Nuxt registers from its `components/` folder, by the name it gives it
    /// (`components/base/Button.vue` → `BaseButton`; `Lazy` in front loads it on demand).
    fn nuxt_component(&self, file: usize, name: &str) -> Option<Resolution> {
        let (_, src) = self.project.nuxt_for(&self.files[file].rel)?;
        let dir = join(src, "components")?;
        let names = self.nuxt_components(&dir);
        let lazy = name.strip_prefix("Lazy").filter(|n| n.starts_with(|c: char| c.is_ascii_uppercase()));
        let rel = names.get(name).or_else(|| lazy.and_then(|n| names.get(n)))?;
        Some(Resolution::Found(Target::File(rel.clone())))
    }

    fn nuxt_components(&self, dir: &str) -> HashMap<String, String> {
        if let Some(found) = self.components.borrow().get(dir) {
            return found.clone();
        }
        let mut names = HashMap::new();
        for rel in self.project.files_under(dir) {
            let Some(inner) = rel.strip_prefix(dir).map(|r| r.trim_start_matches('/')) else {
                continue;
            };
            let Some((stem, ext)) = file_name(inner).split_once('.') else {
                continue;
            };
            if !COMPONENT_EXTENSIONS.contains(&ext.rsplit('.').next().unwrap_or(ext)) {
                continue;
            }
            let prefix: Vec<String> = parent(inner).split('/').filter(|s| !s.is_empty()).map(pascal).collect();
            // `Comments.client.vue`, `Map.server.vue`: one component either way.
            let stem = stem.trim_end_matches(".client").trim_end_matches(".server");
            let own = if stem == "index" { String::new() } else { pascal(stem) };
            names.entry(nuxt_name(&prefix, &own)).or_insert_with(|| rel.clone());
        }
        self.components.borrow_mut().insert(dir.to_string(), names.clone());
        names
    }

    /// A name an app uses undeclared because its framework imports it on its own: a
    /// Nuxt app's composables and utils, or Vue's and Nuxt's own API.
    pub(super) fn resolve_convention(&self, file: usize, name: &str, depth: usize) -> Option<Resolution> {
        let rel = &self.files[file].rel;
        if let Some((root, src)) = self.project.nuxt_for(rel) {
            let server = join(root, "server").unwrap_or_default();
            let in_server = rel.starts_with(&format!("{server}/"));
            let dirs: Vec<String> = if in_server {
                vec![format!("{server}/utils"), join(root, "shared/utils").unwrap_or_default(), join(root, "shared/types").unwrap_or_default()]
            } else {
                vec![
                    join(src, "composables").unwrap_or_default(),
                    join(src, "utils").unwrap_or_default(),
                    join(root, "shared/utils").unwrap_or_default(),
                    join(root, "shared/types").unwrap_or_default(),
                ]
            };
            for dir in &dirs {
                for f in self.project.files_under(dir) {
                    // Nuxt scans a folder's own files and its subfolders' `index` files.
                    let inner = &f[dir.len() + 1..];
                    let shallow = !inner.contains('/') || file_name(inner).starts_with("index.");
                    let Some(&fi) = self.file_index.get(f).filter(|_| shallow) else {
                        continue;
                    };
                    if !self.files[fi].source.contains(name) {
                        continue;
                    }
                    let Some(parsed) = self.parsed(fi) else {
                        continue;
                    };
                    if parsed.module.exports.contains_key(name) {
                        return Some(self.resolve_export(fi, name, depth + 1, &mut Vec::new()));
                    }
                    let stem = file_name(f).split('.').next().unwrap_or("");
                    if stem == name && parsed.module.exports.contains_key("default") {
                        return Some(self.resolve_export(fi, "default", depth + 1, &mut Vec::new()));
                    }
                }
            }
        }
        let auto_imports = self.project.nuxt_for(rel).is_some()
            || ["vue", "nuxt", "unplugin-auto-import"].iter().any(|d| self.project.has_dependency(d));
        (auto_imports && builtins::is_auto_imported(name)).then_some(Resolution::External)
    }

    /// Nuxt's `#components` and `#imports`: the project's components and auto-imports
    /// under their names.
    pub(super) fn virtual_import(&self, file: usize, imp: &Import, depth: usize) -> Option<Resolution> {
        self.project.nuxt_for(&self.files[file].rel)?;
        let ImportKind::Named(name) = &imp.kind else {
            return None;
        };
        match imp.spec.as_str() {
            "#components" => Some(self.nuxt_component(file, name).unwrap_or(Resolution::Unresolved)),
            "#imports" => Some(self.resolve_convention(file, name, depth).unwrap_or(Resolution::External)),
            _ => None,
        }
    }
}

/// The key named `name` an object or a list of strings declares: `{ name: .. }`,
/// `{ name() {} }`, `{ name }`, `['name']`.
fn declared_key<'t>(node: Node<'t>, code: &str, name: &str) -> Option<Node<'t>> {
    let mut cur = node.walk();
    let found = match node.kind() {
        "object" => node.named_children(&mut cur).find_map(|m| {
            let key = match m.kind() {
                "pair" => m.child_by_field_name("key"),
                "method_definition" => m.child_by_field_name("name"),
                "shorthand_property_identifier" => Some(m),
                _ => None,
            }?;
            let key_text = if key.kind() == "string" { string_value(key, code) } else { text(key, code) };
            (key_text == name).then_some(key)
        }),
        "array" => node
            .named_children(&mut cur)
            .filter(|e| e.kind() == "string")
            .find(|e| string_value(*e, code) == name)
            .and_then(|e| e.named_child(0)),
        _ => None,
    };
    found
}

/// The object a function returns: `data() { return { .. } }`, `() => ({ .. })`.
fn returned_object(func: Node) -> Option<Node> {
    let body = match func.kind() {
        "method_definition" | "function_expression" | "arrow_function" => func.child_by_field_name("body")?,
        _ => return None,
    };
    let mut expr = if body.kind() == "statement_block" {
        let mut cur = body.walk();
        let ret = body.named_children(&mut cur).filter(|s| s.kind() == "return_statement").last()?;
        ret.named_child(0)?
    } else {
        body
    };
    while expr.kind() == "parenthesized_expression" {
        expr = expr.named_child(0)?;
    }
    (expr.kind() == "object").then_some(expr)
}

/// The outermost expression starting where `node` does, short of the statement.
fn expression_at(node: Node) -> Node {
    let mut cur = node;
    while let Some(p) = cur.parent() {
        if p.start_byte() != node.start_byte() || matches!(p.kind(), "export_statement" | "program" | "expression_statement") {
            break;
        }
        cur = p;
    }
    cur
}

/// `my-button` → `MyButton`, `base` → `Base`.
fn pascal(s: &str) -> String {
    s.split(['-', '_'])
        .filter(|p| !p.is_empty())
        .map(|p| {
            let mut c = p.chars();
            c.next().map(|f| f.to_ascii_uppercase().to_string() + c.as_str()).unwrap_or_default()
        })
        .collect()
}

/// `MyButton` → `my-button`.
fn kebab(s: &str) -> String {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 {
                out.push('-');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// Nuxt's name for a component: its folders and its own name, without the folders its
/// name already repeats (`base/BaseButton` → `BaseButton`, not `BaseBaseButton`).
fn nuxt_name(prefix: &[String], own: &str) -> String {
    for k in 0..prefix.len() {
        let tail: String = prefix[k..].concat();
        if !own.is_empty() && own.starts_with(&tail) {
            return format!("{}{}", prefix[..k].concat(), own);
        }
    }
    format!("{}{}", prefix.concat(), own)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nuxt_names_components_by_folder() {
        let p = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(nuxt_name(&p(&["Base", "Foo"]), "Button"), "BaseFooButton");
        assert_eq!(nuxt_name(&p(&["Base"]), "BaseButton"), "BaseButton");
        assert_eq!(nuxt_name(&p(&["Ui"]), ""), "Ui");
        assert_eq!(nuxt_name(&p(&[]), "AppHeader"), "AppHeader");
        assert_eq!(kebab("MyButton"), "my-button");
        assert_eq!(pascal("my-button"), "MyButton");
    }
}
