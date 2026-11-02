//! Stylesheets: `.css`, `.scss`, `.sass`, `.less`, and components' `<style>` blocks, read
//! by a tokenizer of their own rather than a grammar. What has a definition here:
//!
//! - custom properties: `--accent: …` defines, `var(--accent)` uses — anywhere in the
//!   project, so a theme's overrides all answer (Ambiguous);
//! - SCSS variables, mixins, functions and placeholders, scoped by block and resolved
//!   through the module system: `@use 'x'` (namespaced, or `as *`), `@forward`, `@import`;
//! - LESS variables (`@gap: …`, `@gap`), scoped the same way;
//! - CSS modules' classes (`*.module.css`), which scripts reach as `styles.card`.

use std::cell::OnceCell;

use super::project::{file_name, join, parent};

pub const STYLE_EXTENSIONS: &[&str] = &["css", "scss", "sass", "less"];

pub fn is_stylesheet(rel: &str) -> bool {
    rel.rsplit_once('.').is_some_and(|(_, e)| STYLE_EXTENSIONS.contains(&e))
}

/// A CSS module: `Card.module.css`, whose classes a script imports.
pub fn is_css_module(rel: &str) -> bool {
    let name = file_name(rel);
    STYLE_EXTENSIONS.iter().any(|e| name.ends_with(&format!(".module.{e}")))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dialect {
    Css,
    Scss,
    Less,
}

impl Dialect {
    pub fn of(lang: &str) -> Dialect {
        match lang {
            "scss" | "sass" => Dialect::Scss,
            "less" => Dialect::Less,
            _ => Dialect::Css,
        }
    }
}

/// What a token names, by namespace: custom properties, variables, mixins, functions,
/// placeholders and classes never shadow one another.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Space {
    Custom,
    Var,
    Mixin,
    Function,
    Placeholder,
    Class,
}

#[derive(Clone, Debug)]
pub struct Token {
    pub space: Space,
    pub name: String,
    pub start: usize,
    pub len: usize,
    pub def: bool,
    /// `ns.$var`: the `@use` namespace it's reached through.
    pub ns: Option<String>,
    /// The block it's written in (0: the stylesheet's top).
    pub block: usize,
}

/// `@use`, `@forward` or `@import`: a stylesheet this one reads.
#[derive(Clone, Debug)]
pub struct Load {
    pub spec: String,
    pub start: usize,
    pub kind: LoadKind,
    /// `@use`'s namespace: its `as`, or the module's name; `None` for `as *`.
    pub ns: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LoadKind {
    Use,
    Forward,
    Import,
}

#[derive(Default, Debug)]
pub struct Tokens {
    pub tokens: Vec<Token>,
    pub loads: Vec<Load>,
    /// Each block's enclosing block (block 0 is the top and has none).
    pub parents: Vec<usize>,
}

/// One stylesheet: a file of its own, or a component's `<style>` blocks.
pub struct Sheet {
    /// The stylesheet's own text; a component's is its file's (`None`).
    pub source: Option<String>,
    /// Where it's written in that text, and in what.
    pub regions: Vec<(usize, usize, Dialect, bool)>,
    pub tokens: OnceCell<Tokens>,
}

impl Sheet {
    pub fn file(source: String, rel: &str) -> Sheet {
        let ext = rel.rsplit_once('.').map(|(_, e)| e).unwrap_or("css");
        let len = source.len();
        Sheet { source: Some(source), regions: vec![(0, len, Dialect::of(ext), is_css_module(rel))], tokens: OnceCell::new() }
    }

    /// A component's `<style>` blocks; `None` without any.
    pub fn component(source: &str) -> Option<Sheet> {
        let mut regions = Vec::new();
        let lower = source.to_ascii_lowercase();
        let mut from = 0;
        while let Some(at) = lower[from..].find("<style").map(|i| from + i) {
            let Some(open_end) = lower[at..].find('>').map(|i| at + i + 1) else {
                break;
            };
            let Some(close) = lower[open_end..].find("</style").map(|i| open_end + i) else {
                break;
            };
            let attrs = &source[at..open_end];
            let lang = attrs
                .split("lang=")
                .nth(1)
                .map(|v| v.trim_start_matches(['"', '\'']).split(['"', '\'', ' ', '>']).next().unwrap_or(""))
                .unwrap_or("css");
            let module = attrs.contains(" module");
            regions.push((open_end, close, Dialect::of(lang), module));
            from = close;
        }
        (!regions.is_empty()).then(|| Sheet { source: None, regions, tokens: OnceCell::new() })
    }

