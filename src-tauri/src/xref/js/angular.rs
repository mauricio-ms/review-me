//! Angular: the decorators that make a class a component, directive or pipe, and what
//! its templates' names mean. A free name in a template is a member of its component;
//! an element is the component whose selector matches it; an attribute the directive
//! whose does; `[input]` and `(output)` the matching component's or directive's member;
//! `| name` the pipe of that name. A selector, binding or pipe nothing in the project
//! declares is a library's or the DOM's — the index holds every one the project has.

use std::collections::HashMap;

use tree_sitter::Node;

use super::builtins;
use super::parse::{string_value, text};
use super::project::{join, parent};
use super::resolve::{finish, Member, Resolution, Target, Ty};
use super::sfc::{Tag, TagKind};
use super::{walk, JsIndex};

#[derive(Default)]
pub struct Angular {
    /// Element selectors (`app-hero`) → the classes they select.
    elements: HashMap<String, Vec<Target>>,
    /// Attribute selectors (`[appHighlight]`, `button[mat-button]`) → classes.
    attributes: HashMap<String, Vec<Target>>,
    pipes: HashMap<String, Vec<Target>>,
    /// External templates (`templateUrl`) → their component.
    templates: HashMap<String, Target>,
    /// A class → the selectors and pipe name templates write it by.
    written_as: HashMap<Target, Vec<String>>,
}

impl JsIndex {
    pub(super) fn angular(&self) -> &Angular {
        self.angular.get_or_init(|| self.build_angular())
    }

    fn build_angular(&self) -> Angular {
        let mut ng = Angular::default();
        for fi in 0..self.files.len() {
            let src = &self.files[fi].source;
            if !(src.contains("@Component") || src.contains("@Directive") || src.contains("@Pipe")) {
                continue;
            }
            let Some(parsed) = self.parsed(fi) else {
                continue;
            };
            let code = self.code(fi);
            let rel = self.files[fi].rel.clone();
            walk(parsed.tree.root_node(), &mut |n| {
                if n.kind() != "decorator" {
                    return;
                }
                let Some(call) = n.named_child(0).filter(|c| c.kind() == "call_expression") else {
                    return;
                };
                let kind = call.child_by_field_name("function").map(|f| text(f, code)).unwrap_or("");
                if !matches!(kind, "Component" | "Directive" | "Pipe") {
                    return;
                }
                let Some(class) = decorated_class(n) else {
                    return;
                };
                let target = Target::Decl { file: fi, byte: class.start_byte() };
                let Some(meta) = call.child_by_field_name("arguments").and_then(|a| a.named_child(0)) else {
                    return;
                };
                let mut written = Vec::new();
                for (key, value) in pairs(meta, code) {
                    match key {
                        "selector" => {
                            for sel in string_value(value, code).split(',') {
                                let (element, attrs) = simple_selector(sel.trim());
                                if attrs.is_empty() {
                                    if let Some(e) = element {
                                        ng.elements.entry(e.clone()).or_default().push(target.clone());
                                        written.push(e);
                                    }
                                }
                                for a in attrs {
                                    ng.attributes.entry(a.clone()).or_default().push(target.clone());
                                    written.push(a);
                                }
                            }
                        }
                        "templateUrl" => {
                            let url = string_value(value, code);
                            if let Some(path) = join(parent(&rel), url) {
                                ng.templates.insert(path, target.clone());
                            }
                        }
                        "name" if kind == "Pipe" => {
                            let name = string_value(value, code).to_string();
                            ng.pipes.entry(name.clone()).or_default().push(target.clone());
                            written.push(name);
                        }
                        _ => {}
                    }
                }
                if !written.is_empty() {
                    ng.written_as.insert(target, written);
                }
            });
        }
        ng
    }

    /// The names templates write the class `target` names by: its selectors, its pipe
    /// name. Empty for anything else.
    pub(super) fn angular_names(&self, target: &Target) -> Vec<String> {
        self.angular().written_as.get(target).cloned().unwrap_or_default()
    }

    /// The component whose template `byte` of `file` is in — `None` outside one, or in
    /// a page no component claims.
    fn angular_component(&self, file: usize, byte: usize) -> Option<Target> {
        let (_, _, class) = self.parsed(file)?.template.angular_at(byte)?;
        match class {
            Some(b) => Some(Target::Decl { file, byte: b }),
            None => self.angular().templates.get(&self.files[file].rel).cloned(),
        }
    }

    /// A free name in an Angular template: a member of its component.
    pub(super) fn resolve_angular_name(&self, file: usize, node: Node, name: &str, depth: usize) -> Option<Resolution> {
        let component = self.angular_component(file, node.start_byte())?;
        Some(match self.instance_member(&component, name, depth + 1) {
            Resolution::Unresolved if builtins::is_global(name) => Resolution::External,
            found => found,
        })
    }

