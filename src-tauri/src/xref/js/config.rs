//! Aliases bundler and framework config adds, read from the config files without running
//! them: `alias` in Vite, webpack, Rollup, Rspack, Nuxt, Astro and Babel config (an object
//! or Vite's `[{ find, replacement }]`), webpack-chain's `alias.set(..)`, Jest's
//! `moduleNameMapper`, SvelteKit's `kit.alias`; and the ones frameworks add without
//! saying so — SvelteKit's `$lib`, Nuxt's `~`/`@`/`~~`/`@@`, Vue CLI's `@`, Quasar's
//! folders. A value that isn't a literal path or a well-known way of spelling one
//! (`path.resolve(__dirname, 'src')`, `fileURLToPath(new URL('./src', import.meta.url))`)
//! is skipped, never guessed.

use serde_json::Value;
use tree_sitter::{Node, Parser};

use super::jsonc;
use super::parse::{script_grammar, string_value, text, Grammar};
use super::project::{file_name, join, parent, Alias, Project};

/// Config file stems whose `alias` entries count.
const CONFIG_STEMS: &[&str] = &[
    "vite.config", "vitest.config", "electron.vite.config", "webpack.config",
    "rollup.config", "rspack.config", "rsbuild.config", "vue.config", "craco.config",
    "quasar.config", "quasar.conf", "astro.config", "nuxt.config", "svelte.config",
    "babel.config", "jest.config", "next.config",
];

/// Add every alias the configs among `files` declare, and the frameworks' own.
pub fn apply(project: &mut Project, files: &[String], read: &dyn Fn(&str) -> Option<String>) {
    let mut aliases = Vec::new();
    for rel in files {
        if rel.split('/').any(|s| s == "node_modules") {
            continue;
        }
        let name = file_name(rel);
        let dir = parent(rel);
        if matches!(name, ".babelrc" | ".babelrc.json" | "babel.config.json") {
            if let Some(json) = read(rel).and_then(|t| jsonc::parse(&t)) {
                json_aliases(&json, dir, &mut aliases);
            }
            continue;
        }
        let Some((stem, ext)) = name.rsplit_once('.') else {
            continue;
        };
        let scripted = matches!(ext, "js" | "ts" | "mjs" | "cjs" | "mts" | "cts");
        let webpack = stem.starts_with("webpack.");
        if !scripted || !(CONFIG_STEMS.contains(&stem) || webpack) {
            continue;
        }
        let Some(code) = read(rel) else {
            continue;
        };
        // SvelteKit writes `kit.alias` values as paths from the project, unadorned.
        let bare_paths = stem == "svelte.config";
        script_aliases(rel, &code, bare_paths, &mut aliases);
        conventions(project, rel, stem, &code, &mut aliases);
    }
    for (dir, json) in project
        .package_jsons()
        .map(|(d, j)| (d.to_string(), j.clone()))
        .collect::<Vec<_>>()
    {
        if depends_on(&json, "@vue/cli-service") {
            aliases.push(Alias { scope: dir.clone(), find: "@".into(), replacement: under(&dir, "src") });
        }
    }
    for alias in aliases {
        project.add_alias(alias);
    }
}

fn under(dir: &str, rel: &str) -> String {
    join(dir, rel).unwrap_or_default()
}

fn depends_on(json: &Value, name: &str) -> bool {
    ["dependencies", "devDependencies"]
        .iter()
        .any(|f| json.get(f).and_then(|d| d.get(name)).is_some())
}

