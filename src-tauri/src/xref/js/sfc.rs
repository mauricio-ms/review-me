//! Single-file components (`.vue`, `.svelte`, `.astro`) read as one TypeScript or
//! JavaScript program laid out at the file's own byte offsets: the scripts copied as they
//! are, each template expression copied in place as a statement of its own, everything
//! else blanked. Every position in the tree is then a position in the file, and a name
//! in the template resolves in the script's scope like any other.
//!
//! What the program can't say, the template's side tables do: the names a template binds
//! (`v-for`, slot props, `{#each}`, `{@const}`, `let:`) with the bytes they're visible
//! across, and the components its tags use.

use super::parse::Grammar;

/// A name a template binds — `v-for="item in items"`, `{#each items as item}` — and the
/// bytes it's visible across.
#[derive(Debug, Clone)]
pub struct TemplateBinding {
    pub name: String,
    pub byte: usize,
    pub scope: (usize, usize),
    /// Where the value it takes is written, and whether it takes that value's elements
    /// (`v-for`, `{#each}`, `@for`) rather than the value itself (`@if (x; as a)`).
    pub of: Option<(usize, usize, bool)>,
}

/// Something a template names that no expression does: a component tag, and in Angular
/// an element or attribute selector, a bound input or output, a pipe.
#[derive(Debug, Clone)]
pub struct Tag {
    pub byte: usize,
    pub len: usize,
    /// The name in script (`my-button` → `MyButton`), or as Angular matches it.
    pub name: String,
    pub kind: TagKind,
    /// The element an Angular attribute, input or output is written on.
    pub element: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagKind {
    /// A component tag, by the name the script gives it.
    Component,
    /// Angular: an element, matched by its components' selectors.
    Element,
    /// Angular: a plain attribute, perhaps a directive's selector.
    Attribute,
    /// Angular: `[name]`, an input of the element's component or directive.
    Input,
    /// Angular: `(name)`, an output.
    Output,
    /// Angular: `| name`.
    Pipe,
}

#[derive(Debug, Default)]
pub struct Template {
    pub bindings: Vec<TemplateBinding>,
    pub tags: Vec<Tag>,
    /// Where the template's expressions are: names there see what the template sees
    /// (Vue's props and options, unwrapped refs).
    pub exprs: Vec<(usize, usize)>,
    /// Angular templates: where each is, and where its component class's name is
    /// written when the template is inline (an external one is found by its path).
    pub angular: Vec<(usize, usize, Option<usize>)>,
}

impl Template {
    pub fn binding(&self, name: &str, at: usize) -> Option<&TemplateBinding> {
        self.bindings
            .iter()
            .filter(|b| b.name == name && b.scope.0 <= at && at < b.scope.1)
            .max_by_key(|b| b.scope.0)
    }

    pub fn tag_at(&self, byte: usize) -> Option<&Tag> {
        self.tags.iter().find(|t| t.byte <= byte && byte < t.byte + t.len)
    }

    pub fn in_template(&self, byte: usize) -> bool {
        self.exprs.iter().any(|&(a, b)| a <= byte && byte <= b)
    }

