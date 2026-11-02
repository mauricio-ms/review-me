//! Lexical scope: which names a node of the tree declares, and which declaration a name
//! used somewhere refers to, scope by scope outward — short of the module's top level,
//! which `ModuleInfo` answers.

use tree_sitter::Node;

use super::parse::{declared_names, pattern_bindings, text};

/// TypeScript keeps types and values apart: `interface Foo` and `const Foo` can both
/// exist, and which one a use means depends on where it's written.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Space {
    Value,
    Type,
}

/// The node kinds a name is written as.
pub const NAME_KINDS: &[&str] = &[
    "identifier",
    "type_identifier",
    "property_identifier",
    "private_property_identifier",
    "shorthand_property_identifier",
    "shorthand_property_identifier_pattern",
];

/// Which spaces the declaration a name node is written in puts it in: (value, type).
pub fn spaces(name: Node) -> (bool, bool) {
    match name.parent().map(|p| p.kind()) {
        Some("interface_declaration" | "type_alias_declaration" | "type_parameter") => (false, true),
        Some(
            "class_declaration" | "abstract_class_declaration" | "class" | "enum_declaration"
            | "internal_module",
        ) => (true, true),
        _ => (true, false),
    }
}

pub fn in_space(name: Node, space: Space) -> bool {
    let (value, ty) = spaces(name);
    match space {
        Space::Value => value,
        Space::Type => ty,
    }
}

fn is_field(parent: Node, field: &str, node: Node) -> bool {
    parent.child_by_field_name(field).map(|n| n.id()) == Some(node.id())
}

/// Whether `node` is the name a declaration introduces, rather than a use of one.
pub fn is_declaration_name(node: Node) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    match parent.kind() {
        "function_declaration" | "generator_function_declaration" | "function_expression"
        | "generator_function" | "function_signature" | "class_declaration"
        | "abstract_class_declaration" | "class" | "interface_declaration"
        | "type_alias_declaration" | "enum_declaration" | "internal_module"
        | "method_definition" | "method_signature" | "abstract_method_signature"
        | "public_field_definition" | "property_signature" | "type_parameter"
        | "enum_assignment" => is_field(parent, "name", node),
        "field_definition" => is_field(parent, "property", node),
        "enum_body" => true,
        // An object literal's key.
        "pair" => is_field(parent, "key", node) && parent.parent().is_some_and(|g| g.kind() == "object"),
        "arrow_function" => is_field(parent, "parameter", node),
        _ => binds(node),
    }
}

/// Whether `node` sits in a binding position: a declarator's or parameter's pattern, a
/// `catch` parameter, a `for … of` binding.
fn binds(node: Node) -> bool {
    let mut child = node;
    let mut cur = node.parent();
    while let Some(p) = cur {
        match p.kind() {
            "object_pattern" | "array_pattern" | "rest_pattern" => {}
            "pair_pattern" => {
                if !is_field(p, "value", child) {
                    return false;
                }
            }
            "assignment_pattern" | "object_assignment_pattern" => {
                if !is_field(p, "left", child) {
                    return false;
                }
            }
            "variable_declarator" => return is_field(p, "name", child),
            "required_parameter" | "optional_parameter" => return is_field(p, "pattern", child),
            "formal_parameters" => return true,
            "catch_clause" => return is_field(p, "parameter", child),
            "for_in_statement" => {
                let mut cur = p.walk();
                let declares = p.children(&mut cur).any(|c| matches!(c.kind(), "const" | "let" | "var"));
                return declares && is_field(p, "left", child);
            }
            _ => return false,
        }
        child = p;
        cur = p.parent();
    }
    false
}

/// The declaration of `name` in the scopes around `node`, innermost first, stopping
/// short of the module's top level.
pub fn find_local<'t>(node: Node<'t>, code: &str, name: &str, space: Space) -> Option<Node<'t>> {
    let mut child = node;
    let mut cur = node.parent();
    while let Some(scope) = cur {
        if scope.kind() == "program" {
            return None;
        }
        if let Some(found) = declares(scope, child, code, name, space) {
            return Some(found);
        }
        child = scope;
        cur = scope.parent();
    }
    None
}

