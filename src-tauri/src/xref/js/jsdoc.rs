//! Source-positioned documentation symbols and types. The JS tree stays untouched.
use super::parse::{text, Import};
use super::resolve::{finish, Member, Module, Resolution, Target, Ty};
use super::scope::{self, Space};
use super::JsIndex;
use crate::xref::SymbolKind;
use std::collections::HashMap;
use tree_sitter::Node;

type TypeId = usize;
#[derive(Default)]
pub struct Docs {
    pub refs: Vec<Reference>,
    pub declarations: Vec<Declaration>,
    pub imports: HashMap<String, Vec<DocImport>>,
    types: Vec<DocType>,
    annotations: Vec<Annotation>,
}
pub struct DocImport {
    pub binding: Import,
    scope: (usize, usize),
}
pub struct Declaration {
    pub start: usize,
    pub name: String,
    pub scope: (usize, usize),
    pub kind: SymbolKind,
    pub exported: bool,
    ty: TypeId,
}
pub struct Reference {
    pub start: usize,
    pub end: usize,
    pub name: String,
    pub context: usize,
    pub kind: SymbolKind,
    path: Vec<String>,
    spec: Option<String>,
    value: bool,
    instance: bool,
    target: Option<DocTarget>,
}
#[derive(Clone)]
enum DocTarget {
    Code(usize),
    Doc(usize),
}
enum DocType {
    Unknown,
    External,
    Named {
        path: Vec<String>,
        spec: Option<String>,
        value: bool,
    },
    Record(Vec<usize>),
    Function {
        params: Vec<TypeId>,
        returns: TypeId,
    },
    Array(TypeId),
    Promise(TypeId),
    Tuple(Vec<TypeId>),
    Union(Vec<TypeId>),
    Intersection(Vec<TypeId>),
}
struct Annotation {
    target: usize,
    returns: bool,
    ty: TypeId,
}
#[derive(Clone)]
struct Token {
    text: String,
    start: usize,
    end: usize,
}
fn lex(code: &str, from: usize, to: usize) -> Vec<Token> {
    let mut out = Vec::new();
    let mut i = from;
    while i < to {
        let ch = code[i..].chars().next().unwrap();
        if ch.is_whitespace() {
            i += ch.len_utf8();
            continue;
        }
        let start = i;
        i += ch.len_utf8();
        if matches!(ch, '\'' | '"' | '`') {
            while i < to {
                let c = code[i..].chars().next().unwrap();
                i += c.len_utf8();
                if c == '\\' {
                    if i < to {
                        i += code[i..].chars().next().unwrap().len_utf8();
                    }
                } else if c == ch {
                    break;
                }
            }
        } else if ch.is_alphanumeric() || matches!(ch, '_' | '$') {
            while i < to {
                let c = code[i..].chars().next().unwrap();
                if !c.is_alphanumeric() && !matches!(c, '_' | '$' | '-') {
                    break;
                }
                i += c.len_utf8();
            }
        } else if ch == '.' && code[i..to].starts_with("..") {
            i += 2;
        } else if ch == '=' && code[i..to].starts_with('>') {
            i += 1;
        }
        out.push(Token {
            text: code[start..i].into(),
            start,
            end: i,
        });
    }
    out
}
fn ident(s: &str) -> bool {
    s.chars()
        .next()
        .is_some_and(|c| c.is_alphabetic() || matches!(c, '_' | '$'))
}
fn primitive(s: &str) -> bool {
    matches!(
        s,
        "string"
            | "String"
            | "number"
            | "Number"
            | "boolean"
            | "Boolean"
            | "void"
            | "null"
            | "undefined"
            | "never"
            | "symbol"
            | "bigint"
    )
}
/// Only consume the documented name, not its default value or description.
fn name_path(tokens: &[Token], start: usize) -> Vec<Token> {
    let Some(first) = tokens.get(start).filter(|t| ident(&t.text)) else {
        return Vec::new();
    };
    let mut path = vec![first.clone()];
    let mut i = start + 1;
    while i + 1 < tokens.len() {
        if tokens[i].text == "[" && tokens[i + 1].text == "]" {
            path.extend_from_slice(&tokens[i..i + 2]);
        } else if tokens[i].text == "." && ident(&tokens[i + 1].text) {
            path.push(tokens[i + 1].clone());
        } else {
            break;
        }
        i += 2;
    }
    path
}

