//! A project's own say on where an import leads: its `tsconfig`/`jsconfig` files
//! (`paths`, `baseUrl`, `extends`), its `package.json` files (workspace packages by
//! name, `exports`, `imports`, declared dependencies), and aliases that bundler and
//! framework config add. Everything is read from the revision under review, never from
//! `node_modules` — a revision that isn't checked out has none.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::jsonc;
use crate::generated::glob_match;

/// Where a module specifier leads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModuleRes {
    /// A file in this revision.
    File(String),
    /// A package or runtime module from outside the project: nothing here defines it.
    External,
    /// Nothing we can work out — an alias we couldn't read, a file that isn't there.
    Unresolved,
}

/// What an extensionless specifier may name, TypeScript's first.
pub const PROBE_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "d.ts", "js", "jsx", "mts", "mjs", "cts", "cjs", "vue", "svelte", "astro",
    "json",
];

/// Node's own modules, importable without `node:`.
const NODE_BUILTINS: &[&str] = &[
    "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
    "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http",
    "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process",
    "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys",
    "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi",
    "worker_threads", "zlib",
];

/// Specifier prefixes that name a runtime, a URL, or a module a tool makes up at build
/// time: never a file here, and nothing in the project defines them.
const EXTERNAL_PREFIXES: &[&str] = &[
    "node:", "bun:", "npm:", "jsr:", "deno:", "http:", "https:", "data:", "virtual:",
    "~icons/", "astro:", "$app/", "$env/", "$service-worker", "@vite/", "\0",
];

/// `package.json` fields that name a package's entry, most source-like first: in a
/// monorepo the built entry (`dist/…`) usually isn't committed.
const ENTRY_FIELDS: &[&str] = &["source", "types", "typings", "module", "main", "svelte"];

/// `exports` conditions, most source-like first.
const CONDITIONS: &[&str] = &[
    "source", "development", "types", "import", "module", "browser", "svelte", "default",
    "require", "node",
];

/// Build output folders a package's entry may point into, whose sources sit in `src`.
const BUILD_DIRS: &[&str] = &["dist", "build", "lib", "out", "esm", "cjs", "es"];

struct Package {
    dir: String,
    json: Value,
}

/// One `tsconfig.json`/`jsconfig.json`, with what it inherits folded in.
struct TsConfig {
    dir: String,
    /// `compilerOptions.paths`, and the folder its targets count from when there's no
    /// `baseUrl`: the config that wrote them.
    paths: Vec<(String, Vec<String>)>,
    paths_dir: String,
    base_url: Option<String>,
    /// `include` and `files`, repo-relative. Neither means everything under `dir`.
    include: Option<Vec<String>>,
    files: Option<Vec<String>>,
}

/// An alias a bundler or framework adds: `find` (exactly, or followed by `/…`) becomes
/// `replacement`, for files under `scope`.
#[derive(Debug, Clone)]
pub struct Alias {
    pub scope: String,
    pub find: String,
    pub replacement: String,
}

pub struct Project {
    files: HashSet<String>,
    dirs: HashSet<String>,
    packages: Vec<Package>,
    /// Packages by name — several, when a repo holds templates or fixtures that reuse one.
    by_name: HashMap<String, Vec<usize>>,
    deps: HashSet<String>,
    configs: Vec<TsConfig>,
    aliases: Vec<Alias>,
    /// Module prefixes a framework makes up at build time (Nuxt's `#app`), by the folder
    /// whose files see them.
    virtual_modules: Vec<(String, String)>,
    /// Nuxt apps: their root and the folder their app code is in (`srcDir`).
    nuxt: Vec<(String, String)>,
    /// Folder → the configs that may apply to its files, best first.
    configs_by_dir: RefCell<HashMap<String, Vec<usize>>>,
}

impl Project {
    /// Read the configs among `files` through `read` (repo-relative path → text).
    pub fn load(files: &[String], read: &dyn Fn(&str) -> Option<String>) -> Project {
        let mut dirs = HashSet::new();
        for f in files {
            let mut d = parent(f);
            while !d.is_empty() && dirs.insert(d.to_string()) {
                d = parent(d);
            }
        }
        let mut packages = Vec::new();
        let mut config_paths = Vec::new();
        for f in files {
            if f.split('/').any(|seg| seg == "node_modules") {
                continue;
            }
            let name = file_name(f);
            if name == "package.json" {
                if let Some(json) = read(f).and_then(|t| jsonc::parse(&t)) {
                    packages.push(Package {
                        dir: parent(f).to_string(),
                        json,
                    });
                }
            } else if (name.starts_with("tsconfig") || name.starts_with("jsconfig"))
                && name.ends_with(".json")
            {
                config_paths.push(f.clone());
            }
        }
        // Shallower packages first, so a fixture's copy of a name never shadows the real one.
        packages.sort_by_key(|p| (p.dir.matches('/').count(), p.dir.clone()));
        let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
        let mut deps = HashSet::new();
        for (i, p) in packages.iter().enumerate() {
            if let Some(name) = p.json.get("name").and_then(Value::as_str) {
                by_name.entry(name.to_string()).or_default().push(i);
            }
            for field in [
                "dependencies",
                "devDependencies",
                "peerDependencies",
                "optionalDependencies",
            ] {
                if let Some(map) = p.json.get(field).and_then(Value::as_object) {
                    deps.extend(map.keys().cloned());
                }
            }
        }
        let mut project = Project {
            files: files.iter().cloned().collect(),
            dirs,
            packages,
            by_name,
            deps,
            configs: Vec::new(),
            aliases: Vec::new(),
            virtual_modules: Vec::new(),
            nuxt: Vec::new(),
            configs_by_dir: RefCell::new(HashMap::new()),
        };
        let mut configs = Vec::new();
        for path in &config_paths {
            if let Some(raw) = project.load_config(path, read, &mut Vec::new()) {
                configs.push(raw.finish(parent(path)));
            }
        }
        project.configs = configs;
        project
    }