    /// The Angular template `byte` is in.
    pub fn angular_at(&self, byte: usize) -> Option<(usize, usize, Option<usize>)> {
        self.angular.iter().copied().find(|&(a, b, _)| a <= byte && byte < b)
    }
}

pub struct VirtualDoc {
    pub grammar: Grammar,
    pub code: String,
    pub template: Template,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Flavor {
    Vue,
    Svelte,
    Astro,
    Angular,
}

/// What the scripts a scan copies are written in.
#[derive(Default)]
struct Lang {
    typed: bool,
    tsx: bool,
}

/// The program a single-file component reads as. `None` for any other file.
pub fn virtual_doc(rel: &str, source: &str) -> Option<VirtualDoc> {
    let flavor = match rel.rsplit_once('.')?.1 {
        "vue" => Flavor::Vue,
        "svelte" => Flavor::Svelte,
        "astro" => Flavor::Astro,
        // An Angular template — or any page, whose `{{ }}` and scripts read the same.
        "html" | "htm" => Flavor::Angular,
        _ => return None,
    };
    let mut b = Builder::new(source);
    let mut lang = Lang { typed: matches!(flavor, Flavor::Astro | Flavor::Angular), tsx: flavor == Flavor::Astro };
    let mut start = 0;
    if flavor == Flavor::Astro {
        // The frontmatter fence: TypeScript between two `---` lines.
        let trimmed = source.trim_start();
        if trimmed.starts_with("---") {
            let open = source.len() - trimmed.len() + 3;
            if let Some(close) = source[open..].find("\n---") {
                b.copy(open, open + close);
                start = open + close + 4;
            }
        }
    }
    if flavor == Flavor::Angular {
        b.template.angular.push((0, source.len(), None));
    }
    scan(&mut b, start, source.len(), flavor, &mut lang);
    let grammar = if lang.tsx {
        Grammar::Tsx
    } else if lang.typed {
        Grammar::Ts
    } else {
        Grammar::Js
    };
    Some(VirtualDoc { grammar, code: b.finish(), template: b.template })
}

/// A TypeScript file whose `@Component`s write their templates inline
/// (``template: `<p>{{ name }}</p>` ``): the file itself, each template laid out in place
/// as the body of an arrow function — ``template: (()=>{ ;name; })`` — so its names are
/// in the tree. `None` when it has none.
pub fn inline_angular(source: &str) -> Option<VirtualDoc> {
    if !source.contains("@Component") || !source.contains("template") {
        return None;
    }
    let mut b = Builder::new(source);
    b.copy(0, source.len());
    let mut found = false;
    let mut from = 0;
    while let Some(k) = source[from..].find("template:") {
        let at = from + k + "template:".len();
        from = at;
        let ws = source[at..].len() - source[at..].trim_start().len();
        let open = at + ws;
        if source.as_bytes().get(open) != Some(&b'`') {
            continue;
        }
        let Some(close) = source[open + 1..].find('`').map(|e| open + 1 + e) else {
            break;
        };
        from = close + 1;
        let content = &source[open + 1..close];
        // A literal with substitutions isn't a template Angular reads; one too short to
        // hold the wrapper, or opening or closing on an interpolation, isn't worth it.
        if content.contains("${") || content.len() < 8 || content[..5].contains('{') || content.ends_with('}') {
            continue;
        }
        b.blank(open, close + 1);
        b.reserve(open, b"(()=>{");
        b.reserve(close - 1, b"})");
        // The class the decorator decorates: the next `class Name` after it.
        let class = source[close..].find("class ").map(|c| close + c + 6).map(|n| {
            n + source[n..].len() - source[n..].trim_start().len()
        });
        b.template.angular.push((open, close + 1, class));
        scan(&mut b, open + 6, close - 1, Flavor::Angular, &mut Lang::default());
        found = true;
    }
    found.then(|| VirtualDoc { grammar: Grammar::Ts, code: b.finish(), template: b.template })
}

/// Read `[start, end)` of the builder's source as markup of `flavor`.
fn scan(b: &mut Builder, start: usize, end: usize, flavor: Flavor, lang: &mut Lang) {
    let source = b.source;
    let mut stack: Vec<Open> = Vec::new();
    let mut blocks: Vec<Open> = Vec::new();
    // Vue: only the top-level `<template>`'s contents are a template.
    let mut template_depth: Option<usize> = None;
    let mut i = start;
    let bytes = &source.as_bytes()[..end];
    while i < bytes.len() {
        if source[i..].starts_with("<!--") {
            i = source[i..].find("-->").map_or(bytes.len(), |e| i + e + 3);
            continue;
        }
        if bytes[i] == b'<' && bytes.get(i + 1).is_some_and(|c| c.is_ascii_alphabetic()) {
            let tag = read_tag(source, i, flavor);
            let lower = tag.name.to_ascii_lowercase();
            if lower == "script" || lower == "style" {
                let close = format!("</{lower}");
                let end = find_ci(source, tag.end, &close).unwrap_or(bytes.len());
                let at_top = flavor != Flavor::Vue || stack.is_empty();
                if lower == "script" && at_top && !tag.self_closing && tag.attr_value(source, "src").is_none() {
                    let written = tag.attr_value(source, "lang");
                    lang.typed |= matches!(written, Some("ts" | "tsx"));
                    lang.tsx |= written == Some("tsx");
                    b.copy(tag.end, end);
                }
                i = source[end..].find('>').map_or(bytes.len(), |e| end + e + 1);
                continue;
            }
            let in_template = match flavor {
                Flavor::Vue => template_depth.is_some(),
                _ => true,
            };
            if flavor == Flavor::Vue && template_depth.is_none() && stack.is_empty() && lower == "template" {
                if tag.attr_value(source, "lang").is_some_and(|l| l != "html") {
                    // A template in Pug, say: nothing to read.
                    let end = find_ci(source, tag.end, "</template").unwrap_or(bytes.len());
                    i = end;
                    continue;
                }
                template_depth = Some(stack.len() + 1);
            } else if in_template {
                b.element(source, &tag, flavor);
                // An element's bindings (`v-for`, slot props, `let:`) are visible across
                // all of it, its own attributes included.
                for &k in &b.pending {
                    b.template.bindings[k].scope.0 = i;
                }
            }
            let bound: Vec<usize> = b.pending.drain(..).collect();
            if !tag.self_closing && !is_void(&lower) {
                stack.push(Open { name: lower, start: i, bindings: bound });
            } else {
                b.close_scope(&bound, tag.end);
            }
            i = tag.end;
            continue;
        }
        if bytes[i] == b'<' && bytes.get(i + 1) == Some(&b'/') {
            let name_end = source[i + 2..]
                .find(|c: char| c == '>' || c.is_whitespace())
                .map_or(bytes.len(), |e| i + 2 + e);
            let name = source[i + 2..name_end].to_ascii_lowercase();
            let end = source[i..].find('>').map_or(bytes.len(), |e| i + e + 1);
            if let Some(pos) = stack.iter().rposition(|o| o.name == name) {
                for open in stack.drain(pos..).rev() {
                    b.close_scope(&open.bindings, end);
                }
                if template_depth.is_some_and(|d| stack.len() < d) {
                    template_depth = None;
                }
            }
            i = end;
            continue;
        }
        let in_template = flavor != Flavor::Vue || template_depth.is_some();
        match flavor {
            Flavor::Vue if in_template && source[i..].starts_with("{{") => {
                let close = source[i + 2..].find("}}").map_or(bytes.len(), |e| i + 2 + e);
                b.expr(i + 2, close);
                i = close + 2;
            }
            Flavor::Angular if source[i..].starts_with("{{") => {
                let close = source[i + 2..end].find("}}").map_or(bytes.len(), |e| i + 2 + e);
                b.angular_expr(i + 2, close);
                i = close + 2;
            }
            Flavor::Angular if bytes[i] == b'@' => {
                i = b.angular_block(i, end, &mut blocks, stack.last().map(|o| o.start));
            }
            Flavor::Angular if bytes[i] == b'}' => {
                if let Some(block) = blocks.pop() {
                    b.close_scope(&block.bindings, i + 1);
                }
                i += 1;
            }
            Flavor::Svelte | Flavor::Astro if bytes[i] == b'{' => {
                let close = matching_brace(source, i).unwrap_or(bytes.len());
                if flavor == Flavor::Svelte {
                    b.svelte_mustache(source, i, close, &mut blocks, &stack);
                    // `{@const}` outside a block: visible to the end of its element.
                    let bound: Vec<usize> = b.pending.drain(..).collect();
                    if let Some(open) = stack.last_mut() {
                        open.bindings.extend(bound);
                    }
                } else {
                    b.expr(i + 1, close);
                }
                i = close + 1;
            }
            // A whole character: text is anything, `•` included.
            _ => i += source[i..].chars().next().map_or(1, char::len_utf8),
        }
    }
    for open in stack.drain(..).chain(blocks.drain(..)) {
        b.close_scope(&open.bindings, end);
    }
}

/// An element or block whose bindings are visible until it closes.
struct Open {
    name: String,
    start: usize,
    bindings: Vec<usize>,
}

struct TagInfo<'s> {
    name: &'s str,
    name_at: usize,
    attrs: Vec<Attr>,
    self_closing: bool,
    /// Just past the `>`.
    end: usize,
}

impl TagInfo<'_> {
    fn attr_value<'s>(&self, source: &'s str, name: &str) -> Option<&'s str> {
        self.attrs
            .iter()
            .find(|a| a.name.is_some_and(|(s, e)| &source[s..e] == name))
            .and_then(|a| a.value)
            .map(|v| &source[v.0..v.1])
    }
}

#[derive(Clone, Copy)]
struct Attr {
    name: Option<(usize, usize)>,
    /// The value's contents, without its quotes or braces.
    value: Option<(usize, usize)>,
    braced: bool,
}