/// The aliases frameworks add on their own, by the config file that says it's theirs.
fn conventions(project: &mut Project, rel: &str, stem: &str, code: &str, out: &mut Vec<Alias>) {
    let dir = parent(rel);
    let alias = |find: &str, to: String| Alias { scope: dir.to_string(), find: find.to_string(), replacement: to };
    match stem {
        "svelte.config" => {
            let lib = literal_option(code, "lib").unwrap_or_else(|| "src/lib".to_string());
            out.push(alias("$lib", under(dir, &lib)));
        }
        "nuxt.config" => {
            // Modules Nuxt and its modules generate: nothing in the project defines them.
            for prefix in [
                "#app", "#build", "#head", "#vue-router", "#internal", "#nitro", "#unhead",
                "#content", "#i18n", "#ui", "#color-mode", "#image", "#site-config", "#imports",
                "#components", "#auth-utils", "#hub", "#supabase", "#pwa",
            ] {
                project.add_virtual(dir, prefix);
            }
            let src = match literal_option(code, "srcDir") {
                Some(s) => under(dir, &s),
                // Nuxt 4 moved the app into `app/`.
                None => {
                    let app = under(dir, "app");
                    let nuxt4 = ["app.vue", "pages", "components", "layouts"]
                        .iter()
                        .any(|f| project.exists(&format!("{app}/{f}")) || project.is_dir(&format!("{app}/{f}")));
                    if nuxt4 { app } else { dir.to_string() }
                }
            };
            project.add_nuxt(dir, &src);
            for find in ["~", "@"] {
                out.push(alias(find, src.clone()));
            }
            for find in ["~~", "@@"] {
                out.push(alias(find, dir.to_string()));
            }
            out.push(alias("assets", format!("{src}/assets").trim_start_matches('/').to_string()));
            out.push(alias("public", under(dir, "public")));
            out.push(alias("#shared", under(dir, "shared")));
            out.push(alias("#server", under(dir, "server")));
        }
        "quasar.config" | "quasar.conf" => {
            for folder in ["components", "layouts", "pages", "assets", "boot", "stores"] {
                out.push(alias(folder, under(dir, &format!("src/{folder}"))));
            }
            out.push(alias("src", under(dir, "src")));
            out.push(alias("app", dir.to_string()));
        }
        _ => {}
    }
}

/// `name: 'literal'` anywhere in a config: Nuxt's `srcDir`, SvelteKit's `files.lib`.
fn literal_option(code: &str, name: &str) -> Option<String> {
    let at = code.find(&format!("{name}:"))?;
    let rest = code[at + name.len() + 1..].trim_start();
    let quote = rest.chars().next().filter(|c| matches!(c, '\'' | '"' | '`'))?;
    let end = rest[1..].find(quote)?;
    Some(rest[1..1 + end].trim_start_matches("./").to_string())
}

/// `"alias": { .. }` anywhere in a JSON config (Babel's module-resolver).
fn json_aliases(json: &Value, dir: &str, out: &mut Vec<Alias>) {
    match json {
        Value::Object(map) => {
            for (k, v) in map {
                if k == "alias" {
                    if let Some(entries) = v.as_object() {
                        for (find, to) in entries {
                            if let Some(to) = to.as_str().and_then(|t| path_from_string(t, dir, true)) {
                                out.push(Alias { scope: dir.to_string(), find: clean_find(find), replacement: to });
                            }
                        }
                    }
                } else {
                    json_aliases(v, dir, out);
                }
            }
        }
        Value::Array(list) => list.iter().for_each(|v| json_aliases(v, dir, out)),
        _ => {}
    }
}

/// `@/*` or `@/` as a key means `@`.
fn clean_find(find: &str) -> String {
    let f = find.trim_end_matches('$').trim_end_matches("/*").trim_end_matches('/');
    if f.is_empty() { find.to_string() } else { f.to_string() }
}

fn script_aliases(rel: &str, code: &str, bare_paths: bool, out: &mut Vec<Alias>) {
    let grammar = script_grammar(rel).unwrap_or(Grammar::Ts);
    let mut parser = Parser::new();
    if parser.set_language(&grammar.language()).is_err() {
        return;
    }
    let Some(tree) = parser.parse(code, None) else {
        return;
    };
    let cx = Eval { rel, dir: parent(rel), code, root: tree.root_node(), bare_paths };
    let mut stack = vec![tree.root_node()];
    let mut cursor = tree.walk();
    while let Some(n) = stack.pop() {
        match n.kind() {
            "pair" => {
                let key = n.child_by_field_name("key").map(|k| key_text(k, code));
                let value = n.child_by_field_name("value");
                match (key.as_deref(), value) {
                    (Some("alias"), Some(v)) => cx.alias_value(v, out),
                    (Some("moduleNameMapper"), Some(v)) => cx.jest_mapper(v, out),
                    _ => {}
                }
            }
            // `config.resolve.alias = { .. }`
            "assignment_expression" => {
                if let (Some(l), Some(r)) = (n.child_by_field_name("left"), n.child_by_field_name("right")) {
                    if text(l, code).ends_with(".alias") {
                        cx.alias_value(r, out);
                    }
                }
            }
            // webpack-chain: `config.resolve.alias.set('@', resolve('src'))`
            "call_expression" => {
                let f = n.child_by_field_name("function");
                if f.is_some_and(|f| text(f, code).ends_with("alias.set")) {
                    let args = n.child_by_field_name("arguments");
                    let find = args.and_then(|a| a.named_child(0)).filter(|a| a.kind() == "string");
                    let to = args.and_then(|a| a.named_child(1)).and_then(|v| cx.path(v, 0));
                    if let (Some(find), Some(to)) = (find, to) {
                        out.push(Alias { scope: cx.dir.to_string(), find: clean_find(string_value(find, code)), replacement: to });
                    }
                }
            }
            _ => {}
        }
        let children: Vec<Node> = n.named_children(&mut cursor).collect();
        stack.extend(children);
    }
}