    /// Whether `rel` is a file in this revision.
    pub fn exists(&self, rel: &str) -> bool {
        self.files.contains(rel)
    }

    /// Whether `rel` is a folder in this revision.
    pub fn is_dir(&self, rel: &str) -> bool {
        rel.is_empty() || self.dirs.contains(rel)
    }

    pub fn add_alias(&mut self, alias: Alias) {
        self.aliases.push(alias);
    }

    /// Specifiers starting `prefix` are a framework's own modules for files under `scope`.
    pub fn add_virtual(&mut self, scope: &str, prefix: &str) {
        self.virtual_modules.push((scope.to_string(), prefix.to_string()));
    }

    pub fn add_nuxt(&mut self, root: &str, src: &str) {
        self.nuxt.push((root.to_string(), src.to_string()));
    }

    /// The Nuxt app `rel` belongs to: its root and `srcDir`.
    pub fn nuxt_for(&self, rel: &str) -> Option<(&str, &str)> {
        self.nuxt
            .iter()
            .filter(|(root, _)| within(rel, root))
            .max_by_key(|(root, _)| root.len())
            .map(|(r, s)| (r.as_str(), s.as_str()))
    }

    /// Whether some `package.json` depends on `name`.
    pub fn has_dependency(&self, name: &str) -> bool {
        self.deps.contains(name)
    }