impl Docs {
    pub fn import(&self, name: &str, at: usize) -> Option<&Import> {
        self.imports
            .get(name)?
            .iter()
            .filter(|i| i.scope.0 <= at && at < i.scope.1)
            .min_by_key(|i| i.scope.1 - i.scope.0)
            .map(|i| &i.binding)
    }
    fn ty(&mut self, ty: DocType) -> TypeId {
        let id = self.types.len();
        self.types.push(ty);
        id
    }
    fn reference(
        &mut self,
        token: &Token,
        context: usize,
        path: Vec<String>,
        spec: Option<String>,
        value: bool,
        instance: bool,
        target: Option<DocTarget>,
    ) {
        let kind = match target {
            Some(DocTarget::Doc(byte)) => self
                .declarations
                .iter()
                .find(|d| d.start == byte)
                .map_or(SymbolKind::Type, |d| d.kind),
            _ if value => SymbolKind::Identifier,
            _ => SymbolKind::Type,
        };
        self.refs.push(Reference {
            kind,
            start: token.start,
            end: token.end,
            name: token.text.clone(),
            context,
            path,
            spec,
            value,
            instance,
            target,
        });
    }
    fn property_path(
        &mut self,
        base: TypeId,
        path: &[Token],
        ty: TypeId,
        scope: (usize, usize),
    ) -> TypeId {
        if path.len() > 48 {
            return 0;
        }
        if path.is_empty() {
            return ty;
        }
        if path[0].text == "[" {
            let inner = if let DocType::Array(inner) = self.types[base] {
                inner
            } else {
                0
            };
            let inner = self.property_path(inner, &path[2.min(path.len())..], ty, scope);
            return self.ty(DocType::Array(inner));
        }
        let old = if let DocType::Record(fields) = &self.types[base] {
            fields
                .iter()
                .find(|i| self.declarations[**i].name == path[0].text)
                .copied()
        } else {
            None
        };
        let inner = old.map_or(0, |i| self.declarations[i].ty);
        let inner = self.property_path(inner, &path[1..], ty, scope);
        if let Some(old) = old {
            self.declarations[old].ty = inner;
            return base;
        }
        let field = self.declaration(&path[0], scope, SymbolKind::Field, inner, false);
        if let DocType::Record(fields) = &mut self.types[base] {
            fields.push(field);
            base
        } else {
            self.ty(DocType::Record(vec![field]))
        }
    }
    fn declaration(
        &mut self,
        token: &Token,
        scope: (usize, usize),
        kind: SymbolKind,
        ty: TypeId,
        exported: bool,
    ) -> usize {
        let id = self.declarations.len();
        self.declarations.push(Declaration {
            start: token.start,
            name: token.text.clone(),
            scope,
            kind,
            ty,
            exported,
        });
        self.reference(
            token,
            token.start,
            vec![],
            None,
            false,
            false,
            Some(DocTarget::Doc(token.start)),
        );
        id
    }
}
struct TypeParser<'a> {
    tokens: Vec<Token>,
    pos: usize,
    docs: &'a mut Docs,
    context: usize,
    scope: (usize, usize),
}
impl TypeParser<'_> {
    fn peek(&self) -> &str {
        self.tokens.get(self.pos).map_or("", |t| t.text.as_str())
    }
    fn eat(&mut self, s: &str) -> bool {
        if self.peek() == s {
            self.pos += 1;
            true
        } else {
            false
        }
    }
    fn parse(&mut self, depth: usize) -> TypeId {
        if depth > 24 {
            self.pos = self.tokens.len();
            return 0;
        }
        let mut parts = vec![self.intersection(depth + 1)];
        while self.eat("|") {
            parts.push(self.intersection(depth + 1));
        }
        if parts.len() == 1 {
            parts[0]
        } else {
            self.docs.ty(DocType::Union(parts))
        }
    }
    fn intersection(&mut self, depth: usize) -> TypeId {
        let mut parts = vec![self.primary(depth + 1)];
        while self.eat("&") {
            parts.push(self.primary(depth + 1));
        }
        if parts.len() == 1 {
            parts[0]
        } else {
            self.docs.ty(DocType::Intersection(parts))
        }
    }
    fn primary(&mut self, depth: usize) -> TypeId {
        if depth > 24 || self.pos >= self.tokens.len() {
            return 0;
        }
        let mut id = if self.eat("?") || self.eat("!") || self.eat("...") {
            self.primary(depth + 1)
        } else if self.eat("{") {
            let mut fields = Vec::new();
            while self.pos < self.tokens.len() && self.peek() != "}" {
                let token = self.tokens[self.pos].clone();
                self.pos += 1;
                if !ident(&token.text) && !token.text.starts_with(['\'', '"']) {
                    return 0;
                }
                self.eat("?");
                if !self.eat(":") {
                    return 0;
                }
                let ty = self.parse(depth + 1);
                fields.push(self.docs.declaration(
                    &token,
                    self.scope,
                    SymbolKind::Field,
                    ty,
                    false,
                ));
                if !self.eat(",") && !self.eat(";") {
                    break;
                }
            }
            if !self.eat("}") {
                return 0;
            }
            self.docs.ty(DocType::Record(fields))
        } else if self.eat("[") {
            let mut parts = Vec::new();
            while self.pos < self.tokens.len() && self.peek() != "]" {
                let before = self.pos;
                parts.push(self.parse(depth + 1));
                if self.pos == before || !self.eat(",") {
                    break;
                }
            }
            if !self.eat("]") {
                return 0;
            }
            self.docs.ty(DocType::Tuple(parts))
        } else if self.peek() == "(" || self.peek() == "function" {
            let closure = self.eat("function");
            if !self.eat("(") {
                return self.docs.ty(DocType::External);
            }
            let mut params = Vec::new();
            while self.pos < self.tokens.len() && self.peek() != ")" {
                let before = self.pos;
                if self
                    .tokens
                    .get(self.pos + 1)
                    .is_some_and(|t| t.text == ":" || t.text == "?")
                {
                    self.pos += 1;
                    self.eat("?");
                    self.eat(":");
                }
                params.push(self.parse(depth + 1));
                if self.pos == before || !self.eat(",") {
                    break;
                }
            }
            if !self.eat(")") {
                return 0;
            }
            if self.eat("=>") || (closure && self.eat(":")) {
                let returns = self.parse(depth + 1);
                self.docs.ty(DocType::Function { params, returns })
            } else if !closure && params.len() == 1 {
                params[0]
            } else {
                0
            }
        } else {
            let value = self.eat("typeof");
            let spec = if self.eat("import") {
                if !self.eat("(") {
                    return 0;
                }
                let Some(token) = self.tokens.get(self.pos) else {
                    return 0;
                };
                let spec = token.text.trim_matches(['\'', '"']).to_string();
                self.pos += 1;
                if !self.eat(")") || !self.eat(".") {
                    return 0;
                }
                Some(spec)
            } else {
                None
            };
            let Some(token) = self.tokens.get(self.pos).cloned() else {
                return 0;
            };
            self.pos += 1;
            if primitive(&token.text)
                || token.text.starts_with(['\'', '"'])
                || token.text.parse::<f64>().is_ok()
            {
                self.docs.ty(DocType::External)
            } else if !ident(&token.text)
                || matches!(
                    token.text.as_str(),
                    "any" | "unknown" | "object" | "Object" | "*"
                )
            {
                0
            } else {
                let mut path = vec![token.text.clone()];
                self.docs.reference(
                    &token,
                    self.context,
                    path.clone(),
                    spec.clone(),
                    value,
                    false,
                    None,
                );
                while self.peek() == "."
                    && self
                        .tokens
                        .get(self.pos + 1)
                        .is_some_and(|t| ident(&t.text))
                {
                    self.pos += 1;
                    let t = self.tokens[self.pos].clone();
                    self.pos += 1;
                    path.push(t.text.clone());
                    self.docs.reference(
                        &t,
                        self.context,
                        path.clone(),
                        spec.clone(),
                        value,
                        false,
                        None,
                    );
                }
                if self.peek() == "."
                    && self.tokens.get(self.pos + 1).is_some_and(|t| t.text == "<")
                {
                    self.pos += 1;
                }
                if self.eat("<") {
                    let mut args = Vec::new();
                    while self.pos < self.tokens.len() && self.peek() != ">" {
                        let before = self.pos;
                        args.push(self.parse(depth + 1));
                        if self.pos == before || !self.eat(",") {
                            break;
                        }
                    }
                    if !self.eat(">") {
                        return 0;
                    }
                    match path[0].as_str() {
                        "Array" | "ReadonlyArray" => self
                            .docs
                            .ty(DocType::Array(args.first().copied().unwrap_or(0))),
                        "Promise" | "PromiseLike" => self
                            .docs
                            .ty(DocType::Promise(args.first().copied().unwrap_or(0))),
                        _ => self.docs.ty(DocType::Named { path, spec, value }),
                    }
                } else {
                    self.docs.ty(DocType::Named { path, spec, value })
                }
            }
        };
        while self.eat("[") {
            if !self.eat("]") {
                return 0;
            }
            id = self.docs.ty(DocType::Array(id));
        }
        self.eat("=");
        id
    }
}