fn key_text(key: Node, code: &str) -> String {
    if key.kind() == "string" {
        string_value(key, code).to_string()
    } else {
        text(key, code).to_string()
    }
}

/// Evaluates path expressions in one config file.
struct Eval<'a> {
    rel: &'a str,
    dir: &'a str,
    code: &'a str,
    root: Node<'a>,
    bare_paths: bool,
}

impl Eval<'_> {
    /// `{ '@': path }` or `[{ find: '@', replacement: path }]`.
    fn alias_value(&self, value: Node, out: &mut Vec<Alias>) {
        let mut cursor = value.walk();
        match value.kind() {
            "object" => {
                for pair in value.named_children(&mut cursor).filter(|p| p.kind() == "pair") {
                    let (Some(k), Some(v)) = (pair.child_by_field_name("key"), pair.child_by_field_name("value")) else {
                        continue;
                    };
                    if let Some(to) = self.path(v, 0) {
                        out.push(Alias { scope: self.dir.to_string(), find: clean_find(&key_text(k, self.code)), replacement: to });
                    }
                }
            }
            "array" => {
                for entry in value.named_children(&mut cursor).filter(|e| e.kind() == "object") {
                    let mut ec = entry.walk();
                    let mut find = None;
                    let mut to = None;
                    for pair in entry.named_children(&mut ec).filter(|p| p.kind() == "pair") {
                        let (Some(k), Some(v)) = (pair.child_by_field_name("key"), pair.child_by_field_name("value")) else {
                            continue;
                        };
                        match key_text(k, self.code).as_str() {
                            "find" => {
                                find = match v.kind() {
                                    "string" => Some(clean_find(string_value(v, self.code))),
                                    "regex" => regex_prefix(text(v, self.code)),
                                    _ => None,
                                }
                            }
                            "replacement" => to = self.path(v, 0),
                            _ => {}
                        }
                    }
                    if let (Some(find), Some(to)) = (find, to) {
                        out.push(Alias { scope: self.dir.to_string(), find, replacement: to });
                    }
                }
            }
            _ => {}
        }
    }

    /// Jest's `'^@/(.*)$': '<rootDir>/src/$1'`.
    fn jest_mapper(&self, value: Node, out: &mut Vec<Alias>) {
        let mut cursor = value.walk();
        for pair in value.named_children(&mut cursor).filter(|p| p.kind() == "pair") {
            let (Some(k), Some(v)) = (pair.child_by_field_name("key"), pair.child_by_field_name("value")) else {
                continue;
            };
            let Some(find) = regex_prefix(&format!("/{}/", key_text(k, self.code))) else {
                continue;
            };
            if v.kind() != "string" {
                continue;
            }
            let to = string_value(v, self.code);
            let Some(to) = to.strip_suffix("$1").map(|t| t.trim_end_matches('/')) else {
                continue;
            };
            let to = to.replace("<rootDir>", "");
            if let Some(to) = join(self.dir, to.trim_start_matches('/')) {
                out.push(Alias { scope: self.dir.to_string(), find, replacement: to });
            }
        }
    }

    /// The repo-relative path an expression spells, if it's one we can read.
    fn path(&self, node: Node, depth: usize) -> Option<String> {
        if depth > 6 {
            return None;
        }
        let code = self.code;
        match node.kind() {
            "string" => path_from_string(string_value(node, code), self.dir, self.bare_paths),
            "template_string" => {
                let mut out = String::new();
                let mut cursor = node.walk();
                for part in node.named_children(&mut cursor) {
                    match part.kind() {
                        "string_fragment" => out.push_str(text(part, code)),
                        "template_substitution" => out.push_str(&format!("/{}/", self.path(part.named_child(0)?, depth + 1)?)),
                        _ => return None,
                    }
                }
                if out.starts_with('/') {
                    join("", &out)
                } else {
                    path_from_string(&out, self.dir, self.bare_paths)
                }
            }
            "identifier" => match text(node, code) {
                "__dirname" => Some(self.dir.to_string()),
                name => self.path(self.constant(name)?, depth + 1),
            },
            "member_expression" => match text(node, code) {
                "import.meta.dirname" => Some(self.dir.to_string()),
                "import.meta.url" => Some(self.rel.to_string()),
                _ if node.child_by_field_name("property").is_some_and(|p| text(p, code) == "pathname") => {
                    self.path(node.child_by_field_name("object")?, depth + 1)
                }
                _ => None,
            },
            "new_expression" => {
                // `new URL('./src', import.meta.url)`
                let args = node.child_by_field_name("arguments")?;
                let rel = args.named_child(0).filter(|a| a.kind() == "string")?;
                let base = self.path(args.named_child(1)?, depth + 1)?;
                join(parent(&base), string_value(rel, code))
            }
            "call_expression" => {
                let f = text(node.child_by_field_name("function")?, code);
                let args = node.child_by_field_name("arguments")?;
                let mut cursor = args.walk();
                let args: Vec<Node> = args.named_children(&mut cursor).collect();
                match f.rsplit('.').next().unwrap_or(f) {
                    "fileURLToPath" | "normalize" => self.path(*args.first()?, depth + 1),
                    "cwd" => Some(self.dir.to_string()),
                    "dirname" => Some(parent(&self.path(*args.first()?, depth + 1)?).to_string()),
                    // `path.resolve`, `path.join`, and the `resolve(dir)` helpers configs define.
                    "resolve" | "join" => {
                        let mut acc = self.dir.to_string();
                        for a in args {
                            acc = match a.kind() {
                                "string" | "template_string" if !text(a, code).contains("${") => {
                                    let s = string_value(a, code);
                                    let s = if a.kind() == "template_string" {
                                        text(a, code).trim_matches('`')
                                    } else {
                                        s
                                    };
                                    if s.starts_with('/') {
                                        return None;
                                    }
                                    join(&acc, s)?
                                }
                                _ => self.path(a, depth + 1)?,
                            };
                        }
                        Some(acc)
                    }
                    _ => None,
                }
            }
            _ => None,
        }
    }

    /// The value of a top-level `const name = ..` in the config.
    fn constant(&self, name: &str) -> Option<Node<'_>> {
        let mut cursor = self.root.walk();
        for stmt in self.root.named_children(&mut cursor) {
            if !matches!(stmt.kind(), "lexical_declaration" | "variable_declaration") {
                continue;
            }
            let mut dc = stmt.walk();
            for d in stmt.named_children(&mut dc) {
                if d.child_by_field_name("name").is_some_and(|n| text(n, self.code) == name) {
                    return d.child_by_field_name("value");
                }
            }
        }
        None
    }
}