    /// Every file under the folder `dir`.
    pub fn files_under<'s>(&'s self, dir: &'s str) -> impl Iterator<Item = &'s String> + 's {
        self.files.iter().filter(move |f| within(f, dir))
    }

    /// The package named `name` nearest `from`: the one sharing most of its path, as a
    /// workspace's own copy beats a template's.
    fn package_named(&self, name: &str, from: &str) -> Option<usize> {
        let shared = |dir: &str| {
            dir.split('/')
                .zip(from.split('/'))
                .take_while(|(a, b)| a == b)
                .count()
        };
        self.by_name
            .get(name)?
            .iter()
            .copied()
            .max_by_key(|&i| (shared(&self.packages[i].dir), std::cmp::Reverse(i)))
    }

    /// Files whose name is `stem` with one of `extensions`, sorted.
    pub fn files_named(&self, stem: &str, extensions: &[&str]) -> Vec<String> {
        let mut out: Vec<String> = self
            .files
            .iter()
            .filter(|f| {
                file_name(f)
                    .rsplit_once('.')
                    .is_some_and(|(s, e)| s == stem && extensions.contains(&e))
            })
            .cloned()
            .collect();
        out.sort();
        out
    }

    /// Every `package.json` in the revision: its folder and contents.
    pub fn package_jsons(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.packages.iter().map(|p| (p.dir.as_str(), &p.json))
    }

    /// The folder of the nearest `package.json` above `rel` (the repo root without one).
    pub fn package_root<'r>(&self, rel: &'r str) -> &'r str {
        let mut d = parent(rel);
        loop {
            if self.packages.iter().any(|p| p.dir == d) || d.is_empty() {
                return d;
            }
            d = parent(d);
        }
    }

    /// Where `spec`, imported from the file `from`, leads.
    pub fn resolve(&self, from: &str, spec: &str) -> ModuleRes {
        let spec = spec.split('?').next().unwrap_or(spec);
        if spec.is_empty() {
            return ModuleRes::Unresolved;
        }
        if EXTERNAL_PREFIXES.iter().any(|p| spec.starts_with(p)) {
            return ModuleRes::External;
        }
        if self
            .virtual_modules
            .iter()
            .any(|(scope, prefix)| spec.starts_with(prefix.as_str()) && within(from, scope))
        {
            return ModuleRes::External;
        }
        if spec.starts_with("./") || spec.starts_with("../") || spec == "." || spec == ".." {
            let Some(path) = join(parent(from), spec) else {
                return ModuleRes::Unresolved;
            };
            return self.found(self.probe(&path).or_else(|| self.built_entry(&path)));
        }
        if let Some(abs) = spec.strip_prefix('/') {
            // From the project root a bundler serves, or the `public/` folder it copies.
            let root = self.package_root(from);
            let found = [join(root, abs), join(root, &format!("public/{abs}")), Some(abs.to_string())]
                .into_iter()
                .flatten()
                .find_map(|p| self.probe(&p));
            return self.found(found);
        }
        if spec.starts_with('#') {
            if let Some(found) = self.package_import(from, spec) {
                return ModuleRes::File(found);
            }
        }
        let configs = self.configs_for(from);
        for &c in &configs {
            if let Some(found) = self.via_paths(&self.configs[c], spec) {
                return ModuleRes::File(found);
            }
        }
        if let Some(found) = self.via_aliases(from, spec) {
            return found;
        }
        for &c in &configs {
            if let Some(base) = &self.configs[c].base_url {
                if let Some(found) = join(base, spec).and_then(|p| self.probe(&p)) {
                    return ModuleRes::File(found);
                }
            }
        }
        if spec.starts_with('#') {
            return ModuleRes::Unresolved;
        }
        let (name, sub) = split_package(spec);
        if let Some(pkg) = self.package_named(name, from) {
            return self.found(self.resolve_package(pkg, &sub));
        }
        if self.deps.contains(name) || NODE_BUILTINS.contains(&name) {
            return ModuleRes::External;
        }
        // Undeclared. A first segment naming a folder here is an alias we couldn't read
        // (`src/…`, `components/…`); anything else shaped like a package name is a
        // package — perhaps one a parent workspace declares.
        let first = spec.split('/').next().unwrap_or(spec);
        let root = self.package_root(from);
        let local = [root, ""].iter().any(|base| {
            [first.to_string(), format!("src/{first}")]
                .iter()
                .filter_map(|d| join(base, d))
                .any(|d| self.dirs.contains(&d))
        });
        if !local && is_package_name(name) {
            ModuleRes::External
        } else {
            ModuleRes::Unresolved
        }
    }

    fn found(&self, path: Option<String>) -> ModuleRes {
        path.map_or(ModuleRes::Unresolved, ModuleRes::File)
    }

    /// The file `path` names: itself, its TypeScript source when it names the compiled
    /// `.js`, with an extension added, or a folder's entry.
    pub fn probe(&self, path: &str) -> Option<String> {
        self.probe_at(path, 0)
    }

    fn probe_at(&self, path: &str, depth: usize) -> Option<String> {
        let path = path.trim_end_matches('/');
        if self.files.contains(path) {
            return Some(path.to_string());
        }
        // `./foo.js` written for `foo.ts`, as ESM TypeScript must.
        let rewrites: &[(&str, &[&str])] = &[
            (".js", &[".ts", ".tsx", ".d.ts"]),
            (".jsx", &[".tsx"]),
            (".mjs", &[".mts", ".d.mts"]),
            (".cjs", &[".cts", ".d.cts"]),
        ];
        for (ext, alts) in rewrites {
            if let Some(stem) = path.strip_suffix(ext) {
                for alt in *alts {
                    let candidate = format!("{stem}{alt}");
                    if self.files.contains(&candidate) {
                        return Some(candidate);
                    }
                }
            }
        }
        for ext in PROBE_EXTENSIONS {
            let candidate = format!("{path}.{ext}");
            if self.files.contains(&candidate) {
                return Some(candidate);
            }
        }
        if self.is_dir(path) && depth < 2 {
            if let Some(pkg) = self.packages.iter().find(|p| p.dir == path) {
                for field in ENTRY_FIELDS {
                    if let Some(entry) = pkg.json.get(field).and_then(Value::as_str) {
                        if let Some(found) = join(path, entry).and_then(|p| self.probe_at(&p, depth + 1)) {
                            return Some(found);
                        }
                    }
                }
            }
            let index = if path.is_empty() {
                "index".to_string()
            } else {
                format!("{path}/index")
            };
            for ext in PROBE_EXTENSIONS {
                let candidate = format!("{index}.{ext}");
                if self.files.contains(&candidate) {
                    return Some(candidate);
                }
            }
        }
        None
    }

    /// A workspace package's file for `sub` (`.` or `./x`): through its `exports`, else
    /// its entry fields, else the path itself — each tried at the source a build output
    /// path stands for, since `dist` is rarely committed.
    fn resolve_package(&self, pkg: usize, sub: &str) -> Option<String> {
        let p = &self.packages[pkg];
        let mut targets = Vec::new();
        match p.json.get("exports") {
            Some(exports) if !exports.is_null() => targets.extend(export_targets(exports, sub)),
            _ => {}
        }
        if sub == "." {
            for field in ENTRY_FIELDS {
                if let Some(entry) = p.json.get(field).and_then(Value::as_str) {
                    targets.push(entry.to_string());
                }
            }
            targets.push("./src/index".to_string());
            targets.push("./index".to_string());
        } else {
            targets.push(sub.to_string());
            targets.push(format!("./src/{}", sub.trim_start_matches("./")));
        }
        for target in &targets {
            let Some(path) = join(&p.dir, target) else {
                continue;
            };
            if let Some(found) = self.probe(&path).or_else(|| self.probe_source_of(&path)) {
                return Some(found);
            }
        }
        if sub != "." {
            // `vue/dist/vue.runtime.esm-browser.js`: a bundle of the package, which isn't
            // committed — its entry is what it bundles.
            return join(&p.dir, &sub).and_then(|path| self.built_entry(&path));
        }
        None
    }

    /// A path into a package's build output that isn't there: the package's entry, which
    /// the build bundles (`packages/x/dist/x.cjs.js` → `packages/x/src/index.ts`).
    fn built_entry(&self, path: &str) -> Option<String> {
        let segments: Vec<&str> = path.split('/').collect();
        let at = segments.iter().position(|s| BUILD_DIRS.contains(s))?;
        let dir = segments[..at].join("/");
        let pkg = self.packages.iter().position(|p| p.dir == dir)?;
        self.resolve_package(pkg, ".")
    }

    /// The source a build output path stands for: `dist/index.js` → `src/index.ts`.
    fn probe_source_of(&self, path: &str) -> Option<String> {
        let path = path
            .strip_suffix(".d.ts")
            .or_else(|| path.strip_suffix(".d.mts"))
            .unwrap_or(path);
        let segments: Vec<&str> = path.split('/').collect();
        let at = segments.iter().position(|s| BUILD_DIRS.contains(s))?;
        let mut swapped = segments.clone();
        swapped[at] = "src";
        let candidate = swapped.join("/");
        self.probe(&candidate).or_else(|| {
            // `dist/esm/index.js` for `src/index.ts`: the build added a folder of its own.
            let mut dropped = segments.clone();
            dropped.remove(at);
            if at < dropped.len() && BUILD_DIRS.contains(&dropped[at]) {
                dropped[at] = "src";
            } else {
                dropped.insert(at, "src");
            }
            self.probe(&dropped.join("/"))
        })
    }

    /// `#internal` through the nearest `package.json`'s `imports`.
    fn package_import(&self, from: &str, spec: &str) -> Option<String> {
        let root = self.package_root(from);
        let pkg = self.packages.iter().find(|p| p.dir == root)?;
        let imports = pkg.json.get("imports")?.as_object()?;
        for target in subpath_targets(imports, spec) {
            if let Some(found) = join(&pkg.dir, &target).and_then(|p| self.probe(&p)) {
                return Some(found);
            }
            if target.starts_with('.') {
                continue;
            }
            // `#db` → `some-package`: an external one, or a workspace one.
            let (name, sub) = split_package(&target);
            if let Some(pkg) = self.package_named(name, from) {
                return self.resolve_package(pkg, &sub);
            }
        }
        None
    }

    /// Where `spec`, written in `from`, may point through the project's aliases and
    /// `paths` — unprobed, for loaders that find files their own way (Sass's partials).
    pub fn expand(&self, from: &str, spec: &str) -> Vec<String> {
        let mut out = Vec::new();
        for alias in self.aliases.iter().filter(|a| within(from, &a.scope)) {
            if spec == alias.find || spec.strip_prefix(alias.find.as_str()).is_some_and(|r| r.starts_with('/')) {
                out.push(format!("{}{}", alias.replacement, &spec[alias.find.len()..]).trim_start_matches('/').to_string());
            }
        }
        for c in self.configs_for(from) {
            let config = &self.configs[c];
            let base = config.base_url.as_deref().unwrap_or(&config.paths_dir);
            for (pattern, targets) in &config.paths {
                let star = match pattern.split_once('*') {
                    None if pattern == spec => Some(""),
                    Some((prefix, suffix)) if spec.starts_with(prefix) && spec.ends_with(suffix) && spec.len() >= prefix.len() + suffix.len() => {
                        Some(&spec[prefix.len()..spec.len() - suffix.len()])
                    }
                    _ => None,
                };
                if let Some(star) = star {
                    out.extend(targets.iter().filter_map(|t| join(base, &t.replacen('*', star, 1))));
                }
            }
            if let Some(base) = &config.base_url {
                out.extend(join(base, spec));
            }
        }
        out
    }

    /// `spec` through a config's `paths`: the exact pattern, else the one with the
    /// longest prefix, its targets tried in order.
    fn via_paths(&self, config: &TsConfig, spec: &str) -> Option<String> {
        let base = config.base_url.as_deref().unwrap_or(&config.paths_dir);
        let mut best: Option<(&Vec<String>, &str)> = None;
        let mut best_len = 0;
        for (pattern, targets) in &config.paths {
            match pattern.split_once('*') {
                None if pattern == spec => {
                    best = Some((targets, ""));
                    break;
                }
                None => {}
                Some((prefix, suffix)) => {
                    if spec.len() >= prefix.len() + suffix.len()
                        && spec.starts_with(prefix)
                        && spec.ends_with(suffix)
                        && (best.is_none() || prefix.len() > best_len)
                    {
                        best_len = prefix.len();
                        best = Some((targets, &spec[prefix.len()..spec.len() - suffix.len()]));
                    }
                }
            }
        }
        let (targets, star) = best?;
        targets.iter().find_map(|t| {
            let target = t.replacen('*', star, 1);
            join(base, &target).and_then(|p| self.probe(&p))
        })
    }

    /// `spec` through a bundler's or framework's aliases, the most specific first.
    fn via_aliases(&self, from: &str, spec: &str) -> Option<ModuleRes> {
        let mut best: Option<&Alias> = None;
        for alias in &self.aliases {
            let applies = within(from, &alias.scope);
            let matches = spec == alias.find
                || spec
                    .strip_prefix(alias.find.as_str())
                    .is_some_and(|rest| rest.starts_with('/') || alias.find.ends_with('/'));
            if applies && matches && best.map_or(true, |b| alias.find.len() > b.find.len()) {
                best = Some(alias);
            }
        }
        let alias = best?;
        let rest = &spec[alias.find.len()..];
        let replaced = format!("{}{}", alias.replacement, rest);
        // An alias onto a package name (`'vue': 'vue/dist/vue.esm.js'`) is the package's.
        if !alias.replacement.contains('/') && !self.is_dir(&alias.replacement) {
            return None;
        }
        Some(self.found(self.probe(replaced.trim_start_matches('/'))))
    }

    /// The configs that may apply to `file`, the ones that include it first, nearest
    /// first; then the ones above it that don't, still nearest first.
    fn configs_for(&self, file: &str) -> Vec<usize> {
        let dir = parent(file).to_string();
        if let Some(found) = self.configs_by_dir.borrow().get(&dir) {
            return found.clone();
        }
        let above = |c: &TsConfig| c.dir.is_empty() || dir == c.dir || dir.starts_with(&format!("{}/", c.dir));
        let mut covering: Vec<usize> = Vec::new();
        let mut rest: Vec<usize> = Vec::new();
        for (i, c) in self.configs.iter().enumerate() {
            if c.covers(file) {
                covering.push(i);
            } else if above(c) {
                rest.push(i);
            }
        }
        let depth = |i: &usize| std::cmp::Reverse(self.configs[*i].dir.len());
        covering.sort_by_key(depth);
        rest.sort_by_key(depth);
        covering.extend(rest);
        self.configs_by_dir.borrow_mut().insert(dir, covering.clone());
        covering
    }

    /// A config file with everything it `extends` folded in.
    fn load_config(
        &self,
        path: &str,
        read: &dyn Fn(&str) -> Option<String>,
        seen: &mut Vec<String>,
    ) -> Option<RawConfig> {
        if seen.iter().any(|s| s == path) || seen.len() > 8 {
            return None;
        }
        seen.push(path.to_string());
        let json = jsonc::parse(&read(path)?)?;
        let dir = parent(path).to_string();
        let mut merged = RawConfig::default();
        let extends: Vec<String> = match json.get("extends") {
            Some(Value::String(s)) => vec![s.clone()],
            Some(Value::Array(list)) => list.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
            _ => Vec::new(),
        };
        for base in extends {
            if let Some(base_path) = self.config_path(&dir, &base) {
                if let Some(raw) = self.load_config(&base_path, read, seen) {
                    merged.overlay(raw);
                }
            }
        }
        let options = json.get("compilerOptions");
        let own = RawConfig {
            base_url: options
                .and_then(|o| o.get("baseUrl"))
                .and_then(Value::as_str)
                .and_then(|b| join(&dir, b)),
            paths: options.and_then(|o| o.get("paths")).and_then(Value::as_object).map(|map| {
                let paths = map
                    .iter()
                    .map(|(k, v)| {
                        let targets = v
                            .as_array()
                            .map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect())
                            .unwrap_or_default();
                        (k.clone(), targets)
                    })
                    .collect();
                (paths, dir.clone())
            }),
            include: patterns(&json, "include", &dir),
            files: patterns(&json, "files", &dir),
        };
        merged.overlay(own);
        Some(merged)
    }

    /// The file an `extends` names: relative to the config, or inside a workspace package.
    fn config_path(&self, dir: &str, spec: &str) -> Option<String> {
        let candidates: Vec<String> = if spec.starts_with('.') || spec.starts_with('/') {
            vec![join(dir, spec)?]
        } else {
            let (name, sub) = split_package(spec);
            let pkg = &self.packages[self.package_named(name, dir)?];
            let target = if sub == "." { "tsconfig.json".to_string() } else { sub };
            vec![join(&pkg.dir, &target)?]
        };
        for c in candidates {
            for candidate in [c.clone(), format!("{c}.json"), format!("{c}/tsconfig.json")] {
                if self.files.contains(&candidate) {
                    return Some(candidate);
                }
            }
        }
        None
    }
}