    /// A member of the class `target` names, on its instances.
    fn instance_member(&self, class: &Target, name: &str, depth: usize) -> Resolution {
        let Target::Decl { file, byte } = class else {
            return Resolution::Unresolved;
        };
        let Some(decl) = self.node_at(*file, *byte).and_then(|n| n.parent()) else {
            return Resolution::Unresolved;
        };
        match self.lookup_member(&Ty::Class { file: *file, decl, instance: true }, name, depth + 1) {
            Member::Hits(hits) => finish(hits),
            Member::External => Resolution::External,
            Member::Missing { .. } => Resolution::Unresolved,
        }
    }

    /// An element, attribute, binding or pipe in an Angular template.
    pub(super) fn resolve_angular_tag(&self, tag: &Tag, depth: usize) -> Resolution {
        let ng = self.angular();
        let classes = |map: &HashMap<String, Vec<Target>>, name: &str| map.get(name).cloned();
        match tag.kind {
            TagKind::Element => classes(&ng.elements, &tag.name).map_or(Resolution::External, finish),
            TagKind::Pipe => classes(&ng.pipes, &tag.name).map_or(Resolution::External, finish),
            TagKind::Attribute => classes(&ng.attributes, &tag.name).map_or(Resolution::External, finish),
            TagKind::Input | TagKind::Output => {
                // The element's component's member; else a directive selected by the same
                // name (`[appHighlight]="color"`: its input, or the directive itself).
                let element = tag.element.as_deref().unwrap_or("");
                for class in ng.elements.get(element).into_iter().flatten() {
                    if let found @ (Resolution::Found(_) | Resolution::Ambiguous(_)) = self.instance_member(class, &tag.name, depth + 1) {
                        return found;
                    }
                }
                if let Some(directives) = ng.attributes.get(&tag.name) {
                    for class in directives {
                        if let found @ Resolution::Found(_) = self.instance_member(class, &tag.name, depth + 1) {
                            return found;
                        }
                    }
                    return finish(directives.clone());
                }
                // A DOM property or event, or a library directive's.
                Resolution::External
            }
            TagKind::Component => Resolution::Unresolved,
        }
    }
}

/// The class a decorator decorates: its parent, or the declaration of the `export` it's
/// written on.
fn decorated_class(decorator: Node) -> Option<Node> {
    let parent = decorator.parent()?;
    let class = match parent.kind() {
        "export_statement" => parent.child_by_field_name("declaration")?,
        _ => parent,
    };
    if !matches!(class.kind(), "class_declaration" | "abstract_class_declaration" | "class") {
        return None;
    }
    class.child_by_field_name("name")
}

/// An object literal's `key: value` pairs with literal keys.
fn pairs<'t>(object: Node<'t>, code: &'t str) -> Vec<(&'t str, Node<'t>)> {
    let mut cur = object.walk();
    let found = object
        .named_children(&mut cur)
        .filter(|p| p.kind() == "pair")
        .filter_map(|p| {
            let k = p.child_by_field_name("key")?;
            let key = if k.kind() == "string" { string_value(k, code) } else { text(k, code) };
            Some((key, p.child_by_field_name("value")?))
        })
        .collect();
    found
}

/// A simple CSS selector's element and attribute names: `button[mat-button]` →
/// (`button`, [`mat-button`]); `[appHighlight]` → (none, [`appHighlight`]); `app-hero` →
/// (`app-hero`, []). Classes and `:not(..)` are left out.
fn simple_selector(sel: &str) -> (Option<String>, Vec<String>) {
    let sel = sel.split(":not(").next().unwrap_or(sel);
    let element_end = sel.find(['[', '.', ':']).unwrap_or(sel.len());
    let element = Some(sel[..element_end].trim().to_ascii_lowercase()).filter(|e| !e.is_empty());
    let mut attrs = Vec::new();
    let mut rest = &sel[element_end..];
    while let Some(open) = rest.find('[') {
        let Some(close) = rest[open..].find(']') else {
            break;
        };
        let inner = &rest[open + 1..open + close];
        let name = inner.split(['=', '~', '|', '^', '$', '*']).next().unwrap_or(inner).trim();
        if !name.is_empty() {
            attrs.push(name.to_string());
        }
        rest = &rest[open + close + 1..];
    }
    (element, attrs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selectors() {
        assert_eq!(simple_selector("app-hero"), (Some("app-hero".into()), vec![]));
        assert_eq!(simple_selector("[appHighlight]"), (None, vec!["appHighlight".to_string()]));
        assert_eq!(simple_selector("button[mat-button]"), (Some("button".into()), vec!["mat-button".to_string()]));
        assert_eq!(simple_selector("input[type=text][formControl]"), (Some("input".into()), vec!["type".to_string(), "formControl".to_string()]));
        assert_eq!(simple_selector(".card"), (None, vec![]));
    }
}