/// Statements that declare names in the block they sit in.
const DECLARING: &[&str] = &[
    "lexical_declaration",
    "variable_declaration",
    "function_declaration",
    "generator_function_declaration",
    "function_signature",
    "class_declaration",
    "abstract_class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "export_statement",
    "ambient_declaration",
    "expression_statement",
];

/// Whether `scope` itself binds `name` for code inside `child`.
fn declares<'t>(scope: Node<'t>, child: Node<'t>, code: &str, name: &str, space: Space) -> Option<Node<'t>> {
    let named = |n: &Node| text(*n, code) == name;
    match scope.kind() {
        "statement_block" | "switch_body" | "class_static_block" | "switch_case" | "switch_default" => {
            let mut cur = scope.walk();
            for stmt in scope.named_children(&mut cur) {
                if !DECLARING.contains(&stmt.kind()) {
                    continue;
                }
                if let Some(n) = declared_names(stmt).into_iter().find(|n| named(n) && in_space(*n, space)) {
                    return Some(n);
                }
            }
            // `var` anywhere in a function body belongs to the whole function.
            if space == Space::Value && scope.parent().is_some_and(|p| is_function(p.kind())) {
                return hoisted_var(scope, code, name);
            }
            None
        }
        k if is_function(k) => {
            if space == Space::Type {
                return type_parameter(scope, code, name);
            }
            if let Some(p) = scope.child_by_field_name("parameter") {
                if named(&p) {
                    return Some(p);
                }
            }
            if let Some(params) = scope.child_by_field_name("parameters") {
                let mut out = Vec::new();
                pattern_bindings(params, &mut out);
                if let Some(n) = out.into_iter().find(named) {
                    return Some(n);
                }
            }
            // A function expression's own name is bound inside it.
            if matches!(scope.kind(), "function_expression" | "generator_function") {
                return scope.child_by_field_name("name").filter(named);
            }
            None
        }
        "class_declaration" | "abstract_class_declaration" | "class" | "interface_declaration"
        | "type_alias_declaration" => {
            if space == Space::Type {
                if let Some(n) = type_parameter(scope, code, name) {
                    return Some(n);
                }
            }
            if scope.kind() == "class" {
                return scope.child_by_field_name("name").filter(named);
            }
            None
        }
        "catch_clause" => {
            let p = scope.child_by_field_name("parameter")?;
            let mut out = Vec::new();
            pattern_bindings(p, &mut out);
            out.into_iter().find(named)
        }
        "for_in_statement" => {
            let left = scope.child_by_field_name("left")?;
            if left.id() == child.id() {
                return None;
            }
            let mut out = Vec::new();
            pattern_bindings(left, &mut out);
            out.into_iter().find(named)
        }
        "for_statement" => {
            let init = scope.child_by_field_name("initializer")?;
            declared_names(init).into_iter().find(named)
        }
        _ => None,
    }
}

pub fn is_function(kind: &str) -> bool {
    matches!(
        kind,
        "function_declaration"
            | "generator_function_declaration"
            | "function_expression"
            | "generator_function"
            | "arrow_function"
            | "method_definition"
            | "function_signature"
            | "method_signature"
            | "abstract_method_signature"
            | "construct_signature"
            | "call_signature"
            | "function_type"
    )
}

fn type_parameter<'t>(decl: Node<'t>, code: &str, name: &str) -> Option<Node<'t>> {
    let params = decl.child_by_field_name("type_parameters")?;
    let mut cur = params.walk();
    let found = params
        .named_children(&mut cur)
        .filter_map(|p| p.child_by_field_name("name"))
        .find(|n| text(*n, code) == name);
    found
}