#[derive(Default)]
struct RawConfig {
    base_url: Option<String>,
    paths: Option<(Vec<(String, Vec<String>)>, String)>,
    include: Option<Vec<String>>,
    files: Option<Vec<String>>,
}

impl RawConfig {
    /// `other`'s settings over these, option by option, as `extends` merges them.
    fn overlay(&mut self, other: RawConfig) {
        if other.base_url.is_some() {
            self.base_url = other.base_url;
        }
        if other.paths.is_some() {
            self.paths = other.paths;
        }
        if other.include.is_some() {
            self.include = other.include;
        }
        if other.files.is_some() {
            self.files = other.files;
        }
    }

    fn finish(self, dir: &str) -> TsConfig {
        let (paths, paths_dir) = self.paths.unwrap_or_else(|| (Vec::new(), dir.to_string()));
        TsConfig {
            dir: dir.to_string(),
            paths,
            paths_dir,
            base_url: self.base_url,
            include: self.include,
            files: self.files,
        }
    }
}

impl TsConfig {
    fn covers(&self, file: &str) -> bool {
        if self.files.as_ref().is_some_and(|f| f.iter().any(|f| f == file)) {
            return true;
        }
        match &self.include {
            Some(patterns) => patterns.iter().any(|p| glob_match(p, file)),
            None if self.files.is_some() => false,
            None => self.dir.is_empty() || file.starts_with(&format!("{}/", self.dir)),
        }
    }
}

