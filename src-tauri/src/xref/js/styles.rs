//! Resolving stylesheet symbols (`css.rs` tokenizes): a custom property to every
//! declaration of it in the project; a Sass or LESS variable, mixin, function or
//! placeholder through its blocks, then the modules its sheet loads; a CSS module's class
//! to its selector, from the sheet or from a script's `styles.card`.

use super::css::{self, LoadKind, Space, Token};
use super::project::is_package_name;
use super::resolve::{finish, Member, Resolution, Target};
use super::JsIndex;

const MAX_DEPTH: usize = 12;

impl JsIndex {
    /// A stylesheet's text: its own, or its component's.
    pub(super) fn sheet_text(&self, rel: &str) -> Option<&str> {
        let sheet = self.sheets.get(rel)?;
        match &sheet.source {
            Some(text) => Some(text),
            None => self.file_index.get(rel).map(|&fi| self.files[fi].source.as_str()),
        }
    }

    fn sheet_tokens(&self, rel: &str) -> Option<&css::Tokens> {
        let text = self.sheet_text(rel)?;
        Some(self.sheets.get(rel)?.tokens(text))
    }

    /// The token at `byte` of the stylesheet `rel` (or a component's `<style>`).
    pub(super) fn style_token(&self, rel: &str, byte: usize) -> Option<(usize, &Token)> {
        let sheet = self.sheets.get(rel)?;
        sheet.region_at(byte)?;
        self.sheet_tokens(rel)?
            .tokens
            .iter()
            .enumerate()
            .find(|(_, t)| t.start <= byte && byte < t.start + t.len)
    }

    /// The stylesheet a `@use`/`@forward`/`@import` path at `byte` of `rel` loads:
    /// `Some(None)` on a path that loads nothing here (`sass:math`, a package's),
    /// `None` off any path.
    pub(super) fn style_load_at(&self, rel: &str, byte: usize) -> Option<Option<Target>> {
        self.sheets.get(rel)?.region_at(byte)?;
        let load = self
            .sheet_tokens(rel)?
            .loads
            .iter()
            .find(|l| l.start <= byte && byte < l.start + l.spec.len())?;
        Some(self.sass_file(rel, &load.spec).map(Target::File))
    }

    /// What the stylesheet token `tok` of `rel` refers to.
    pub(super) fn resolve_style(&self, rel: &str, tok: &Token, depth: usize) -> Resolution {
        if tok.def && tok.space != Space::Custom {
            return Resolution::Found(Target::Style { file: rel.to_string(), byte: tok.start });
        }
        match tok.space {
            // Every declaration of it, anywhere: a theme's overrides are all its definition.
            Space::Custom => {
                let mut defs = Vec::new();
                let mut names: Vec<&String> = self.sheets.keys().collect();
                names.sort();
                for sheet in names {
                    for t in self.sheet_tokens(sheet).map(|t| t.tokens.as_slice()).unwrap_or_default() {
                        if t.space == Space::Custom && t.def && t.name == tok.name {
                            defs.push(Target::Style { file: sheet.clone(), byte: t.start });
                        }
                    }
                }
                finish(defs)
            }
            Space::Class => Resolution::Unresolved,
            space => self.sass_lookup(rel, tok, space, depth + 1),
        }
    }

    /// A Sass or LESS name: through its namespace's module, else its blocks outward,
    /// else the modules its sheet loads unprefixed.
    fn sass_lookup(&self, rel: &str, tok: &Token, space: Space, depth: usize) -> Resolution {
        let Some(toks) = self.sheet_tokens(rel) else {
            return Resolution::Unresolved;
        };
        if let Some(ns) = &tok.ns {
            let Some(load) = toks.loads.iter().find(|l| l.kind == LoadKind::Use && l.ns.as_deref() == Some(ns)) else {
                return Resolution::Unresolved;
            };
            return match self.sass_file(rel, &load.spec) {
                Some(module) => self.sass_member(&module, space, &tok.name, depth + 1, &mut Vec::new()),
                None if load.spec.starts_with("sass:") => Resolution::External,
                None => self.unloaded(&load.spec),
            };
        }
        let mut block = tok.block;
        loop {
            let pick = toks
                .tokens
                .iter()
                .filter(|t| t.def && t.space == space && t.name == tok.name && t.block == block)
                .filter(|t| block == 0 || t.start <= tok.start)
                .last();
            if let Some(d) = pick {
                return Resolution::Found(Target::Style { file: rel.to_string(), byte: d.start });
            }
            if block == 0 {
                break;
            }
            block = toks.parents[block];
        }
        let mut external = false;
        for load in &toks.loads {
            let global = load.kind == LoadKind::Import || (load.kind == LoadKind::Use && load.ns.is_none());
            if !global {
                continue;
            }
            match self.sass_file(rel, &load.spec) {
                Some(module) => match self.sass_member(&module, space, &tok.name, depth + 1, &mut Vec::new()) {
                    found @ (Resolution::Found(_) | Resolution::Ambiguous(_)) => return found,
                    _ => {}
                },
                None => external |= self.unloaded(&load.spec).is_external(),
            }
        }
        // `rgba(..)`, `calc(..)`: CSS's own, unless the project declares one.
        if space == Space::Function {
            return Resolution::External;
        }
        if external {
            return Resolution::Unresolved;
        }
        Resolution::Unresolved
    }