fn read_tag(source: &str, start: usize, flavor: Flavor) -> TagInfo<'_> {
    let bytes = source.as_bytes();
    let name_at = start + 1;
    let mut i = name_at;
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || b":._-".contains(&bytes[i])) {
        i += 1;
    }
    let name = &source[name_at..i];
    let mut attrs = Vec::new();
    let mut self_closing = false;
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        match bytes[i] {
            b'>' => {
                i += 1;
                break;
            }
            b'/' if bytes.get(i + 1) == Some(&b'>') => {
                self_closing = true;
                i += 2;
                break;
            }
            b'{' if flavor != Flavor::Vue => {
                let close = matching_brace(source, i).unwrap_or(bytes.len() - 1);
                attrs.push(Attr { name: None, value: Some((i + 1, close)), braced: true });
                i = close + 1;
            }
            _ => {
                let name_start = i;
                while i < bytes.len()
                    && !bytes[i].is_ascii_whitespace()
                    && !matches!(bytes[i], b'=' | b'>')
                    && !(bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'>'))
                {
                    i += 1;
                }
                let name = Some((name_start, i));
                let mut j = i;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if bytes.get(j) != Some(&b'=') {
                    attrs.push(Attr { name, value: None, braced: false });
                    if i == name_start {
                        i += 1;
                    }
                    continue;
                }
                j += 1;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                match bytes.get(j) {
                    Some(&q) if q == b'"' || q == b'\'' => {
                        let close = source[j + 1..].find(q as char).map_or(bytes.len(), |e| j + 1 + e);
                        attrs.push(Attr { name, value: Some((j + 1, close)), braced: false });
                        i = close + 1;
                    }
                    Some(b'{') if flavor != Flavor::Vue => {
                        let close = matching_brace(source, j).unwrap_or(bytes.len() - 1);
                        attrs.push(Attr { name, value: Some((j + 1, close)), braced: true });
                        i = close + 1;
                    }
                    _ => {
                        let s = j;
                        while j < bytes.len() && !bytes[j].is_ascii_whitespace() && bytes[j] != b'>' {
                            j += 1;
                        }
                        attrs.push(Attr { name, value: Some((s, j)), braced: false });
                        i = j;
                    }
                }
            }
        }
    }
    TagInfo { name, name_at, attrs, self_closing, end: i.min(bytes.len()) }
}

/// Lays out the program and fills the side tables.
struct Builder<'s> {
    source: &'s str,
    code: Vec<u8>,
    /// Bytes a copied region or a separator already claims.
    taken: Vec<bool>,
    template: Template,
    /// Bindings declared by the element being read, whose scope ends where it closes.
    pending: Vec<usize>,
}

impl<'s> Builder<'s> {
    fn new(source: &'s str) -> Self {
        let code = source
            .bytes()
            .map(|c| if c == b'\n' || c == b'\r' { c } else { b' ' })
            .collect();
        Builder { source, code, taken: vec![false; source.len()], template: Template::default(), pending: Vec::new() }
    }

    fn finish(&self) -> String {
        String::from_utf8(self.code.clone()).unwrap_or_default()
    }

    fn copy(&mut self, a: usize, b: usize) {
        let b = b.min(self.code.len());
        if a >= b {
            return;
        }
        self.code[a..b].copy_from_slice(&self.source.as_bytes()[a..b]);
        self.taken[a..b].iter_mut().for_each(|t| *t = true);
    }

    /// Blank `[a, b)` again, freeing it.
    fn blank(&mut self, a: usize, b: usize) {
        for i in a..b.min(self.code.len()) {
            if !matches!(self.code[i], b'\n' | b'\r') {
                self.code[i] = b' ';
            }
            self.taken[i] = false;
        }
    }

    /// Write `text` at `at`, claimed: a wrapper's own punctuation.
    fn reserve(&mut self, at: usize, text: &[u8]) {
        for (k, &c) in text.iter().enumerate() {
            if let Some(slot) = self.code.get_mut(at + k) {
                *slot = c;
                self.taken[at + k] = true;
            }
        }
    }

    /// Put `c` at the nearest free byte from `from` in `dir`, at most a few bytes away.
    fn put(&mut self, from: usize, back: bool, c: u8) -> Option<usize> {
        let mut i = from;
        for _ in 0..16 {
            if i >= self.code.len() {
                return None;
            }
            if !self.taken[i] {
                self.code[i] = c;
                self.taken[i] = true;
                return Some(i);
            }
            if back {
                i = i.checked_sub(1)?;
            } else {
                i += 1;
            }
        }
        None
    }

    /// Copy the template expression at `[a, b)` as a statement of its own: separated by
    /// `;` on both sides, and parenthesized when it starts like a block (`{ active: x }`).
    fn expr(&mut self, a: usize, b: usize) {
        let b = b.min(self.code.len());
        if a >= b || self.source[a..b].trim().is_empty() {
            return;
        }
        self.copy(a, b);
        self.template.exprs.push((a, b));
        let object = self.source[a..b].trim_start().starts_with('{');
        if a == 0 {
            return;
        }
        if object {
            if let Some(open) = self.put(a - 1, true, b'(') {
                if open > 0 {
                    self.put(open - 1, true, b';');
                }
            }
            if let Some(close) = self.put(b, false, b')') {
                self.put(close + 1, false, b';');
            }
        } else {
            self.put(a - 1, true, b';');
            self.put(b, false, b';');
        }
    }

    fn tag(&mut self, byte: usize, len: usize, name: &str, kind: TagKind, element: Option<&str>) {
        self.template.tags.push(Tag { byte, len, name: name.to_string(), kind, element: element.map(String::from) });
    }

    /// An Angular expression at `[a, b)`, its pipes (`value | date:'short'`) taken out:
    /// the value and each argument copied as expressions, each pipe's name a tag.
    fn angular_expr(&mut self, a: usize, b: usize) {
        let text = &self.source[a..b.min(self.source.len())];
        let cuts = top_level(text, b'|');
        let main_end = cuts.first().map_or(b, |&c| a + c);
        self.expr(a, main_end);
        for (k, &cut) in cuts.iter().enumerate() {
            let seg_start = a + cut + 1;
            let seg_end = cuts.get(k + 1).map_or(b, |&c| a + c);
            let seg = &self.source[seg_start..seg_end];
            let lead = seg.len() - seg.trim_start().len();
            let name_len = seg[lead..]
                .find(|c: char| !(c.is_alphanumeric() || c == '_' || c == '$'))
                .unwrap_or(seg.len() - lead);
            if name_len > 0 {
                let at = seg_start + lead;
                self.tag(at, name_len, &self.source[at..at + name_len].to_string(), TagKind::Pipe, None);
            }
            let args = &seg[lead + name_len..];
            let args_at = seg_start + lead + name_len;
            let colons = top_level(args, b':');
            for (j, &c) in colons.iter().enumerate() {
                let arg_end = colons.get(j + 1).map_or(seg_end, |&n| args_at + n);
                self.expr(args_at + c + 1, arg_end);
            }
        }
    }