/// A config's `include`/`files` as repo-relative patterns: a folder named alone covers
/// everything in it, as TypeScript reads it.
fn patterns(json: &Value, key: &str, dir: &str) -> Option<Vec<String>> {
    let list = json.get(key)?.as_array()?;
    Some(
        list.iter()
            .filter_map(Value::as_str)
            .filter_map(|p| {
                let joined = join(dir, p)?;
                let last = joined.rsplit('/').next().unwrap_or(&joined);
                let plain = !joined.contains('*') && !last.contains('.');
                Some(if key == "include" && plain {
                    if joined.is_empty() {
                        "**/*".to_string()
                    } else {
                        format!("{joined}/**/*")
                    }
                } else {
                    joined
                })
            })
            .collect(),
    )
}

/// The targets `exports` gives `sub` (`.` or `./x`), most source-like condition first.
fn export_targets(exports: &Value, sub: &str) -> Vec<String> {
    match exports {
        Value::Object(map) if map.keys().any(|k| k.starts_with('.')) => subpath_targets(map, sub),
        other if sub == "." => condition_targets(other, ""),
        _ => Vec::new(),
    }
}

/// A subpath map's (`exports`' or `imports'`) targets for `key`: the exact entry, else the
/// pattern with the longest prefix, its `*` filled in.
fn subpath_targets(map: &serde_json::Map<String, Value>, key: &str) -> Vec<String> {
    if let Some(v) = map.get(key) {
        return condition_targets(v, "");
    }
    let mut best: Option<(&Value, &str)> = None;
    let mut best_len = 0;
    for (pattern, value) in map {
        if let Some((prefix, suffix)) = pattern.split_once('*') {
            if key.len() >= prefix.len() + suffix.len()
                && key.starts_with(prefix)
                && key.ends_with(suffix)
                && (best.is_none() || prefix.len() > best_len)
            {
                best_len = prefix.len();
                best = Some((value, &key[prefix.len()..key.len() - suffix.len()]));
            }
        }
    }
    best.map(|(value, star)| condition_targets(value, star))
        .unwrap_or_default()
}