/// A `var` declared anywhere in a function body outside nested functions.
fn hoisted_var<'t>(body: Node<'t>, code: &str, name: &str) -> Option<Node<'t>> {
    let mut stack = vec![body];
    let mut cur = body.walk();
    while let Some(n) = stack.pop() {
        for c in n.named_children(&mut cur) {
            if is_function(c.kind()) || c.kind() == "class_declaration" || c.kind() == "class" {
                continue;
            }
            if c.kind() == "variable_declaration" {
                if let Some(found) = declared_names(c).into_iter().find(|d| text(*d, code) == name) {
                    return Some(found);
                }
            }
            stack.push(c);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::xref::js::parse::parse;

    /// The node at the n-th occurrence (0-based) of `word` in `src`.
    fn at<'t>(tree: &'t tree_sitter::Tree, src: &str, word: &str, nth: usize) -> Node<'t> {
        let byte = src.match_indices(word).nth(nth).unwrap().0;
        tree.root_node().named_descendant_for_byte_range(byte, byte).unwrap()
    }

    #[test]
    fn declarations_and_uses() {
        let src = "function f(a, { b }) { const [c] = g(a); return b + c; }\nclass K { m(x) {} f = 1 }\nconst o = { key: 1 };\ntry {} catch (err) {}\nfor (const it of list) {}\n";
        let p = parse("a.js", src).unwrap();
        let t = &p.tree;
        assert!(is_declaration_name(at(t, src, "a", 0)), "parameter");
        assert!(!is_declaration_name(at(t, src, "a", 1)), "argument");
        assert!(is_declaration_name(at(t, src, "b", 0)), "destructured parameter");
        assert!(is_declaration_name(at(t, src, "c]", 0)), "array pattern");
        assert!(is_declaration_name(at(t, src, "m(", 0)), "method");
        assert!(is_declaration_name(at(t, src, "key", 0)), "object key");
        assert!(is_declaration_name(at(t, src, "err", 0)), "catch parameter");
        assert!(is_declaration_name(at(t, src, "it", 0)), "for-of binding");
        assert!(!is_declaration_name(at(t, src, "list", 0)));
    }

    #[test]
    fn scopes_resolve_innermost_first() {
        let src = "function outer(x) {\n  const y = 1;\n  function inner(y) { return x + y; }\n  if (x) { var hoisted = 2; }\n  return y + hoisted;\n}\n";
        let p = parse("a.js", src).unwrap();
        let t = &p.tree;
        let use_x = at(t, src, "x + y", 0);
        assert_eq!(find_local(use_x, src, "x", Space::Value).unwrap().start_byte(), src.find("x)").unwrap());
        let use_y_inner = at(t, src, "y; }", 0);
        assert_eq!(
            find_local(use_y_inner, src, "y", Space::Value).unwrap().start_byte(),
            src.find("y) {").unwrap(),
            "the inner parameter shadows the outer const"
        );
        let use_y_outer = at(t, src, "y + hoisted", 0);
        assert_eq!(find_local(use_y_outer, src, "y", Space::Value).unwrap().start_byte(), src.find("y = 1").unwrap());
        let use_hoisted = at(t, src, "hoisted;", 0);
        assert_eq!(find_local(use_hoisted, src, "hoisted", Space::Value).unwrap().start_byte(), src.find("hoisted = 2").unwrap());
    }

    #[test]
    fn types_and_values_live_apart() {
        let src = "function f<T>(T: number): T { return T; }\n";
        let p = parse("a.ts", src).unwrap();
        let t = &p.tree;
        let ret_type = at(t, src, "T {", 0);
        assert_eq!(find_local(ret_type, src, "T", Space::Type).unwrap().start_byte(), src.find("T>").unwrap());
        let value = at(t, src, "T; }", 0);
        assert_eq!(find_local(value, src, "T", Space::Value).unwrap().start_byte(), src.find("T: number").unwrap());
    }
}