    /// An attribute on an Angular element: a binding (`[x]`, `(x)`, `[(x)]`, `bind-x`,
    /// `on-x`), a structural directive's microsyntax (`*ngFor`), a template reference
    /// (`#ref`), `let-x`, or a plain attribute that may select a directive.
    fn angular_attr(&mut self, element: &str, ns: usize, ne: usize, value: Option<(usize, usize)>) {
        let name = &self.source[ns..ne];
        let (core, at, input, output) = if let Some(inner) = name.strip_prefix("[(").and_then(|n| n.strip_suffix(")]")) {
            (inner, ns + 2, true, true)
        } else if let Some(inner) = name.strip_prefix('[').and_then(|n| n.strip_suffix(']')) {
            (inner, ns + 1, true, false)
        } else if let Some(inner) = name.strip_prefix('(').and_then(|n| n.strip_suffix(')')) {
            (inner, ns + 1, false, true)
        } else if let Some(inner) = name.strip_prefix("bindon-") {
            (inner, ns + 7, true, true)
        } else if let Some(inner) = name.strip_prefix("bind-") {
            (inner, ns + 5, true, false)
        } else if let Some(inner) = name.strip_prefix("on-") {
            (inner, ns + 3, false, true)
        } else {
            (name, ns, false, false)
        };
        if input || output {
            // `[class.active]`, `[attr.role]`, `[style.width.px]`, `(keyup.enter)`: the DOM's.
            let prop = core.split('.').next().unwrap_or(core);
            let dom = matches!(prop, "class" | "attr" | "style") || (output && core.contains('.'));
            if !dom {
                let kind = if input { TagKind::Input } else { TagKind::Output };
                self.tag(at, prop.len(), prop, kind, Some(element));
            }
            if let Some((vs, ve)) = value {
                self.angular_expr(vs, ve);
            }
            return;
        }
        if let Some(micro) = name.strip_prefix('*') {
            self.tag(ns + 1, micro.len(), micro, TagKind::Attribute, Some(element));
            if let Some((vs, ve)) = value {
                self.angular_micro(micro, vs, ve);
            }
            return;
        }
        if let Some(var) = name.strip_prefix('#').or_else(|| name.strip_prefix("ref-")) {
            // Visible across the whole template.
            let at = ne - var.len();
            let scope = self.template.angular.last().map_or((0, usize::MAX), |&(a, b, _)| (a, b));
            self.template.bindings.push(TemplateBinding { name: var.to_string(), byte: at, scope, of: None });
            return;
        }
        if let Some(var) = name.strip_prefix("let-") {
            self.bind(var, ns + 4);
            return;
        }
        // `routerLink`, `appHighlight`, `mat-raised-button`: perhaps a directive's selector.
        let custom = core.chars().any(|c| c.is_ascii_uppercase())
            || (core.contains('-') && !core.starts_with("data-") && !core.starts_with("aria-"));
        if custom {
            self.tag(ns, core.len(), core, TagKind::Attribute, Some(element));
        }
        if let Some((vs, ve)) = value {
            // `title="Hello {{ name }}"`.
            let mut j = vs;
            while let Some(o) = self.source.get(j..ve).and_then(|v| v.find("{{")).map(|o| j + o) {
                let close = self.source[o + 2..ve].find("}}").map_or(ve, |e| o + 2 + e);
                self.angular_expr(o + 2, close);
                j = close + 2;
            }
        }
    }

    /// A structural directive's microsyntax: `let item of items; index as i; trackBy: f`,
    /// `user$ | async as user; else loading`.
    fn angular_micro(&mut self, directive: &str, a: usize, b: usize) {
        let text = &self.source[a..b];
        let mut cuts = vec![0];
        cuts.extend(top_level(text, b';').into_iter().map(|c| c + 1));
        for (k, &start) in cuts.iter().enumerate() {
            let end = cuts.get(k + 1).map_or(text.len(), |&n| n - 1);
            let part = &text[start..end];
            let lead = part.len() - part.trim_start().len();
            let p = part.trim();
            let at = a + start + lead;
            if let Some(rest) = p.strip_prefix("let ") {
                // `let item of items`, `let i = index`.
                let name_len = rest.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(rest.len());
                let since = self.template.bindings.len();
                self.bind(&rest[..name_len], at + 4);
                if let Some(of) = rest.find(" of ") {
                    let expr_at = at + 4 + of + 4;
                    self.typed_by(since, expr_at, a + end, true);
                    self.angular_expr(expr_at, a + end);
                }
                continue;
            }
            if let Some(as_at) = p.find(" as ") {
                let alias = p[as_at + 4..].trim();
                let since = self.template.bindings.len();
                self.bind(alias, at + p.len() - alias.len());
                // `user$ | async as user` tests a value; `index as i` names a context key.
                if k == 0 {
                    let value_end = top_level(&p[..as_at], b'|').first().map_or(as_at, |&c| c);
                    self.typed_by(since, at, at + value_end, false);
                    self.angular_expr(at, at + as_at);
                }
                continue;
            }
            let key_len = p.find(|c: char| c == ':' || c.is_whitespace()).unwrap_or(0);
            let keyed = k > 0 && key_len > 0 && p[..key_len].chars().all(char::is_alphanumeric);
            if keyed {
                let rest = p[key_len..].trim_start_matches(':').trim_start();
                let expr_at = at + p.len() - rest.len();
                self.angular_expr(expr_at, at + p.len());
            } else if !p.is_empty() {
                let _ = directive;
                self.angular_expr(at, at + p.len());
            }
        }
    }