fn condition_targets(value: &Value, star: &str) -> Vec<String> {
    match value {
        Value::String(s) => vec![s.replace('*', star)],
        Value::Array(list) => list.iter().flat_map(|v| condition_targets(v, star)).collect(),
        Value::Object(map) => {
            let mut out: Vec<String> = CONDITIONS
                .iter()
                .filter_map(|c| map.get(*c))
                .flat_map(|v| condition_targets(v, star))
                .collect();
            // Conditions we don't rank still beat nothing.
            for (k, v) in map {
                if !CONDITIONS.contains(&k.as_str()) {
                    out.extend(condition_targets(v, star));
                }
            }
            out
        }
        _ => Vec::new(),
    }
}

/// `@scope/name/sub/path` → (`@scope/name`, `./sub/path`); `name` → (`name`, `.`).
pub fn split_package(spec: &str) -> (&str, String) {
    let mut parts = spec.splitn(if spec.starts_with('@') { 3 } else { 2 }, '/');
    let first = parts.next().unwrap_or("");
    let name_len = if spec.starts_with('@') {
        first.len() + parts.next().map_or(0, |s| s.len() + 1)
    } else {
        first.len()
    };
    let name = &spec[..name_len.min(spec.len())];
    let rest = &spec[name.len()..];
    let sub = if rest.is_empty() {
        ".".to_string()
    } else {
        format!(".{rest}")
    };
    (name, sub)
}

/// Whether `name` could be an npm package's name.
pub fn is_package_name(name: &str) -> bool {
    let ok = |s: &str| {
        !s.is_empty()
            && !s.starts_with('.')
            && !s.starts_with('_')
            && s.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "-._~".contains(c))
    };
    match name.strip_prefix('@') {
        Some(scoped) => scoped.split_once('/').is_some_and(|(s, n)| ok(s) && ok(n)),
        None => ok(name),
    }
}