    pub fn tokens(&self, text: &str) -> &Tokens {
        self.tokens.get_or_init(|| {
            let mut out = Tokens { parents: vec![0], ..Tokens::default() };
            for &(a, b, dialect, module) in &self.regions {
                scan(text, a, b.min(text.len()), dialect, module, &mut out);
            }
            out
        })
    }

    pub fn region_at(&self, byte: usize) -> Option<(usize, usize, Dialect, bool)> {
        self.regions.iter().copied().find(|&(a, b, _, _)| a <= byte && byte < b)
    }
}

fn ident_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'-' || c == b'_' || c >= 0x80
}

fn read_ident(bytes: &[u8], mut i: usize, end: usize) -> usize {
    while i < end && ident_char(bytes[i]) {
        i += 1;
    }
    i
}

/// Tokenize `[a, b)` of `text`.
fn scan(text: &str, a: usize, b: usize, dialect: Dialect, module: bool, out: &mut Tokens) {
    let bytes = text.as_bytes();
    let mut i = a;
    // The innermost block, and each open block's own first class (for `&__elem`).
    let mut block = 0usize;
    let mut stack: Vec<(usize, Option<String>)> = vec![(0, None)];
    // In a declaration's value: from its `:` to its `;` or `}`.
    let mut in_value = false;
    // Parameters a `@mixin`/`@function`/`@each`/`@for` declares, for the block it opens.
    let mut params: Vec<(String, usize, usize)> = Vec::new();
    // The current selector's first class, until its block opens.
    let mut selector_class: Option<String> = None;
    let push = |out: &mut Tokens, space, name: &str, start, def, ns: Option<String>, block| {
        out.tokens.push(Token { space, name: name.to_string(), start, len: 0, def, ns, block });
        let t = out.tokens.last_mut().unwrap();
        t.len = t.name.len() + match space {
            Space::Var | Space::Placeholder => 1,
            Space::Custom => 2,
            _ => 0,
        };
    };
    while i < b {
        let c = bytes[i];
        match c {
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = text[i + 2..b].find("*/").map_or(b, |e| i + 2 + e + 2);
            }
            b'/' if bytes.get(i + 1) == Some(&b'/') && dialect != Dialect::Css && !text[..i].ends_with(':') => {
                i = text[i..b].find('\n').map_or(b, |e| i + e);
            }
            b'"' | b'\'' => {
                let close = text[i + 1..b].find(c as char).map_or(b, |e| i + 1 + e);
                i = close + 1;
            }
            b'{' => {
                let id = out.parents.len();
                out.parents.push(block);
                // A selector's `&` refers to the enclosing rule's first class.
                let parent_class = stack.last().and_then(|(_, c)| c.clone());
                let class = selector_class.take().or(parent_class);
                stack.push((id, class));
                block = id;
                for (name, start, len) in params.drain(..) {
                    out.tokens.push(Token { space: Space::Var, name, start, len, def: true, ns: None, block });
                }
                in_value = false;
                i += 1;
            }
            b'}' => {
                if stack.len() > 1 {
                    stack.pop();
                }
                block = stack.last().map_or(0, |(id, _)| *id);
                in_value = false;
                i += 1;
            }
            b';' => {
                in_value = false;
                selector_class = None;
                i += 1;
            }
            b':' if !in_value && block != 0 && bytes.get(i + 1) != Some(&b':') => {
                // `color: red` — though `a:hover {` is a selector; the value ends at `;`.
                let rest = &text[i..b];
                let next = rest.find(['{', ';', '}']).map(|e| rest.as_bytes()[e]);
                in_value = next != Some(b'{');
                i += 1;
            }
            b'@' => {
                let kw_end = read_ident(bytes, i + 1, b);
                let kw = &text[i + 1..kw_end];
                let line_end = text[kw_end..b].find([';', '{']).map_or(b, |e| kw_end + e);
                let line = &text[kw_end..line_end];
                match (dialect, kw) {
                    (Dialect::Scss, "use" | "forward") | (_, "import") => {
                        let kind = match kw {
                            "use" => LoadKind::Use,
                            "forward" => LoadKind::Forward,
                            _ => LoadKind::Import,
                        };
                        for (spec, at) in strings(line, kw_end) {
                            let ns = match kind {
                                LoadKind::Use => match line.split(" as ").nth(1).map(|n| n.split_whitespace().next().unwrap_or("")) {
                                    Some("*") => None,
                                    Some(n) => Some(n.to_string()),
                                    None => Some(module_name(&spec)),
                                },
                                _ => None,
                            };
                            out.loads.push(Load { spec, start: at, kind, ns });
                        }
                        i = line_end;
                    }
                    (Dialect::Scss, "mixin" | "function") => {
                        let name_start = kw_end + (line.len() - line.trim_start().len());
                        let name_end = read_ident(bytes, name_start, line_end);
                        let space = if kw == "mixin" { Space::Mixin } else { Space::Function };
                        push(out, space, &text[name_start..name_end], name_start, true, None, block);
                        // Its parameters are its body's variables; a default's are uses.
                        let mut j = name_end;
                        while let Some(d) = text[j..line_end].find('$').map(|d| j + d) {
                            let e = read_ident(bytes, d + 1, line_end);
                            let before = text[name_end..d].trim_end();
                            if before.ends_with('(') || before.ends_with(',') {
                                params.push((text[d + 1..e].to_string(), d, e - d));
                            } else {
                                push(out, Space::Var, &text[d + 1..e], d, false, None, block);
                            }
                            j = e.max(d + 1);
                        }
                        i = line_end;
                    }
                    (Dialect::Scss, "each" | "for") => {
                        // `@each $k, $v in $map`, `@for $i from 1 through $n`: the loop's own
                        // variables before `in`/`from`, uses after.
                        let split = line.find(" in ").or_else(|| line.find(" from ")).unwrap_or(line.len());
                        let mut j = kw_end;
                        while let Some(d) = text[j..kw_end + split].find('$').map(|d| j + d) {
                            let e = read_ident(bytes, d + 1, line_end);
                            params.push((text[d + 1..e].to_string(), d, e - d));
                            j = e.max(d + 1);
                        }
                        i = kw_end + split;
                    }
                    (Dialect::Scss, "include") => {
                        let name_start = kw_end + (line.len() - line.trim_start().len());
                        let name_end = read_ident(bytes, name_start, line_end);
                        let (ns, name_start, name_end) = if bytes.get(name_end) == Some(&b'.') {
                            let m_end = read_ident(bytes, name_end + 1, line_end);
                            (Some(text[name_start..name_end].to_string()), name_end + 1, m_end)
                        } else {
                            (None, name_start, name_end)
                        };
                        push(out, Space::Mixin, &text[name_start..name_end], name_start, false, ns, block);
                        i = name_end;
                    }
                    (Dialect::Scss, "extend") => {
                        if let Some(p) = line.find('%') {
                            let s = kw_end + p;
                            let e = read_ident(bytes, s + 1, line_end);
                            push(out, Space::Placeholder, &text[s + 1..e], s, false, None, block);
                        }
                        i = line_end;
                    }
                    (Dialect::Less, _) if !kw.is_empty() && !is_at_rule(kw) => {
                        // `@gap: 4px` defines, `@gap` elsewhere uses.
                        let after = text[kw_end..b].trim_start();
                        let def = after.starts_with(':') && !in_value;
                        push(out, Space::Var, kw, i, def, None, block);
                        if def {
                            in_value = true;
                        }
                        i = kw_end;
                    }
                    _ => i = kw_end.max(i + 1),
                }
            }
            b'$' if dialect == Dialect::Scss => {
                let e = read_ident(bytes, i + 1, b);
                if e > i + 1 {
                    let after = text[e..b].trim_start();
                    let def = after.starts_with(':') && !after.starts_with("::") && !in_value;
                    push(out, Space::Var, &text[i + 1..e], i, def, None, block);
                    if def {
                        in_value = true;
                    }
                }
                i = e.max(i + 1);
            }
            b'-' if bytes.get(i + 1) == Some(&b'-') && (i == a || !ident_char(bytes[i - 1])) => {
                let e = read_ident(bytes, i + 2, b);
                if e > i + 2 {
                    let after = text[e..b].trim_start();
                    let def = after.starts_with(':') && !in_value;
                    push(out, Space::Custom, &text[i + 2..e], i, def, None, block);
                    if def {
                        in_value = true;
                    }
                }
                i = e.max(i + 2);
            }
            b'%' if dialect == Dialect::Scss && !in_value => {
                let e = read_ident(bytes, i + 1, b);
                if e > i + 1 {
                    push(out, Space::Placeholder, &text[i + 1..e], i, true, None, block);
                }
                i = e.max(i + 1);
            }
            b'.' if !in_value && module => {
                let e = read_ident(bytes, i + 1, b);
                if e > i + 1 && !bytes[i + 1].is_ascii_digit() {
                    let name = &text[i + 1..e];
                    push(out, Space::Class, name, i + 1, true, None, block);
                    out.tokens.last_mut().unwrap().len = name.len();
                    selector_class.get_or_insert_with(|| name.to_string());
                }
                i = e.max(i + 1);
            }
            b'&' if !in_value && module => {
                // `&__title` in `.card { }`: the class `card__title`.
                let e = read_ident(bytes, i + 1, b);
                let parent_class = stack.last().and_then(|(_, c)| c.clone());
                if let (true, Some(base)) = (e > i + 1, parent_class) {
                    let name = format!("{base}{}", &text[i + 1..e]);
                    push(out, Space::Class, &name, i, true, None, block);
                    out.tokens.last_mut().unwrap().len = e - i;
                    selector_class.get_or_insert(name);
                }
                i = e.max(i + 1);
            }
            c if dialect == Dialect::Scss && in_value && (c.is_ascii_alphabetic() || c == b'_') && (i == a || !ident_char(bytes[i - 1])) => {
                let e = read_ident(bytes, i, b);
                // `ns.$var`, `ns.fn(..)`, or `fn(..)` — a function only if one's declared.
                if bytes.get(e) == Some(&b'.') && bytes.get(e + 1) == Some(&b'$') {
                    let ve = read_ident(bytes, e + 2, b);
                    push(out, Space::Var, &text[e + 2..ve], e + 1, false, Some(text[i..e].to_string()), block);
                    i = ve;
                    continue;
                }
                if bytes.get(e) == Some(&b'.') {
                    let fe = read_ident(bytes, e + 1, b);
                    if bytes.get(fe) == Some(&b'(') {
                        push(out, Space::Function, &text[e + 1..fe], e + 1, false, Some(text[i..e].to_string()), block);
                        i = fe;
                        continue;
                    }
                }
                if bytes.get(e) == Some(&b'(') {
                    push(out, Space::Function, &text[i..e], i, false, None, block);
                }
                i = e.max(i + 1);
            }
            _ => i += text[i..].chars().next().map_or(1, char::len_utf8),
        }
    }
}