    /// A control-flow block at `at` (`@if (..) {`, `@for (..) {`, `@let x = ..;`, ...):
    /// where reading resumes.
    fn angular_block(&mut self, at: usize, end: usize, blocks: &mut Vec<Open>, element: Option<usize>) -> usize {
        let source = self.source;
        let rest = &source[at + 1..end];
        let kw_len = rest.find(|c: char| !c.is_ascii_alphabetic()).unwrap_or(rest.len());
        let kw = &rest[..kw_len];
        let mut i = at + 1 + kw_len;
        let skip_ws = |mut j: usize| {
            while j < end && source.as_bytes()[j].is_ascii_whitespace() {
                j += 1;
            }
            j
        };
        match kw {
            "if" | "else" | "for" | "switch" | "case" | "default" | "defer" | "placeholder"
            | "loading" | "error" | "empty" => {}
            "let" => {
                // `@let total = a + b;`
                let semi = source[i..end].find(';').map_or(end, |e| i + e);
                let body = &source[i..semi];
                if let Some(eq) = body.find('=') {
                    let name = body[..eq].trim();
                    let name_at = i + body[..eq].find(name).unwrap_or(0);
                    let scope = (name_at, blocks.last().map_or(usize::MAX, |_| usize::MAX));
                    self.template.bindings.push(TemplateBinding { name: name.to_string(), byte: name_at, scope, of: None });
                    let index = self.template.bindings.len() - 1;
                    match blocks.last_mut() {
                        Some(block) => block.bindings.push(index),
                        None => self.pending.push(index),
                    }
                    self.angular_expr(i + eq + 1, semi);
                }
                let _ = element;
                return semi + 1;
            }
            // An `@` in text: an email, a handle.
            _ => return at + 1,
        }
        i = skip_ws(i);
        // `@else if (..)`.
        if kw == "else" && source[i..end].starts_with("if") {
            i = skip_ws(i + 2);
        }
        if source.as_bytes().get(i) == Some(&b'(') {
            let close = matching_paren(source, i).unwrap_or(end).min(end);
            let params = &source[i + 1..close];
            match kw {
                "for" => {
                    // `item of items; track item.id; let i = $index, odd = $odd`
                    let parts = top_level(params, b';');
                    let first_end = parts.first().map_or(params.len(), |&c| c);
                    let first = &params[..first_end];
                    if let Some(of) = first.find(" of ") {
                        let lead = first.len() - first.trim_start().len();
                        let name = first[..of].trim();
                        let since = self.template.bindings.len();
                        self.bind(name, i + 1 + lead);
                        self.typed_by(since, i + 1 + of + 4, i + 1 + first_end, true);
                        self.angular_expr(i + 1 + of + 4, i + 1 + first_end);
                    }
                    for (k, &c) in parts.iter().enumerate() {
                        let seg_start = c + 1;
                        let seg_end = parts.get(k + 1).copied().unwrap_or(params.len());
                        let seg = &params[seg_start..seg_end];
                        let t = seg.trim_start();
                        let t_at = i + 1 + seg_start + (seg.len() - t.len());
                        if let Some(track) = t.strip_prefix("track ") {
                            self.angular_expr(t_at + 6, t_at + 6 + track.trim_end().len());
                        } else if let Some(lets) = t.strip_prefix("let ") {
                            let mut off = 0;
                            for decl in lets.split(',') {
                                let name = decl.split('=').next().unwrap_or("").trim();
                                let name_at = t_at + 4 + off + decl.find(name).unwrap_or(0);
                                if !name.is_empty() {
                                    self.bind(name, name_at);
                                }
                                off += decl.len() + 1;
                            }
                        }
                    }
                }
                "if" | "else" => {
                    // `cond; as alias`
                    let parts = top_level(params, b';');
                    let first_end = parts.first().map_or(params.len(), |&c| c);
                    self.angular_expr(i + 1, i + 1 + first_end);
                    if let Some(&c) = parts.first() {
                        let rest = &params[c + 1..];
                        if let Some(alias) = rest.trim().strip_prefix("as ") {
                            let alias = alias.trim();
                            let alias_at = i + 1 + c + 1 + rest.find(alias).unwrap_or(0);
                            let since = self.template.bindings.len();
                            self.bind(alias, alias_at);
                            let value_end = top_level(&params[..first_end], b'|').first().map_or(first_end, |&p| p);
                            self.typed_by(since, i + 1, i + 1 + value_end, false);
                        }
                    }
                }
                "switch" | "case" => self.angular_expr(i + 1, close),
                _ => {}
            }
            i = skip_ws(close + 1);
        }
        if source.as_bytes().get(i) == Some(&b'{') {
            blocks.push(Open { name: kw.to_string(), start: at, bindings: self.pending.drain(..).collect() });
            return i + 1;
        }
        i
    }

    fn bind(&mut self, name: &str, byte: usize) {
        self.template.bindings.push(TemplateBinding { name: name.to_string(), byte, scope: (byte, usize::MAX), of: None });
        self.pending.push(self.template.bindings.len() - 1);
    }

    /// The binding made since `since` (the first, for a pattern) takes its value from
    /// what's written at `[a, b)`.
    fn typed_by(&mut self, since: usize, a: usize, b: usize, element: bool) {
        if let Some(binding) = self.template.bindings.get_mut(since) {
            binding.of = Some((a, b, element));
        }
    }

    fn close_scope(&mut self, bindings: &[usize], end: usize) {
        for &i in bindings {
            if self.template.bindings[i].scope.1 == usize::MAX {
                self.template.bindings[i].scope.1 = end;
            }
        }
    }