/// A literal alias target: `./src` or `src` from the config's folder (bare only where the
/// config writes paths so — elsewhere a bare name is a package), `/src` from the project
/// root the bundler serves.
fn path_from_string(s: &str, dir: &str, bare_paths: bool) -> Option<String> {
    let s = s.trim_end_matches("/*");
    if let Some(rest) = s.strip_prefix('/') {
        return join(dir, rest);
    }
    if s.starts_with("./") || s.starts_with("../") || s == "." || bare_paths {
        return join(dir, s);
    }
    None
}

/// The literal prefix a simple regex alias matches: `/^@\//` → `@`, `^~(.*)$` → `~`.
fn regex_prefix(regex: &str) -> Option<String> {
    let body = regex.trim_start_matches('/').rsplit_once('/')?.0;
    let body = body.strip_prefix('^')?;
    let body = body
        .trim_end_matches('$')
        .trim_end_matches("(.*)")
        .trim_end_matches(".*");
    let unescaped = body.replace("\\/", "/");
    let prefix = unescaped.trim_end_matches('/');
    let plain = !prefix.is_empty() && !prefix.contains(|c: char| "\\[](){}|+*?.^$".contains(c));
    plain.then(|| prefix.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::xref::js::project::ModuleRes;
    use std::collections::HashMap;

    fn project(files: &[(&str, &str)]) -> Project {
        let map: HashMap<String, String> =
            files.iter().map(|(p, t)| (p.to_string(), t.to_string())).collect();
        let paths: Vec<String> = files.iter().map(|(p, _)| p.to_string()).collect();
        let read = |p: &str| map.get(p).cloned();
        let mut project = Project::load(&paths, &read);
        apply(&mut project, &paths, &read);
        project
    }

    fn file(p: &str) -> ModuleRes {
        ModuleRes::File(p.to_string())
    }

    #[test]
    fn vite_and_webpack_aliases() {
        let p = project(&[
            (
                "web/vite.config.ts",
                "import { fileURLToPath, URL } from 'node:url'\nimport path from 'path'\nconst lib = path.resolve(__dirname, 'lib')\nexport default defineConfig({\n  resolve: {\n    alias: {\n      '@': fileURLToPath(new URL('./src', import.meta.url)),\n      '#lib': lib,\n      '~utils': `${__dirname}/src/utils`,\n      vue: 'vue/dist/vue.esm-bundler.js',\n    },\n  },\n})\n",
            ),
            ("web/src/App.vue", ""),
            ("web/lib/x.ts", ""),
            ("web/src/utils/date.ts", ""),
            (
                "admin/webpack.common.js",
                "const path = require('path');\nmodule.exports = { resolve: { alias: [{ find: /^@\\//, replacement: path.join(__dirname, 'app') }] } };\n",
            ),
            ("admin/app/store.js", ""),
            ("legacy/vue.config.js", "function resolve(dir) { return path.join(__dirname, dir) }\nmodule.exports = { chainWebpack: (config) => { config.resolve.alias.set('@@', resolve('src')) } }\n"),
            ("legacy/src/a.js", ""),
        ]);
        assert_eq!(p.resolve("web/src/main.ts", "@/App.vue"), file("web/src/App.vue"));
        assert_eq!(p.resolve("web/src/main.ts", "#lib/x"), file("web/lib/x.ts"));
        assert_eq!(p.resolve("web/src/main.ts", "~utils/date"), file("web/src/utils/date.ts"));
        assert_eq!(p.resolve("web/src/main.ts", "vue"), ModuleRes::External, "an alias onto a package");
        assert_eq!(p.resolve("admin/app/main.js", "@/store"), file("admin/app/store.js"));
        assert_eq!(p.resolve("legacy/src/main.js", "@@/a"), file("legacy/src/a.js"));
    }

    #[test]
    fn framework_conventions() {
        let p = project(&[
            ("kit/svelte.config.js", "export default { kit: { adapter: adapter(), alias: { $components: 'src/components' } } };\n"),
            ("kit/src/lib/db.ts", ""),
            ("kit/src/components/Nav.svelte", ""),
            ("shop/nuxt.config.ts", "export default defineNuxtConfig({})\n"),
            ("shop/app/app.vue", ""),
            ("shop/app/composables/useCart.ts", ""),
            ("shop/server/db.ts", ""),
            ("cli/package.json", r#"{ "devDependencies": { "@vue/cli-service": "5" } }"#),
            ("cli/src/router.js", ""),
            ("jest.config.js", "module.exports = { moduleNameMapper: { '^~/(.*)$': '<rootDir>/shared/$1', '\\\\.css$': 'identity-obj-proxy' } };\n"),
            ("shared/fmt.ts", ""),
        ]);
        assert_eq!(p.resolve("kit/src/routes/+page.ts", "$lib/db"), file("kit/src/lib/db.ts"));
        assert_eq!(p.resolve("kit/src/routes/+page.ts", "$components/Nav.svelte"), file("kit/src/components/Nav.svelte"));
        assert_eq!(p.resolve("shop/app/pages/index.vue", "~/composables/useCart"), file("shop/app/composables/useCart.ts"));
        assert_eq!(p.resolve("shop/app/pages/index.vue", "~~/server/db"), file("shop/server/db.ts"));
        assert_eq!(p.resolve("cli/src/main.js", "@/router"), file("cli/src/router.js"));
        assert_eq!(p.resolve("tests/a.test.ts", "~/fmt"), file("shared/fmt.ts"));
    }

    #[test]
    fn regex_prefixes() {
        assert_eq!(regex_prefix("/^@\\//"), Some("@".to_string()));
        assert_eq!(regex_prefix("/^~(.*)$/"), Some("~".to_string()));
        assert_eq!(regex_prefix("/^@\\/(.*)$/"), Some("@".to_string()));
        assert_eq!(regex_prefix("/\\.css$/"), None);
    }
}