/// Whether the file `rel` sits under the folder `dir` (`""` holds everything).
fn within(rel: &str, dir: &str) -> bool {
    dir.is_empty() || rel.starts_with(&format!("{dir}/"))
}

/// `a/b/c.ts` → `a/b`; a top-level file → `""`.
pub fn parent(rel: &str) -> &str {
    rel.rfind('/').map_or("", |i| &rel[..i])
}

pub fn file_name(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// `rel` from the folder `base`, `.` and `..` worked out. `None` when it climbs out of
/// the repository.
pub fn join(base: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = if rel.starts_with('/') {
        Vec::new()
    } else {
        base.split('/').filter(|s| !s.is_empty()).collect()
    };
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(files: &[(&str, &str)]) -> Project {
        let map: HashMap<String, String> =
            files.iter().map(|(p, t)| (p.to_string(), t.to_string())).collect();
        let paths: Vec<String> = files.iter().map(|(p, _)| p.to_string()).collect();
        Project::load(&paths, &|p| map.get(p).cloned())
    }

    fn file(path: &str) -> ModuleRes {
        ModuleRes::File(path.to_string())
    }

    #[test]
    fn relative_specifiers_probe_like_typescript() {
        let p = project(&[
            ("src/a.ts", ""),
            ("src/b.tsx", ""),
            ("src/util/index.ts", ""),
            ("src/esm.ts", ""),
            ("src/Button.vue", ""),
            ("src/data.json", ""),
            ("src/foo.service.ts", ""),
            ("src/types.d.ts", ""),
        ]);
        assert_eq!(p.resolve("src/main.ts", "./a"), file("src/a.ts"));
        assert_eq!(p.resolve("src/main.ts", "./b"), file("src/b.tsx"));
        assert_eq!(p.resolve("src/main.ts", "./util"), file("src/util/index.ts"));
        assert_eq!(p.resolve("src/x/y.ts", "../esm.js"), file("src/esm.ts"));
        assert_eq!(p.resolve("src/main.ts", "./Button.vue"), file("src/Button.vue"));
        assert_eq!(p.resolve("src/main.ts", "./data.json"), file("src/data.json"));
        assert_eq!(p.resolve("src/main.ts", "./foo.service"), file("src/foo.service.ts"));
        assert_eq!(p.resolve("src/main.ts", "./types"), file("src/types.d.ts"));
        assert_eq!(p.resolve("src/main.ts", "./a?raw"), file("src/a.ts"));
        assert_eq!(p.resolve("src/main.ts", "./missing"), ModuleRes::Unresolved);
        assert_eq!(p.resolve("src/main.ts", "../../../escape"), ModuleRes::Unresolved);
    }

    #[test]
    fn tsconfig_paths_and_base_url_follow_extends_and_solution_configs() {
        let p = project(&[
            ("tsconfig.json", r#"{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }"#),
            (
                "tsconfig.app.json",
                r#"{ // Vite's app config
                  "extends": "./tsconfig.base.json",
                  "include": ["src"],
                }"#,
            ),
            (
                "tsconfig.base.json",
                r#"{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "@lib": ["src/lib/index.ts"], "@deep/*": ["src/a/*", "src/b/*"] } } }"#,
            ),
            ("src/components/Card.tsx", ""),
            ("src/lib/index.ts", ""),
            ("src/b/x.ts", ""),
            ("src/models/user.ts", ""),
        ]);
        assert_eq!(p.resolve("src/main.ts", "@/components/Card"), file("src/components/Card.tsx"));
        assert_eq!(p.resolve("src/main.ts", "@lib"), file("src/lib/index.ts"));
        assert_eq!(p.resolve("src/main.ts", "@deep/x"), file("src/b/x.ts"), "later targets too");
        assert_eq!(p.resolve("src/main.ts", "src/models/user"), file("src/models/user.ts"), "baseUrl");
    }

    #[test]
    fn nearest_config_wins_in_a_monorepo() {
        let p = project(&[
            ("tsconfig.json", r#"{ "compilerOptions": { "paths": { "~/*": ["./shared/*"] } } }"#),
            ("apps/web/tsconfig.json", r#"{ "compilerOptions": { "paths": { "~/*": ["./app/*"] } } }"#),
            ("apps/web/app/root.tsx", ""),
            ("shared/root.ts", ""),
        ]);
        assert_eq!(p.resolve("apps/web/app/routes/x.tsx", "~/root"), file("apps/web/app/root.tsx"));
        assert_eq!(p.resolve("tools/x.ts", "~/root"), file("shared/root.ts"));
    }

    #[test]
    fn workspace_packages_resolve_into_their_sources() {
        let p = project(&[
            ("package.json", r#"{ "name": "root", "workspaces": ["packages/*"], "devDependencies": { "vitest": "1" } }"#),
            (
                "packages/ui/package.json",
                r#"{ "name": "@acme/ui", "main": "dist/index.js", "dependencies": { "react": "18" } }"#,
            ),
            ("packages/ui/src/index.ts", ""),
            ("packages/ui/src/button.tsx", ""),
            (
                "packages/core/package.json",
                r#"{ "name": "@acme/core", "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.mjs" }, "./utils/*": "./dist/utils/*.js" } }"#,
            ),
            ("packages/core/src/index.ts", ""),
            ("packages/core/src/utils/date.ts", ""),
            ("packages/app/package.json", r##"{ "name": "app", "imports": { "#db": "./src/db/index.ts", "#lib/*": "./src/lib/*" } }"##),
            ("packages/app/src/db/index.ts", ""),
            ("packages/app/src/lib/log.ts", ""),
        ]);
        let from = "packages/app/src/main.ts";
        assert_eq!(p.resolve(from, "@acme/ui"), file("packages/ui/src/index.ts"));
        assert_eq!(p.resolve(from, "@acme/ui/button"), file("packages/ui/src/button.tsx"));
        assert_eq!(p.resolve(from, "@acme/core"), file("packages/core/src/index.ts"));
        assert_eq!(p.resolve(from, "@acme/core/utils/date"), file("packages/core/src/utils/date.ts"));
        assert_eq!(p.resolve(from, "#db"), file("packages/app/src/db/index.ts"));
        assert_eq!(p.resolve(from, "#lib/log"), file("packages/app/src/lib/log.ts"));
        assert_eq!(p.resolve(from, "react"), ModuleRes::External);
        assert_eq!(p.resolve(from, "react-dom/client"), ModuleRes::External, "undeclared, package-shaped");
        assert_eq!(p.resolve(from, "vitest"), ModuleRes::External);
        assert_eq!(p.resolve(from, "node:fs"), ModuleRes::External);
        assert_eq!(p.resolve(from, "path"), ModuleRes::External);
        assert_eq!(p.resolve(from, "virtual:pwa-register"), ModuleRes::External);
        assert_eq!(p.resolve(from, "@/thing"), ModuleRes::Unresolved, "an alias nobody declared");
        assert_eq!(p.resolve(from, "$lib/x"), ModuleRes::Unresolved);
    }

    #[test]
    fn nearest_package_of_a_name_and_build_output() {
        let p = project(&[
            ("templates/a/packages/ui/package.json", r#"{ "name": "@ws/ui", "exports": { "./*": "./src/*.tsx" } }"#),
            ("templates/a/packages/ui/src/button.tsx", ""),
            ("templates/b/packages/ui/package.json", r#"{ "name": "@ws/ui", "exports": { "./*": "./src/*.tsx" } }"#),
            ("templates/b/packages/ui/src/button.tsx", ""),
            ("packages/core/package.json", r#"{ "name": "core", "main": "index.js" }"#),
            ("packages/core/index.js", ""),
            ("packages/core/src/index.ts", ""),
            ("web/public/logo.svg", ""),
            ("web/package.json", "{}"),
        ]);
        assert_eq!(p.resolve("templates/b/apps/web/page.tsx", "@ws/ui/button"), file("templates/b/packages/ui/src/button.tsx"));
        assert_eq!(p.resolve("templates/a/apps/web/page.tsx", "@ws/ui/button"), file("templates/a/packages/ui/src/button.tsx"));
        assert_eq!(p.resolve("packages/core/bench/x.ts", "../dist/core.esm.prod"), file("packages/core/index.js"));
        assert_eq!(p.resolve("web/src/App.tsx", "/logo.svg"), file("web/public/logo.svg"));
    }

    #[test]
    fn folders_named_like_packages_are_aliases_not_packages() {
        let p = project(&[("src/components/a.ts", ""), ("package.json", "{}")]);
        assert_eq!(p.resolve("src/main.ts", "components/a"), ModuleRes::Unresolved);
        assert_eq!(p.resolve("src/main.ts", "lodash"), ModuleRes::External);
    }

    #[test]
    fn aliases_from_bundler_config() {
        let mut p = project(&[("web/src/a/b.ts", ""), ("web/src/index.ts", "")]);
        p.add_alias(Alias { scope: "web".into(), find: "@".into(), replacement: "web/src".into() });
        assert_eq!(p.resolve("web/src/x.ts", "@/a/b"), file("web/src/a/b.ts"));
        assert_eq!(p.resolve("web/src/x.ts", "@"), file("web/src/index.ts"));
        assert_eq!(p.resolve("web/src/x.ts", "@vue/shared"), ModuleRes::External, "not `@` + `/`");
        assert_eq!(p.resolve("other/x.ts", "@/a/b"), ModuleRes::Unresolved, "outside its scope");
    }

    #[test]
    fn splits_package_names() {
        assert_eq!(split_package("react"), ("react", ".".to_string()));
        assert_eq!(split_package("react-dom/client"), ("react-dom", "./client".to_string()));
        assert_eq!(split_package("@acme/ui"), ("@acme/ui", ".".to_string()));
        assert_eq!(split_package("@acme/ui/x/y"), ("@acme/ui", "./x/y".to_string()));
        assert!(is_package_name("@tanstack/react-query"));
        assert!(!is_package_name("@/components"));
        assert!(!is_package_name("~/x"));
        assert!(!is_package_name("$lib"));
    }
}