/// Mask prefixes using spaces of the same byte length, so every span stays in source.
fn body(raw: &str) -> String {
    let mut b = raw.as_bytes().to_vec();
    b[..3].fill(b' ');
    if raw.ends_with("*/") {
        let len = b.len();
        b[len - 2..].fill(b' ');
    }
    let mut prefix = true;
    for i in 3..b.len() {
        if b[i] == b'\n' {
            prefix = true;
        } else if prefix && matches!(b[i], b' ' | b'\t' | b'\r') {
        } else {
            if prefix && b[i] == b'*' {
                b[i] = b' ';
            }
            prefix = false;
        }
    }
    String::from_utf8(b).unwrap()
}
fn tag_ranges(body: &str) -> Vec<(String, usize, usize)> {
    let b = body.as_bytes();
    let mut tags: Vec<(String, usize, usize)> = Vec::new();
    let (mut i, mut line_start, mut active) = (3, true, false);
    let mut closes = Vec::new();
    let mut quote = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'\n' {
            line_start = true;
            active = false;
            if quote != b'`' {
                quote = 0;
            }
            i += 1;
            continue;
        }
        if quote != 0 {
            if c == b'\\' {
                i = (i + 2).min(b.len());
                continue;
            }
            if c == quote {
                quote = 0;
            }
        } else if c == b'@'
            && (line_start
                || (active && closes.is_empty() && i > 0 && b[i - 1].is_ascii_whitespace()))
        {
            let start = i;
            i += 1;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || matches!(b[i], b'_' | b'-')) {
                i += 1;
            }
            if i > start + 1 {
                if let Some(last) = tags.last_mut() {
                    last.2 = start;
                }
                tags.push((body[start + 1..i].to_lowercase(), i, b.len()));
                closes.clear();
                active = true;
                line_start = false;
                continue;
            }
        } else if matches!(c, b'\'' | b'"' | b'`') && !closes.is_empty() {
            quote = c;
        } else if c == b'{' {
            closes.push(b'}');
        } else if c == b'[' {
            closes.push(b']');
        } else if c == b'(' && !closes.is_empty() {
            closes.push(b')');
        } else if closes.last() == Some(&c) {
            closes.pop();
        }
        if !c.is_ascii_whitespace() {
            line_start = false;
        }
        i += 1;
    }
    tags
}
fn enclosing_scope(node: Node) -> (usize, usize) {
    let mut parent = node.parent();
    while let Some(p) = parent {
        if matches!(p.kind(), "program" | "statement_block" | "class_body") {
            return (p.start_byte(), p.end_byte());
        }
        parent = p.parent();
    }
    (0, usize::MAX)
}
fn owner(mut node: Node) -> Option<Node> {
    loop {
        node = node.next_named_sibling()?;
        if node.kind() != "comment" {
            break;
        }
    }
    if node.kind() == "export_statement" {
        node = node.child_by_field_name("declaration").unwrap_or(node);
    }
    Some(node)
}
fn function(node: Node) -> Option<Node> {
    if scope::is_function(node.kind()) {
        return Some(node);
    }
    if matches!(node.kind(), "lexical_declaration" | "variable_declaration") {
        return function(node.named_child(0)?);
    }
    if node.kind() == "variable_declarator" {
        return function(node.child_by_field_name("value")?);
    }
    None
}
fn bindings(node: Node) -> Vec<Node> {
    if matches!(node.kind(), "public_field_definition" | "field_definition") {
        return node
            .child_by_field_name("name")
            .or_else(|| node.child_by_field_name("property"))
            .into_iter()
            .collect();
    }
    super::parse::declared_names(node)
}