/// LESS's own at-rules, which aren't variables.
fn is_at_rule(kw: &str) -> bool {
    matches!(
        kw,
        "media" | "import" | "charset" | "font-face" | "keyframes" | "supports" | "page"
            | "namespace" | "layer" | "container" | "plugin" | "property" | "document"
            | "viewport" | "counter-style" | "font-feature-values" | "-webkit-keyframes"
    )
}

/// The quoted strings in `line` (which starts at `offset`), and where each starts.
fn strings(line: &str, offset: usize) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' || bytes[i] == b'\'' {
            let q = bytes[i] as char;
            if let Some(e) = line[i + 1..].find(q) {
                out.push((line[i + 1..i + 1 + e].to_string(), offset + i + 1));
                i += e + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// A module's default namespace: `'src/corners'` → `corners`, `'_vars.scss'` → `vars`.
fn module_name(spec: &str) -> String {
    let last = spec.rsplit(['/', ':']).next().unwrap_or(spec);
    let last = last.trim_start_matches('_');
    last.split('.').next().unwrap_or(last).to_string()
}

/// The stylesheet a Sass `@use`/`@forward`/`@import` written in `from` loads, among
/// `exists` — tried as written, as a partial (`_name`), with each extension, and as a
/// folder's `_index`. `candidates` are where else the spec may point (aliases).
pub fn sass_module(from: &str, spec: &str, candidates: &[String], exists: &dyn Fn(&str) -> bool) -> Option<String> {
    if spec.starts_with("sass:") || spec.starts_with("http") || spec.starts_with("url(") {
        return None;
    }
    let mut bases: Vec<String> = Vec::new();
    if let Some(local) = join(parent(from), spec.trim_start_matches('~')) {
        bases.push(local);
    }
    bases.extend(candidates.iter().cloned());
    for base in bases {
        let dir = parent(&base);
        let name = file_name(&base);
        let with = |n: &str| if dir.is_empty() { n.to_string() } else { format!("{dir}/{n}") };
        let mut tries = vec![base.clone()];
        for ext in ["scss", "sass", "css", "less"] {
            tries.push(format!("{base}.{ext}"));
            tries.push(with(&format!("_{name}.{ext}")));
        }
        for ext in ["scss", "sass", "css"] {
            tries.push(format!("{base}/_index.{ext}"));
            tries.push(format!("{base}/index.{ext}"));
        }
        if let Some(found) = tries.into_iter().find(|t| exists(t) && STYLE_EXTENSIONS.iter().any(|e| t.ends_with(&format!(".{e}")))) {
            return Some(found);
        }
    }
    None
}

/// `card-title` → `cardTitle`: how CSS modules expose a dashed class to scripts.
pub fn camel(name: &str) -> String {
    let mut out = String::new();
    let mut up = false;
    for c in name.chars() {
        if c == '-' {
            up = true;
        } else if up {
            out.extend(c.to_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(rel: &str, src: &str) -> Vec<(Space, String, bool, Option<String>)> {
        let sheet = Sheet::file(src.to_string(), rel);
        sheet.tokens(src).tokens.iter().map(|t| (t.space, t.name.clone(), t.def, t.ns.clone())).collect()
    }

    #[test]
    fn custom_properties_and_scss() {
        let src = "@use 'sass:math';\n@use 'tokens' as t;\n$gap: 4px !default;\n:root { --accent: #f00; }\n@mixin card($pad) { padding: $pad; }\n.a { color: var(--accent); margin: t.$space; @include card($gap); width: math.div(1, 2); &:hover { color: red; } }\n%box { x: 1 }\n.b { @extend %box; }\n";
        let toks = tokens("a.scss", src);
        for want in [
            (Space::Var, "gap", true, None),
            (Space::Custom, "accent", true, None),
            (Space::Mixin, "card", true, None),
            (Space::Var, "pad", true, None),
            (Space::Var, "pad", false, None),
            (Space::Custom, "accent", false, None),
            (Space::Var, "space", false, Some("t")),
            (Space::Mixin, "card", false, None),
            (Space::Var, "gap", false, None),
            (Space::Function, "div", false, Some("math")),
            (Space::Placeholder, "box", true, None),
            (Space::Placeholder, "box", false, None),
        ] {
            let want = (want.0, want.1.to_string(), want.2, want.3.map(String::from));
            assert!(toks.contains(&want), "{want:?} in {toks:?}");
        }
        assert!(!toks.iter().any(|t| t.0 == Space::Class), "classes only in modules");
        let sheet = Sheet::file(src.to_string(), "a.scss");
        let loads = &sheet.tokens(src).loads;
        assert_eq!(loads.iter().map(|l| (l.spec.as_str(), l.ns.as_deref())).collect::<Vec<_>>(), vec![("sass:math", Some("math")), ("tokens", Some("t"))]);
    }

    #[test]
    fn module_classes_and_less() {
        let toks = tokens("Card.module.scss", ".card { padding: 1px; &__title { x: 1 } &.on { y: 2 } }\n.card-body .x:hover { z: 0.5em }\n");
        let classes: Vec<&str> = toks.iter().filter(|t| t.0 == Space::Class).map(|t| t.1.as_str()).collect();
        assert_eq!(classes, vec!["card", "card__title", "on", "card-body", "x"]);
        let less = tokens("a.less", "@gap: 4px;\n@media (min-width: 1px) { .a { margin: @gap; } }\n");
        assert!(less.contains(&(Space::Var, "gap".into(), true, None)));
        assert!(less.contains(&(Space::Var, "gap".into(), false, None)));
        assert!(!less.iter().any(|t| t.1 == "media"));
    }

    #[test]
    fn component_style_blocks() {
        let src = "<template><p/></template>\n<style lang=\"scss\" scoped>\n$c: red;\np { color: $c; }\n</style>\n<style module>\n.title { x: 1 }\n</style>\n";
        let sheet = Sheet::component(src).unwrap();
        assert_eq!(sheet.regions.len(), 2);
        let toks = &sheet.tokens(src).tokens;
        assert!(toks.iter().any(|t| t.name == "c" && t.def));
        assert!(toks.iter().any(|t| t.space == Space::Class && t.name == "title"));
    }

    #[test]
    fn sass_resolves_partials_and_indexes() {
        let files = ["src/styles/_vars.scss", "src/styles/mixins/_index.scss", "src/app.scss"];
        let exists = |p: &str| files.contains(&p);
        assert_eq!(sass_module("src/app.scss", "styles/vars", &[], &exists), Some("src/styles/_vars.scss".to_string()));
        assert_eq!(sass_module("src/app.scss", "./styles/mixins", &[], &exists), Some("src/styles/mixins/_index.scss".to_string()));
        assert_eq!(sass_module("src/app.scss", "sass:math", &[], &exists), None);
        assert_eq!(module_name("src/_corners.scss"), "corners");
        assert_eq!(camel("card-title"), "cardTitle");
    }
}