    /// A module's own top-level member, or one it forwards (or, `@import`ing, re-exposes).
    fn sass_member(&self, rel: &str, space: Space, name: &str, depth: usize, seen: &mut Vec<String>) -> Resolution {
        if depth > MAX_DEPTH || seen.iter().any(|s| s == rel) {
            return Resolution::Unresolved;
        }
        seen.push(rel.to_string());
        let Some(toks) = self.sheet_tokens(rel) else {
            return Resolution::Unresolved;
        };
        if let Some(d) = toks.tokens.iter().find(|t| t.def && t.space == space && t.name == name && t.block == 0) {
            return Resolution::Found(Target::Style { file: rel.to_string(), byte: d.start });
        }
        for load in toks.loads.iter().filter(|l| matches!(l.kind, LoadKind::Forward | LoadKind::Import)) {
            if let Some(module) = self.sass_file(rel, &load.spec) {
                if let found @ Resolution::Found(_) = self.sass_member(&module, space, name, depth + 1, seen) {
                    return found;
                }
            }
        }
        Resolution::Unresolved
    }

    /// The stylesheet `spec` loads from `from`, as Sass finds it — or through the
    /// project's aliases (`@use '@/styles/vars'`).
    fn sass_file(&self, from: &str, spec: &str) -> Option<String> {
        let aliased = self.project.expand(from, spec);
        css::sass_module(from, spec, &aliased, &|p| self.sheets.contains_key(p))
    }

    /// A module nothing here provides: a package's (`bootstrap/scss/…`, `~bootstrap`) or
    /// one we can't place.
    fn unloaded(&self, spec: &str) -> Resolution {
        let bare = spec.trim_start_matches('~');
        let (name, _) = super::project::split_package(bare);
        if spec.starts_with('~') || (is_package_name(name) && !spec.starts_with('.')) {
            Resolution::External
        } else {
            Resolution::Unresolved
        }
    }

    /// A CSS module's class `name` — as written, or camelCased (`styles.cardTitle` for
    /// `.card-title`).
    pub(super) fn css_module_class(&self, rel: &str, name: &str) -> Member {
        let Some(toks) = self.sheet_tokens(rel) else {
            return Member::Missing { complete: false };
        };
        let hit = toks
            .tokens
            .iter()
            .find(|t| t.space == Space::Class && (t.name == name || css::camel(&t.name) == name));
        match hit {
            Some(t) => Member::Hits(vec![Target::Style { file: rel.to_string(), byte: t.start }]),
            None => Member::Missing { complete: false },
        }
    }

    /// Every use of the style target `want` across the project's stylesheets, and — for a
    /// CSS module's class — the scripts' `styles.name` (the caller's walk finds those).
    pub(super) fn style_references(&self, want: &Target, name: &str) -> Vec<(String, usize, Resolution)> {
        let Target::Style { file, byte } = want else {
            return Vec::new();
        };
        let Some(space) = self.sheet_tokens(file).and_then(|t| t.tokens.iter().find(|t| t.start == *byte)).map(|t| t.space) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let mut sheets: Vec<&String> = self.sheets.keys().collect();
        sheets.sort();
        for rel in sheets {
            let Some(text) = self.sheet_text(rel) else {
                continue;
            };
            if !text.contains(name) {
                continue;
            }
            for t in self.sheet_tokens(rel).map(|t| t.tokens.as_slice()).unwrap_or_default() {
                if t.space == space && t.name == name {
                    out.push((rel.clone(), t.start, self.resolve_style(rel, t, 0)));
                }
            }
        }
        out
    }
}

impl JsIndex {
    /// A stylesheet target's namespace and name.
    pub(super) fn style_name(&self, target: &Target) -> Option<(Space, String)> {
        let Target::Style { file, byte } = target else {
            return None;
        };
        let tok = self.sheet_tokens(file)?.tokens.iter().find(|t| t.start == *byte)?;
        Some((tok.space, tok.name.clone()))
    }

    /// Every definition of `name` in `space`, in every stylesheet.
    pub(super) fn style_definitions(&self, space: Space, name: &str) -> Vec<Target> {
        let mut sheets: Vec<&String> = self.sheets.keys().collect();
        sheets.sort();
        let mut out = Vec::new();
        for rel in sheets {
            for t in self.sheet_tokens(rel).map(|t| t.tokens.as_slice()).unwrap_or_default() {
                if t.def && t.space == space && t.name == name && t.block == 0 {
                    out.push(Target::Style { file: rel.clone(), byte: t.start });
                }
            }
        }
        out
    }
}

impl Resolution {
    fn is_external(&self) -> bool {
        matches!(self, Resolution::External)
    }
}