    /// The names a binding pattern written at `[a, b)` binds: `item`, `(item, i)`,
    /// `{ id, name: label, ...rest }`.
    fn bind_pattern(&mut self, a: usize, b: usize) {
        let text = &self.source[a..b];
        let bytes = text.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let c = bytes[i];
            if c.is_ascii_alphabetic() || c == b'_' || c == b'$' {
                let s = i;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'$') {
                    i += 1;
                }
                let mut j = i;
                while j < bytes.len() && bytes[j] == b' ' {
                    j += 1;
                }
                // A key renamed (`name: label`) or a default (`= value`): not the binding /
                // the end of it.
                if bytes.get(j) == Some(&b':') {
                    continue;
                }
                self.bind(&text[s..i], a + s);
                if bytes.get(j) == Some(&b'=') {
                    // Skip the default value up to the next separator.
                    let mut depth = 0;
                    i = j + 1;
                    while i < bytes.len() {
                        match bytes[i] {
                            b'(' | b'[' | b'{' => depth += 1,
                            b')' | b']' | b'}' if depth > 0 => depth -= 1,
                            b',' | b')' | b'}' if depth == 0 => break,
                            _ => {}
                        }
                        i += 1;
                    }
                }
            } else {
                i += 1;
            }
        }
    }

    /// An element in a template: its component tag, and its attributes' expressions and
    /// bindings.
    fn element(&mut self, source: &str, tag: &TagInfo, flavor: Flavor) {
        if flavor == Flavor::Angular {
            let element = tag.name.to_ascii_lowercase();
            if element.contains('-') && !element.starts_with("ng-") {
                self.tag(tag.name_at, tag.name.len(), &element, TagKind::Element, None);
            }
            for attr in &tag.attrs {
                if let Some((ns, ne)) = attr.name {
                    self.angular_attr(&element, ns, ne, attr.value);
                }
            }
            return;
        }
        if let Some((name, len)) = component_name(tag.name, flavor) {
            self.tag(tag.name_at, len, &name, TagKind::Component, None);
        }
        for attr in &tag.attrs {
            let name = attr.name.map(|(s, e)| &source[s..e]).unwrap_or("");
            let Some((vs, ve)) = attr.value else {
                // Svelte's shorthand directives name a variable: `class:active`,
                // `bind:value`; `use:`, `transition:` and friends a function.
                if flavor == Flavor::Svelte {
                    if let Some((kind, rest)) = name.split_once(':') {
                        let ident = rest.split('|').next().unwrap_or(rest);
                        let at = attr.name.unwrap().0 + kind.len() + 1;
                        match kind {
                            "class" | "bind" | "style" | "use" | "transition" | "in" | "out" | "animate" => {
                                self.expr(at, at + ident.len());
                            }
                            "let" => {
                                self.bind(ident, at);
                                self.expr(at, at + ident.len());
                            }
                            _ => {}
                        }
                    }
                }
                continue;
            };
            match flavor {
                Flavor::Angular => {}
                Flavor::Vue => self.vue_attr(name, vs, ve),
                Flavor::Svelte | Flavor::Astro if attr.braced => {
                    // `{...props}`: the expression after the dots.
                    let spread = source[vs..ve].trim_start().starts_with("...");
                    let start = if spread { vs + source[vs..].find("...").unwrap_or(0) + 3 } else { vs };
                    if flavor == Flavor::Svelte {
                        if let Some(rest) = name.strip_prefix("let:") {
                            self.bind(rest, attr.name.unwrap().0 + 4);
                        }
                        let directive = name.split_once(':').map(|(k, _)| k);
                        if matches!(directive, Some("use" | "transition" | "in" | "out" | "animate")) {
                            let ident = name.split_once(':').unwrap().1.split('|').next().unwrap_or("");
                            let at = attr.name.unwrap().0 + directive.unwrap().len() + 1;
                            self.expr(at, at + ident.len());
                        }
                    }
                    if name.starts_with("let:") {
                        self.bind_pattern(start, ve);
                    }
                    self.expr(start, ve);
                }
                // `class="card {active ? 'on' : ''}"`: mustaches inside a quoted value.
                Flavor::Svelte | Flavor::Astro => {
                    let mut j = vs;
                    while let Some(open) = source.get(j..ve).and_then(|v| v.find('{')).map(|o| j + o) {
                        let close = matching_brace(source, open).unwrap_or(ve).min(ve);
                        self.expr(open + 1, close);
                        j = close + 1;
                    }
                }
            }
        }
    }

    fn vue_attr(&mut self, name: &str, vs: usize, ve: usize) {
        let directive = name.starts_with(':')
            || name.starts_with('@')
            || name.starts_with('#')
            || name.starts_with("v-");
        if !directive && name != "slot-scope" && name != "scope" {
            return;
        }
        if name == "v-for" {
            let value = &self.source[vs..ve];
            let split = [" in ", " of "]
                .iter()
                .filter_map(|sep| value.find(sep).map(|at| (at, *sep)))
                .min_by_key(|(at, _)| *at);
            if let Some((at, sep)) = split {
                let since = self.template.bindings.len();
                self.bind_pattern(vs, vs + at);
                self.typed_by(since, vs + at + sep.len(), ve, true);
                self.expr(vs, ve);
                if sep == " of " {
                    // `item of items` isn't an expression; `item in items` is.
                    let of = vs + at + 1;
                    self.code[of] = b'i';
                    self.code[of + 1] = b'n';
                }
            }
            return;
        }
        if name.starts_with('#') || name.starts_with("v-slot") || name == "slot-scope" || name == "scope" {
            self.bind_pattern(vs, ve);
            self.expr(vs, ve);
            return;
        }
        self.expr(vs, ve);
    }

    /// `{expr}`, or a block tag: `{#if x}`, `{#each xs as x, i (key)}`, `{:else if x}`,
    /// `{:then v}`, `{@const x = ..}`, `{/each}`.
    fn svelte_mustache(&mut self, source: &str, open: usize, close: usize, blocks: &mut Vec<Open>, stack: &[Open]) {
        let inner = &source[open + 1..close.min(source.len())];
        let at = open + 1;
        let lead = inner.len() - inner.trim_start().len();
        let body = inner.trim_start();
        let word_end = |s: &str| s.find(|c: char| c.is_whitespace() || c == '}').unwrap_or(s.len());
        match body.chars().next() {
            Some('#') => {
                let kw = &body[1..word_end(body)];
                let rest_at = at + lead + 1 + kw.len();
                let rest = &source[rest_at..close];
                match kw {
                    "each" => {
                        let as_at = rest.find(" as ");
                        match as_at {
                            Some(a) => {
                                self.expr(rest_at, rest_at + a);
                                let pat_start = rest_at + a + 4;
                                let key = source[pat_start..close].find('(').map(|k| pat_start + k);
                                let since = self.template.bindings.len();
                                self.bind_pattern(pat_start, key.unwrap_or(close));
                                self.typed_by(since, rest_at, rest_at + a, true);
                                self.expr(pat_start, key.unwrap_or(close));
                                if let Some(k) = key {
                                    if let Some(kc) = source[k..close].rfind(')') {
                                        self.expr(k + 1, k + kc);
                                    }
                                }
                            }
                            None => self.expr(rest_at, close),
                        }
                    }
                    "await" => match rest.find(" then ").or_else(|| rest.find(" catch ")) {
                        Some(t) => {
                            self.expr(rest_at, rest_at + t);
                            let kw_len = if rest[t..].starts_with(" then ") { 6 } else { 7 };
                            self.bind_pattern(rest_at + t + kw_len, close);
                            self.expr(rest_at + t + kw_len, close);
                        }
                        None => self.expr(rest_at, close),
                    },
                    "snippet" => {
                        // `{#snippet row(item)}`: `row` is the template's, `item` the block's.
                        let name_len = rest.trim_start().find('(').unwrap_or(rest.trim_start().len());
                        let name_at = rest_at + (rest.len() - rest.trim_start().len());
                        let snippet_name = source[name_at..name_at + name_len].trim().to_string();
                        self.template.bindings.push(TemplateBinding {
                            name: snippet_name,
                            byte: name_at,
                            scope: (stack.last().map_or(0, |o| o.start), usize::MAX),
                            of: None,
                        });
                        if let Some(p) = rest.find('(') {
                            let params_end = rest.rfind(')').unwrap_or(rest.len());
                            self.bind_pattern(rest_at + p + 1, rest_at + params_end);
                        }
                        self.expr(name_at, close);
                    }
                    _ => self.expr(rest_at, close),
                }
                blocks.push(Open { name: kw.to_string(), start: open, bindings: self.pending.drain(..).collect() });
            }
            Some(':') => {
                // `{:then value}`, `{:catch error}` bind; `{:else if x}` tests.
                let kw = &body[1..word_end(body)];
                let rest_at = at + lead + 1 + kw.len();
                match kw {
                    "then" | "catch" => {
                        self.bind_pattern(rest_at, close);
                        self.expr(rest_at, close);
                        let bound: Vec<usize> = self.pending.drain(..).collect();
                        if let Some(block) = blocks.last_mut() {
                            block.bindings.extend(bound);
                        }
                    }
                    _ => {
                        let rest = &source[rest_at..close];
                        if let Some(cond) = rest.trim_start().strip_prefix("if ") {
                            let cond_at = close - cond.len();
                            self.expr(cond_at, close);
                        }
                    }
                }
            }
            Some('/') => {
                let kw = &body[1..word_end(body)];
                if let Some(pos) = blocks.iter().rposition(|b| b.name == kw) {
                    for block in blocks.drain(pos..).rev() {
                        self.close_scope(&block.bindings, close + 1);
                    }
                }
            }
            Some('@') => {
                let kw = &body[1..word_end(body)];
                let rest_at = at + lead + 1 + kw.len();
                if kw == "const" {
                    let rest = &source[rest_at..close];
                    if let Some(eq) = rest.find('=') {
                        self.bind_pattern(rest_at, rest_at + eq);
                        // Visible to the end of the block or element around it.
                        let bound: Vec<usize> = self.pending.drain(..).collect();
                        match blocks.last_mut() {
                            Some(block) => block.bindings.extend(bound),
                            None => self.pending.extend(bound),
                        }
                    }
                }
                self.expr(rest_at, close);
            }
            _ => self.expr(at, close),
        }
    }
}