pub fn collect(root: Node, code: &str) -> Docs {
    let mut docs = Docs::default();
    docs.ty(DocType::Unknown);
    super::walk(root, &mut |comment| {
        if comment.kind() != "comment" {
            return;
        }
        let raw = text(comment, code);
        if !raw.starts_with("/**") || raw.starts_with("/***") {
            return;
        }
        let masked = body(raw);
        let offset = comment.start_byte();
        // Prefix masking is byte-preserving, allowing one lexer for multiline tags.
        let source = &masked;
        let context = comment.start_byte();
        let scope = enclosing_scope(comment);
        let owner = owner(comment);
        let func = owner.and_then(function);
        let mut definition = None;
        let mut protected = Vec::new();
        let tags = tag_ranges(&masked);
        let type_definition = tags
            .iter()
            .any(|(tag, _, _)| matches!(tag.as_str(), "typedef" | "callback"));
        for (tag, from, to) in tags {
            let mut tokens = lex(source, from, to);
            for t in &mut tokens {
                t.start += offset;
                t.end += offset;
            }
            let mut ty = 0;
            if !matches!(
                tag.as_str(),
                "type"
                    | "param"
                    | "arg"
                    | "argument"
                    | "returns"
                    | "return"
                    | "typedef"
                    | "callback"
                    | "template"
                    | "property"
                    | "prop"
                    | "import"
                    | "extends"
                    | "augments"
                    | "implements"
                    | "throws"
                    | "exception"
                    | "satisfies"
                    | "this"
                    | "enum"
                    | "yields"
                    | "yield"
            ) {
                continue;
            }
            if tokens.first().is_some_and(|t| t.text == "{") && tag != "import" {
                let mut depth = 0;
                let mut end = None;
                for (i, t) in tokens.iter().enumerate() {
                    if t.text == "{" {
                        depth += 1;
                    } else if t.text == "}" {
                        depth -= 1;
                        if depth == 0 {
                            end = Some(i);
                            break;
                        }
                    }
                }
                if let Some(end) = end {
                    protected.push((tokens[0].start, tokens[end].end));
                    let mut parser = TypeParser {
                        tokens: tokens[1..end].to_vec(),
                        pos: 0,
                        docs: &mut docs,
                        context,
                        scope,
                    };
                    ty = parser.parse(0);
                    if parser.pos != parser.tokens.len() {
                        ty = 0;
                    }
                    tokens.drain(..=end);
                } else {
                    continue;
                }
            }
            if tag == "import" {
                let payload = &source[from..to];
                let statement = format!("import {}", payload);
                let mut parser = tree_sitter::Parser::new();
                if parser
                    .set_language(&super::parse::Grammar::Ts.language())
                    .is_ok()
                {
                    if let Some(tree) = parser.parse(&statement, None) {
                        let module =
                            super::parse::module_info(tree.root_node(), &statement, false, false);
                        for (name, mut import) in module.imports {
                            import.local_byte = offset + from + import.local_byte.saturating_sub(7);
                            let token = Token {
                                start: import.local_byte,
                                end: import.local_byte + name.len(),
                                text: name.clone(),
                            };
                            docs.reference(
                                &token,
                                context,
                                vec![name.clone()],
                                None,
                                false,
                                false,
                                None,
                            );
                            docs.imports.entry(name).or_default().push(DocImport {
                                binding: import,
                                scope,
                            });
                        }
                    }
                }
                continue;
            }
            let optional = tokens.first().is_some_and(|t| t.text == "[");
            let name_at = usize::from(optional);
            let token = tokens.get(name_at).filter(|t| ident(&t.text)).cloned();
            if optional {
                if let (Some(a), Some(b)) = (tokens.first(), tokens.iter().find(|t| t.text == "]"))
                {
                    protected.push((a.start, b.end));
                }
            }
            match tag.as_str() {
                "typedef" | "callback" => {
                    if let Some(token) = token {
                        if tag == "callback" {
                            ty = docs.ty(DocType::Function {
                                params: Vec::new(),
                                returns: 0,
                            });
                        }
                        definition = Some(docs.declaration(
                            &token,
                            scope,
                            SymbolKind::Type,
                            ty,
                            scope.0 == 0,
                        ));
                    }
                }
                "template" => {
                    let template_scope = (
                        context,
                        if type_definition {
                            comment.end_byte()
                        } else {
                            owner.map_or(comment.end_byte(), |n| n.end_byte())
                        },
                    );
                    for group in tokens.split(|t| t.text == ",") {
                        if let Some(t) = group.iter().find(|t| ident(&t.text)) {
                            docs.declaration(t, template_scope, SymbolKind::Type, ty, false);
                        }
                    }
                }
                "property" | "prop" => {
                    if let (Some(d), Some(_)) = (definition, token) {
                        let path = name_path(&tokens, name_at);
                        let old = docs.declarations[d].ty;
                        docs.declarations[d].ty = docs.property_path(old, &path, ty, scope);
                    }
                }
                "param" | "arg" | "argument" => {
                    if let Some(d) = definition {
                        let id = docs.declarations[d].ty;
                        if let DocType::Function { params, .. } = &mut docs.types[id] {
                            params.push(ty);
                        }
                        if let Some(token) = token {
                            docs.declaration(
                                &token,
                                (context, comment.end_byte()),
                                SymbolKind::Identifier,
                                ty,
                                false,
                            );
                        }
                    } else if let (Some(func), Some(token)) = (func, token) {
                        let mut params = Vec::new();
                        if let Some(p) = func
                            .child_by_field_name("parameters")
                            .or_else(|| func.child_by_field_name("parameter"))
                        {
                            super::parse::pattern_bindings(p, &mut params);
                        }
                        if let Some(param) = params.iter().find(|n| text(**n, code) == token.text) {
                            let path = name_path(&tokens, name_at);
                            let path = &path[1..];
                            if tokens
                                .get(name_at + 1)
                                .is_some_and(|t| t.text == "." || t.text == "[")
                                && !path.is_empty()
                            {
                                let previous = docs
                                    .annotations
                                    .iter()
                                    .position(|a| a.target == param.start_byte() && !a.returns);
                                let base = previous.map_or(0, |i| docs.annotations[i].ty);
                                let shape = docs.property_path(base, path, ty, scope);
                                if let Some(i) = previous {
                                    docs.annotations[i].ty = shape;
                                } else {
                                    docs.annotations.push(Annotation {
                                        target: param.start_byte(),
                                        returns: false,
                                        ty: shape,
                                    });
                                }
                            } else {
                                docs.annotations.push(Annotation {
                                    target: param.start_byte(),
                                    returns: false,
                                    ty,
                                });
                            }
                            docs.reference(
                                &token,
                                context,
                                vec![],
                                None,
                                true,
                                false,
                                Some(DocTarget::Code(param.start_byte())),
                            );
                        }
                    }
                }
                "returns" | "return" => {
                    if let Some(d) = definition {
                        let id = docs.declarations[d].ty;
                        if let DocType::Function { returns, .. } = &mut docs.types[id] {
                            *returns = ty;
                        }
                    } else if let Some(func) = func {
                        docs.annotations.push(Annotation {
                            target: func.start_byte(),
                            returns: true,
                            ty,
                        });
                    }
                }
                "type" => {
                    if let Some(owner) = owner {
                        for binding in bindings(owner) {
                            docs.annotations.push(Annotation {
                                target: binding.start_byte(),
                                returns: false,
                                ty,
                            });
                        }
                    }
                }
                _ => {}
            }
        }
        // Inline links are separate from block tags. Never scan inside a type/default.
        for (i, _) in masked.match_indices("{@") {
            let start = offset + i;
            if protected.iter().any(|&(a, b)| a <= start && start < b) {
                continue;
            }
            let end = masked[i..].find('}').map_or(masked.len(), |e| i + e);
            let mut ts = lex(source, i + 2, end);
            for t in &mut ts {
                t.start += offset;
                t.end += offset;
            }
            if !ts
                .first()
                .is_some_and(|t| matches!(t.text.as_str(), "link" | "linkcode" | "linkplain"))
            {
                continue;
            }
            if ts.get(2).is_some_and(|t| t.text == ":") {
                continue;
            }
            let mut path = Vec::new();
            let mut instance = false;
            for t in ts.iter().skip(1) {
                if matches!(t.text.as_str(), "." | "#") {
                    instance |= t.text == "#";
                    continue;
                }
                if !ident(&t.text)
                    || (!path.is_empty()
                        && !ts
                            .iter()
                            .any(|p| p.end == t.start && matches!(p.text.as_str(), "." | "#")))
                {
                    break;
                }
                path.push(t.text.clone());
                docs.reference(t, context, path.clone(), None, true, instance, None);
            }
        }
    });
    docs.refs.sort_by_key(|r| r.start);
    docs
}

