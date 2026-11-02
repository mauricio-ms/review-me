//! Single-file components (`.vue`, `.svelte`, `.astro`): read as one TypeScript or
//! JavaScript program laid out at the file's own byte offsets, so every position in the
//! tree is a position in the file.

use super::parse::Grammar;

/// A name a template binds — `v-for="item in items"`, `{#each items as item}` — and the
/// bytes it's visible across.
#[derive(Debug, Clone)]
pub struct TemplateBinding {
    pub name: String,
    pub byte: usize,
    pub scope: (usize, usize),
}

/// A component used in a template: where its tag name is written and the name it goes
/// by in script (`my-button` → `MyButton`).
#[derive(Debug, Clone)]
pub struct Tag {
    pub byte: usize,
    pub len: usize,
    pub name: String,
}

#[derive(Debug, Default)]
pub struct Template {
    pub bindings: Vec<TemplateBinding>,
    pub tags: Vec<Tag>,
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
}

pub struct VirtualDoc {
    pub grammar: Grammar,
    pub code: String,
    pub template: Template,
}

/// The program a single-file component reads as. `None` for any other file.
pub fn virtual_doc(_rel: &str, _source: &str) -> Option<VirtualDoc> {
    None
}