/// A tag naming a component, and its name in script: `MyButton`, `my-button` (Vue) →
/// `MyButton`, `Foo.Bar` → `Foo`. HTML elements and framework specials (`svelte:head`)
/// aren't.
fn component_name(tag: &str, flavor: Flavor) -> Option<(String, usize)> {
    if tag.contains(':') {
        return None;
    }
    let first = tag.split('.').next().unwrap_or(tag);
    if first.starts_with(|c: char| c.is_ascii_uppercase()) {
        return Some((first.to_string(), first.len()));
    }
    if flavor == Flavor::Vue && first.contains('-') && !HYPHENATED_ELEMENTS.contains(&first) {
        let pascal: String = first
            .split('-')
            .filter(|s| !s.is_empty())
            .map(|s| {
                let mut c = s.chars();
                c.next().map(|f| f.to_ascii_uppercase().to_string() + c.as_str()).unwrap_or_default()
            })
            .collect();
        return Some((pascal, first.len()));
    }
    None
}

/// Where `sep` occurs in `text` outside strings and brackets — `|` alone, not `||`.
fn top_level(text: &str, sep: u8) -> Vec<usize> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            q @ (b'\'' | b'"' | b'`') => {
                i += 1;
                while i < bytes.len() && bytes[i] != q {
                    if bytes[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            c if c == sep && depth == 0 => {
                let doubled = sep == b'|'
                    && (bytes.get(i + 1) == Some(&b'|') || (i > 0 && bytes[i - 1] == b'|'));
                // `a ? b : c` isn't a pipe argument's colon.
                let ternary = sep == b':' && text[..i].contains('?');
                if !doubled && !ternary {
                    out.push(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    out
}

/// The `)` closing the `(` at `open`, skipping strings.
fn matching_paren(source: &str, open: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut depth = 0usize;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            q @ (b'\'' | b'"' | b'`') => {
                i += 1;
                while i < bytes.len() && bytes[i] != q {
                    if bytes[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// HTML and SVG elements whose names have a hyphen.
const HYPHENATED_ELEMENTS: &[&str] = &[
    "annotation-xml", "color-profile", "font-face", "font-face-src", "font-face-uri",
    "font-face-format", "font-face-name", "missing-glyph",
];

fn is_void(tag: &str) -> bool {
    matches!(
        tag,
        "area" | "base" | "br" | "col" | "embed" | "hr" | "img" | "input" | "link" | "meta"
            | "source" | "track" | "wbr" | "!doctype"
    )
}

fn find_ci(source: &str, from: usize, needle: &str) -> Option<usize> {
    let hay = source.get(from..)?;
    let lower = hay.to_ascii_lowercase();
    lower.find(needle).map(|i| from + i)
}

/// The `}` closing the `{` at `open`, skipping strings and template literals.
pub fn matching_brace(source: &str, open: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut depth = 0usize;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            q @ (b'\'' | b'"' | b'`') => {
                i += 1;
                while i < bytes.len() && bytes[i] != q {
                    if bytes[i] == b'\\' {
                        i += 1;
                    } else if q == b'`' && bytes[i] == b'$' && bytes.get(i + 1) == Some(&b'{') {
                        i = matching_brace(source, i + 1)?;
                    }
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(rel: &str, src: &str) -> VirtualDoc {
        let d = virtual_doc(rel, src).unwrap();
        assert_eq!(d.code.len(), src.len(), "byte for byte");
        d
    }

    #[test]
    fn vue_scripts_and_template_expressions_line_up() {
        let src = "<template>\n  <div :class=\"{ on: active }\" @click=\"toggle()\">{{ label }}</div>\n  <my-button v-for=\"(item, i) of items\" :key=\"item.id\" />\n</template>\n<script setup lang=\"ts\">\nimport MyButton from './MyButton.vue'\nconst label = 'x'\n</script>\n<style>.a { color: red }</style>\n";
        let d = doc("A.vue", src);
        assert_eq!(d.grammar, Grammar::Ts);
        assert!(d.code.contains("import MyButton from './MyButton.vue'"));
        assert!(!d.code.contains("color"), "styles are blank");
        assert!(!d.code.contains("div"), "markup is blank");
        for expr in ["{ on: active }", "toggle()", "label", "item.id", "items"] {
            let at = src.find(expr).unwrap();
            assert_eq!(&d.code[at..at + expr.len()], expr, "{expr} in place");
        }
        assert!(d.code.contains("(item, i) in items"), "`of` reads as `in`");
        let tag = &d.template.tags[0];
        assert_eq!((tag.name.as_str(), &src[tag.byte..tag.byte + tag.len]), ("MyButton", "my-button"));
        let item = d.template.binding("item", src.find("item.id").unwrap()).expect("v-for binds");
        assert_eq!(item.byte, src.find("item,").unwrap());
        assert!(d.template.binding("item", src.find("<script").unwrap()).is_none(), "not past its element");
    }

    #[test]
    fn svelte_blocks_bind_and_directives_name() {
        let src = "<script lang=\"ts\">\n  import Row from './Row.svelte';\n  let items = [];\n  let active = false;\n</script>\n{#each items as item, i (item.id)}\n  <Row {item} on:click={() => select(i)} class:active />\n  {@const label = item.name}\n  <p>{label}</p>\n{/each}\n{#if $count > 1}<b>{$count}</b>{:else if other}x{/if}\n";
        let d = doc("A.svelte", src);
        assert_eq!(d.grammar, Grammar::Ts);
        for expr in ["items", "item.id", "() => select(i)", "label", "$count > 1", "other"] {
            let at = src.find(expr).unwrap();
            assert_eq!(&d.code[at..at + expr.len()], expr, "{expr} in place");
        }
        let active = src.find("class:active").unwrap() + 6;
        assert_eq!(&d.code[active..active + 6], "active", "a shorthand directive names a variable");
        assert_eq!(d.template.tags[0].name, "Row");
        let in_block = src.find("{label}").unwrap();
        assert!(d.template.binding("item", in_block).is_some());
        assert!(d.template.binding("label", in_block).is_some(), "{{@const}} binds to the block's end");
        assert!(d.template.binding("item", src.find("{#if").unwrap()).is_none());
    }

    #[test]
    fn angular_templates() {
        let src = "<app-hero-detail [hero]=\"selected\" (deleted)=\"onDelete($event)\" appHighlight></app-hero-detail>\n<li *ngFor=\"let h of heroes; let i = index; trackBy: byId\">{{ h.name | uppercase }} {{ i }}</li>\n@for (item of items; track item.id; let idx = $index) {\n  <span #box>{{ item.price | currency:code:'symbol' }}</span>\n} @empty { none }\n@if (user$ | async; as user) { {{ user.name }} }\n@let total = sum(items);\n<input [(ngModel)]=\"query\" [class.on]=\"active\">\n";
        let d = doc("hero.component.html", src);
        assert_eq!(d.grammar, Grammar::Ts);
        for expr in ["selected", "onDelete($event)", "heroes", "byId", "h.name", "item.price", "code", "'symbol'", "user$", "user.name", "sum(items)", "query", "active", "item.id"] {
            let at = src.find(expr).unwrap();
            assert_eq!(&d.code[at..at + expr.len()], expr, "{expr} in place");
        }
        assert!(!d.code.contains("uppercase") && !d.code.contains("currency"), "pipes are tags");
        let tags: Vec<(TagKind, &str)> = d.template.tags.iter().map(|t| (t.kind, t.name.as_str())).collect();
        for want in [(TagKind::Element, "app-hero-detail"), (TagKind::Input, "hero"), (TagKind::Output, "deleted"), (TagKind::Attribute, "appHighlight"), (TagKind::Pipe, "uppercase"), (TagKind::Pipe, "currency"), (TagKind::Input, "ngModel")] {
            assert!(tags.contains(&want), "{want:?} in {tags:?}");
        }
        let in_li = src.find("h.name").unwrap();
        assert!(d.template.binding("h", in_li).is_some() && d.template.binding("i", in_li).is_some());
        let in_for = src.find("item.price").unwrap();
        assert!(d.template.binding("item", in_for).is_some() && d.template.binding("box", in_for).is_some());
        assert!(d.template.binding("item", src.find("@if").unwrap()).is_none(), "the block's own");
        assert!(d.template.binding("user", src.find("user.name").unwrap()).is_some());
        assert!(d.template.binding("total", src.find("<input").unwrap()).is_some());
    }

    #[test]
    fn inline_angular_templates() {
        let src = "@Component({\n  selector: 'app-root',\n  template: `\n    <h1>{{ title }}</h1>\n    <button (click)=\"go()\">go</button>\n  `,\n})\nexport class AppComponent {\n  title = 'x';\n  go() {}\n}\n";
        let d = inline_angular(src).unwrap();
        assert_eq!(d.code.len(), src.len());
        assert!(d.code.contains("template: (()=>{"));
        for expr in ["title", "go()"] {
            let at = src.find(&format!("{expr}")).unwrap();
            assert_eq!(&d.code[at..at + expr.len()], expr);
        }
        let (_, _, class) = d.template.angular[0];
        assert_eq!(&src[class.unwrap()..class.unwrap() + 12], "AppComponent");
    }

    #[test]
    fn text_in_any_script() {
        let src = "<template><p>• {{ a }} — ünïcödé</p></template>\n<script>\nconst a = '…'\n</script>\n";
        let d = doc("A.vue", src);
        let at = src.find("a }}").unwrap();
        assert_eq!(&d.code[at..at + 1], "a");
    }

    #[test]
    fn astro_frontmatter_and_jsx_expressions() {
        let src = "---\nimport Card from '../components/Card.astro';\nconst { title } = Astro.props;\n---\n<Layout title={title}>\n  {items.map((i) => <Card {...i} />)}\n</Layout>\n<script>\n  document.title = 'x';\n</script>\n";
        let d = doc("index.astro", src);
        assert_eq!(d.grammar, Grammar::Tsx);
        assert!(d.code.contains("import Card from '../components/Card.astro';"));
        assert!(d.code.contains("items.map((i) => <Card {...i} />)"));
        assert!(d.code.contains("document.title = 'x';"));
        assert_eq!(d.template.tags[0].name, "Layout");
    }
}