impl JsIndex {
    pub(super) fn resolve_doc(&self, file: usize, r: &Reference) -> Resolution {
        match r.target {
            Some(DocTarget::Code(byte)) => return Resolution::Found(Target::Decl { file, byte }),
            Some(DocTarget::Doc(byte)) => return Resolution::Found(Target::Doc { file, byte }),
            None => {}
        }
        self.doc_path(
            file,
            r.context,
            &r.path,
            r.spec.as_deref(),
            r.value,
            r.instance,
            0,
        )
    }
    fn doc_path(
        &self,
        file: usize,
        at: usize,
        path: &[String],
        spec: Option<&str>,
        value: bool,
        instance: bool,
        depth: usize,
    ) -> Resolution {
        if depth > 24 || path.is_empty() {
            return Resolution::Unresolved;
        }
        let mut result = if let Some(spec) = spec {
            match self.module(file, spec) {
                Module::Indexed(fi) => {
                    self.resolve_export(fi, &path[0], depth + 1, &mut Vec::new())
                }
                Module::External => Resolution::External,
                _ => Resolution::Unresolved,
            }
        } else {
            let Some(context) = self.node_at(file, at) else {
                return Resolution::Unresolved;
            };
            if value {
                if let Some(byte) = self
                    .parsed(file)
                    .and_then(|p| {
                        p.docs.refs.iter().find(|r| {
                            r.context == at
                                && r.name == path[0]
                                && matches!(r.target, Some(DocTarget::Code(_)))
                        })
                    })
                    .and_then(|r| match r.target {
                        Some(DocTarget::Code(b)) => Some(b),
                        _ => None,
                    })
                {
                    if path.len() == 1 {
                        return Resolution::Found(Target::Decl { file, byte });
                    }
                }
            }
            let mut found = self.resolve_name(file, context, &path[0], Space::Type, depth + 1);
            if value && matches!(found, Resolution::External | Resolution::Unresolved) {
                found = self.resolve_name(file, context, &path[0], Space::Value, depth + 1);
            }
            found
        };
        for name in path.iter().skip(1) {
            result = match result {
                Resolution::Found(t) => {
                    let ty = if instance || !value {
                        self.type_target(&t, depth + 1)
                    } else {
                        self.target_type(&t, depth + 1)
                    };
                    match self.lookup_member(&ty, name, depth + 1) {
                        Member::Hits(h) => finish(h),
                        Member::External => Resolution::External,
                        _ => Resolution::Unresolved,
                    }
                }
                other => other,
            };
        }
        result
    }
    pub(super) fn doc_declaration(
        &self,
        file: usize,
        name: &str,
        at: usize,
    ) -> Option<&Declaration> {
        self.parsed(file)?
            .docs
            .declarations
            .iter()
            .filter(|d| {
                d.kind == SymbolKind::Type && d.name == name && d.scope.0 <= at && at < d.scope.1
            })
            .min_by_key(|d| d.scope.1 - d.scope.0)
    }
    pub(super) fn doc_target<'a>(&'a self, file: usize, byte: usize, depth: usize) -> Ty<'a> {
        let Some(p) = self.parsed(file) else {
            return Ty::Unknown;
        };
        let Some(d) = p.docs.declarations.iter().find(|d| d.start == byte) else {
            return Ty::Unknown;
        };
        self.doc_ty(file, d.start, d.ty, depth + 1)
    }
    fn doc_ty<'a>(&'a self, file: usize, at: usize, id: TypeId, depth: usize) -> Ty<'a> {
        if depth > 24 {
            return Ty::Unknown;
        }
        let Some(p) = self.parsed(file) else {
            return Ty::Unknown;
        };
        match &p.docs.types[id] {
            DocType::Unknown => Ty::Unknown,
            DocType::External => Ty::External,
            DocType::Named { path, spec, value } => {
                match self.doc_path(file, at, path, spec.as_deref(), *value, false, depth + 1) {
                    Resolution::Found(t) if *value => self.target_type(&t, depth + 1),
                    Resolution::Found(t) => self.type_target(&t, depth + 1),
                    Resolution::External => Ty::External,
                    _ => Ty::Unknown,
                }
            }
            DocType::Record(fields) => Ty::DocShape { file, fields },
            DocType::Function { params, returns } => Ty::DocFunction {
                file,
                at,
                params,
                returns: *returns,
            },
            DocType::Array(t) => Ty::Array(Box::new(self.doc_ty(file, at, *t, depth + 1))),
            DocType::Promise(t) => Ty::Promise(Box::new(self.doc_ty(file, at, *t, depth + 1))),
            DocType::Tuple(ts) => Ty::Tuple(
                ts.iter()
                    .map(|t| self.doc_ty(file, at, *t, depth + 1))
                    .collect(),
            ),
            DocType::Union(ts) => {
                let variants: Vec<_> = ts
                    .iter()
                    .map(|t| self.doc_ty(file, at, *t, depth + 1))
                    .collect();
                if variants.iter().any(|t| matches!(t, Ty::Unknown)) {
                    Ty::Unknown
                } else {
                    Ty::Any(variants)
                }
            }
            DocType::Intersection(ts) => Ty::All(
                ts.iter()
                    .map(|t| self.doc_ty(file, at, *t, depth + 1))
                    .collect(),
            ),
        }
    }
    pub(super) fn doc_member(&self, file: usize, fields: &[usize], name: &str) -> Member {
        let Some(p) = self.parsed(file) else {
            return Member::Missing { complete: false };
        };
        let hits = fields
            .iter()
            .map(|i| &p.docs.declarations[*i])
            .filter(|d| d.name.trim_matches(['\'', '"']) == name)
            .map(|d| Target::Doc {
                file,
                byte: d.start,
            })
            .collect::<Vec<_>>();
        if hits.is_empty() {
            Member::Missing { complete: false }
        } else {
            Member::Hits(hits)
        }
    }
    pub(super) fn doc_type<'a>(
        &'a self,
        file: usize,
        node: Node<'a>,
        returns: bool,
        depth: usize,
    ) -> Option<Ty<'a>> {
        let docs = &self.parsed(file)?.docs;
        let target = if returns {
            let parent = node.parent()?;
            function(parent)
                .or_else(|| function(node))
                .map(|n| n.start_byte())?
        } else {
            node.start_byte()
        };
        if let Some(a) = docs
            .annotations
            .iter()
            .find(|a| a.target == target && a.returns == returns)
        {
            return Some(self.doc_ty(file, target, a.ty, depth + 1));
        }
        None
    }
    pub(super) fn doc_parameter_type<'a>(
        &'a self,
        ty: Ty<'a>,
        index: usize,
        depth: usize,
    ) -> Option<Ty<'a>> {
        if let Ty::DocFunction {
            file, at, params, ..
        } = ty
        {
            params
                .get(index)
                .map(|id| self.doc_ty(file, at, *id, depth + 1))
        } else {
            None
        }
    }
    pub(super) fn doc_function_return<'a>(&'a self, ty: Ty<'a>, depth: usize) -> Option<Ty<'a>> {
        if let Ty::DocFunction {
            file, at, returns, ..
        } = ty
        {
            Some(self.doc_ty(file, at, returns, depth + 1))
        } else {
            None
        }
    }
}
