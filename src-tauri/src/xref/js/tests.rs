use std::fs;
use std::sync::MutexGuard;

use git2::Repository;

use super::*;
use crate::xref::TEST_LOCK;

/// A repo of `files`, indexed. Keep the tempdir and the guard alive.
pub(crate) struct Fixture {
    pub dir: tempfile::TempDir,
    pub repo: Repository,
    pub rels: Vec<String>,
    _guard: MutexGuard<'static, ()>,
}

pub(crate) fn fixture(files: &[(&str, &str)]) -> Fixture {
    let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let mut rels = Vec::new();
    for (name, body) in files {
        let path = dir.path().join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, body).unwrap();
        rels.push(name.to_string());
    }
    rels.sort();
    let repo = Repository::init(dir.path()).unwrap();
    build_index(&repo, dir.path(), &ProjectSource::Worktree, &rels).unwrap();
    Fixture { dir, repo, rels, _guard: guard }
}

impl Fixture {
    fn text(&self, rel: &str) -> String {
        fs::read_to_string(self.dir.path().join(rel)).unwrap()
    }

    /// The viewer position of the `nth` occurrence of `needle` in `rel`, `offset` bytes in.
    pub fn at(&self, rel: &str, needle: &str, nth: usize, offset: usize) -> (u32, u32) {
        let text = self.text(rel);
        let byte = text
            .match_indices(needle)
            .nth(nth)
            .unwrap_or_else(|| panic!("{needle:?} #{nth} not in {rel}"))
            .0;
        position(&text, byte + offset)
    }

    pub fn symbol(&self, rel: &str, needle: &str, nth: usize, offset: usize) -> SymbolRef {
        let (line, col) = self.at(rel, needle, nth, offset);
        symbol_at(&self.repo, self.dir.path(), &ProjectSource::Worktree, rel, line, col)
            .unwrap()
            .unwrap_or_else(|| panic!("no symbol at {needle:?} in {rel}"))
    }

    /// Where the symbol at `needle` (its first character) is defined: `file:line`.
    pub fn def(&self, rel: &str, needle: &str) -> Vec<String> {
        self.def_nth(rel, needle, 0, 0)
    }

    pub fn def_nth(&self, rel: &str, needle: &str, nth: usize, offset: usize) -> Vec<String> {
        let symbol = self.symbol(rel, needle, nth, offset);
        find_definition(&self.repo, self.dir.path(), &ProjectSource::Worktree, &self.rels, &symbol)
            .unwrap()
            .into_iter()
            .map(|r| format!("{}:{}", r.file, r.line))
            .collect()
    }

    /// References to the symbol at `needle`: confirmed `file:line`s, then unconfirmed.
    pub fn refs(&self, rel: &str, needle: &str, nth: usize) -> (Vec<String>, Vec<String>) {
        let symbol = self.symbol(rel, needle, nth, 0);
        let found =
            find_references(&self.repo, self.dir.path(), &ProjectSource::Worktree, &self.rels, &symbol).unwrap();
        let mut confirmed: Vec<String> = found.iter().filter(|r| r.confirmed).map(|r| format!("{}:{}", r.file, r.line)).collect();
        let mut unconfirmed: Vec<String> = found.iter().filter(|r| !r.confirmed).map(|r| format!("{}:{}", r.file, r.line)).collect();
        confirmed.sort();
        unconfirmed.sort();
        (confirmed, unconfirmed)
    }

    pub fn occurrences(&self, rel: &str, needle: &str, nth: usize) -> Vec<(u32, u32)> {
        let (line, col) = self.at(rel, needle, nth, 0);
        occurrences(self.dir.path(), &ProjectSource::Worktree, rel, line, col)
            .unwrap()
            .expect("indexed")
            .spans
            .iter()
            .map(|s| (s.line, s.col))
            .collect()
    }
}

fn s(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

#[test]
fn imports_through_aliases_and_barrels() {
    let f = fixture(&[
        ("tsconfig.json", r#"{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }"#),
        ("src/lib/greet.ts", "export function greet(name: string) {\n  return `hi ${name}`;\n}\n"),
        ("src/lib/index.ts", "export * from './greet';\nexport { default as Button } from './Button';\n"),
        ("src/lib/Button.tsx", "export default function Button({ label }: { label: string }) {\n  return <button>{label}</button>;\n}\n"),
        (
            "src/app.tsx",
            "import { greet, Button } from '@/lib';\nimport { greet as hello } from '@/lib/greet';\n\nexport const App = () => <Button label={greet('a')} />;\nhello('b');\n",
        ),
    ]);
    assert_eq!(f.def("src/app.tsx", "greet('a')"), s(&["src/lib/greet.ts:1"]));
    assert_eq!(f.def("src/app.tsx", "Button label"), s(&["src/lib/Button.tsx:1"]));
    assert_eq!(f.def("src/app.tsx", "hello('b')"), s(&["src/lib/greet.ts:1"]));
    assert_eq!(f.def("src/app.tsx", "label="), s(&["src/lib/Button.tsx:1"]), "a prop: the destructured parameter");
    // The module itself, from its specifier.
    assert_eq!(f.def_nth("src/app.tsx", "@/lib/greet", 0, 1), s(&["src/lib/greet.ts:1"]));

    // References find the aliased import too: `greet as hello` names it twice on line 2.
    let (confirmed, unconfirmed) = f.refs("src/lib/greet.ts", "greet(name", 0);
    assert_eq!(
        confirmed,
        s(&["src/app.tsx:1", "src/app.tsx:2", "src/app.tsx:2", "src/app.tsx:4", "src/app.tsx:5", "src/lib/greet.ts:1"])
    );
    assert!(unconfirmed.is_empty(), "{unconfirmed:?}");
}

#[test]
fn members_follow_declared_types() {
    let f = fixture(&[
        ("src/repo.ts", "export class Repo {\n  find(id: string): User { return null!; }\n}\nexport interface User {\n  name: string;\n  pets: Pet[];\n}\ninterface Pet { name: string }\n"),
        (
            "src/service.ts",
            "import { Repo, User } from './repo';\n\nexport class UserService {\n  constructor(private readonly repo: Repo) {}\n  load(id: string) {\n    return this.repo.find(id).name;\n  }\n}\n\nexport function rename(u: User | null) {\n  return u!.name;\n}\n",
        ),
        ("src/main.ts", "import { UserService } from './service';\nconst svc = new UserService(null as any);\nsvc.load('1');\nconst list = [1];\nlist.map((x) => x);\n"),
    ]);
    assert_eq!(f.def("src/service.ts", "repo.find"), s(&["src/service.ts:4"]), "a parameter property");
    assert_eq!(f.def("src/service.ts", "find(id)"), s(&["src/repo.ts:2"]));
    assert_eq!(f.def_nth("src/service.ts", ".name;\n  }", 0, 1), s(&["src/repo.ts:5"]), "through the return type");
    assert_eq!(f.def_nth("src/service.ts", "name;\n}", 0, 0), s(&["src/repo.ts:5"]), "through `User | null`");
    assert_eq!(f.def("src/main.ts", "load('1')"), s(&["src/service.ts:5"]));
    assert!(f.def("src/main.ts", "map(").is_empty(), "an array's: the runtime's");
}

#[test]
fn same_named_members_stay_apart() {
    let f = fixture(&[
        ("src/animals.ts", "export class Dog {\n  speak() {}\n}\nexport class Cat {\n  speak() {}\n}\n"),
        (
            "src/main.ts",
            "import { Dog, Cat } from './animals';\nconst d = new Dog();\nconst c: Cat = new Cat();\nd.speak();\nc.speak();\nconst x = make();\nx.speak();\n",
        ),
    ]);
    assert_eq!(f.def("src/main.ts", "speak();\nc"), s(&["src/animals.ts:2"]));
    assert_eq!(f.def("src/main.ts", "speak();\nconst x"), s(&["src/animals.ts:5"]));
    // `make()` declares no type: a name match, both candidates.
    assert_eq!(f.def_nth("src/main.ts", "speak", 2, 0), s(&["src/animals.ts:2", "src/animals.ts:5"]));

    let (confirmed, unconfirmed) = f.refs("src/animals.ts", "speak", 0);
    assert_eq!(confirmed, s(&["src/animals.ts:2", "src/main.ts:4"]));
    assert_eq!(unconfirmed, s(&["src/main.ts:7"]), "undecidable stays, Cat's is dropped");
}

#[test]
fn locals_shadow_and_types_live_apart_from_values() {
    let f = fixture(&[
        (
            "src/a.ts",
            "export interface Props { size: number }\nexport const Props = { size: 1 };\nlet p: Props;\nconst q = Props.size;\nfunction g(Props: number) { return Props; }\n",
        ),
    ]);
    assert_eq!(f.def_nth("src/a.ts", "Props", 2, 0), s(&["src/a.ts:1"]), "a type use");
    assert_eq!(f.def_nth("src/a.ts", "Props", 3, 0), s(&["src/a.ts:2"]), "a value use");
    assert_eq!(f.def_nth("src/a.ts", "size", 2, 0), s(&["src/a.ts:2"]), "the object's key");
    assert_eq!(f.def_nth("src/a.ts", "Props", 5, 0), s(&["src/a.ts:5"]), "the parameter shadows");
}

#[test]
fn commonjs_modules() {
    let f = fixture(&[
        ("lib/util.js", "function helper() {}\nfunction other() {}\nmodule.exports = { helper, other };\n"),
        ("lib/config.js", "exports.port = 8080;\n"),
        (
            "index.js",
            "const { helper } = require('./lib/util');\nconst util = require('./lib/util');\nconst config = require('./lib/config');\nhelper();\nutil.other();\nconsole.log(config.port);\n",
        ),
    ]);
    assert_eq!(f.def("index.js", "helper();"), s(&["lib/util.js:1"]));
    assert_eq!(f.def("index.js", "other();"), s(&["lib/util.js:2"]));
    assert_eq!(f.def("index.js", "port)"), s(&["lib/config.js:1"]));
    assert!(f.def("index.js", "log(").is_empty(), "console is the runtime's");
}

#[test]
fn packages_globals_and_the_outside_world() {
    let f = fixture(&[
        ("package.json", r#"{ "name": "root", "dependencies": { "react": "18" } }"#),
        ("packages/ui/package.json", r#"{ "name": "@acme/ui", "main": "dist/index.js" }"#),
        ("packages/ui/src/index.ts", "export const theme = { dark: true };\n"),
        ("src/env.d.ts", "export {};\ndeclare global {\n  const __APP_VERSION__: string;\n}\n"),
        ("src/legacy.js", "function legacyHelper() {}\n"),
        (
            "src/main.tsx",
            "import { useState } from 'react';\nimport { theme } from '@acme/ui';\nconst [n] = useState(0);\nconsole.log(theme.dark, __APP_VERSION__);\nlegacyHelper();\nconst el = <div />;\n",
        ),
    ]);
    assert_eq!(f.def("src/main.tsx", "theme.dark"), s(&["packages/ui/src/index.ts:1"]));
    assert_eq!(f.def("src/main.tsx", "dark,"), s(&["packages/ui/src/index.ts:1"]));
    assert_eq!(f.def("src/main.tsx", "__APP_VERSION__);"), s(&["src/env.d.ts:3"]));
    assert_eq!(f.def("src/main.tsx", "legacyHelper();"), s(&["src/legacy.js:1"]), "a script's top level is global");
    assert!(f.def("src/main.tsx", "useState(0)").is_empty(), "react's");
    assert!(f.def("src/main.tsx", "div").is_empty(), "an intrinsic element");
}

#[test]
fn references_to_a_module_are_its_imports() {
    let f = fixture(&[
        ("src/components/Card.tsx", "export default function Card() { return null; }\n"),
        ("src/pages/a.tsx", "import Card from '../components/Card';\nexport const A = () => <Card />;\n"),
        ("src/pages/b.tsx", "import Tile from '../components/Card';\nexport const B = () => <Tile />;\n"),
    ]);
    // The default export, imported under two names.
    let (confirmed, _) = f.refs("src/components/Card.tsx", "Card", 0);
    assert_eq!(
        confirmed,
        s(&["src/components/Card.tsx:1", "src/pages/a.tsx:1", "src/pages/a.tsx:2", "src/pages/b.tsx:1", "src/pages/b.tsx:2"])
    );
}

#[test]
fn occurrences_keep_a_field_apart_from_a_same_named_local() {
    let f = fixture(&[(
        "src/item.ts",
        "export class Item {\n  name = '';\n  rename(to: string) {\n    this.name = to;\n  }\n  shadow() {\n    const name = 'x';\n    return name;\n  }\n}\n",
    )]);
    assert_eq!(f.occurrences("src/item.ts", "name =", 0), vec![(2, 2), (4, 9)]);
    assert_eq!(f.occurrences("src/item.ts", "name;", 0), vec![(7, 10), (8, 11)]);
}

#[test]
fn audit_sorts_imports_by_where_they_lead() {
    let f = fixture(&[
        ("package.json", r#"{ "dependencies": { "react": "18" } }"#),
        ("src/a.ts", "import x from './b';\nimport y from 'react';\nimport z from '@/missing/thing';\nimport w from './nope';\nconst q = require('@/missing/other');\n"),
        ("src/b.ts", "export default 1;\n"),
    ]);
    let report = audit(&f.repo, f.dir.path(), &ProjectSource::Worktree, &f.rels).unwrap();
    assert_eq!((report.imports, report.resolved, report.external), (5, 1, 1));
    assert_eq!(report.unresolved.len(), 3);
    assert_eq!(report.patterns, vec![("@/…".to_string(), 2), ("./…".to_string(), 1)]);
}

/// Audit a real checkout: `REVIEW_ME_AUDIT=/path/to/repo cargo test audit_from_env -- --ignored --nocapture`.
#[test]
#[ignore]
fn audit_from_env() {
    let Ok(path) = std::env::var("REVIEW_ME_AUDIT") else {
        eprintln!("set REVIEW_ME_AUDIT to a repository to audit");
        return;
    };
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo = Repository::open(&path).unwrap();
    let root = crate::repo::root(&repo).unwrap();
    let files = crate::fuzzy::repo_files(&repo, &ProjectSource::Worktree).unwrap();
    let started = std::time::Instant::now();
    let report = audit(&repo, &root, &ProjectSource::Worktree, &files).unwrap();
    eprintln!(
        "{} files, {} imports: {} in the project, {} external, {} unresolved ({:?})",
        report.files,
        report.imports,
        report.resolved,
        report.external,
        report.unresolved.len(),
        started.elapsed()
    );
    for (pattern, n) in report.patterns.iter().take(20) {
        eprintln!("  {n:5}  {pattern}");
    }
    for r in report.unresolved.iter().filter(|r| std::env::var("REVIEW_ME_AUDIT_GREP").map_or(true, |g| r.snippet.contains(&g))).take(40) {
        eprintln!("  {}:{}  {}", r.file, r.line, r.snippet);
    }
}

/// Resolve every name in a real checkout and tally the answers, with samples of the
/// undecided ones — how to find what the resolver doesn't model yet:
/// `REVIEW_ME_AUDIT=/path/to/repo cargo test audit_names_from_env -- --ignored --nocapture`.
#[test]
#[ignore]
fn audit_names_from_env() {
    let Ok(path) = std::env::var("REVIEW_ME_AUDIT") else {
        eprintln!("set REVIEW_ME_AUDIT to a repository to audit");
        return;
    };
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo = Repository::open(&path).unwrap();
    let root = crate::repo::root(&repo).unwrap();
    let files = crate::fuzzy::repo_files(&repo, &ProjectSource::Worktree).unwrap();
    let index = JsIndex::build(&repo, &root, &ProjectSource::Worktree, &files).unwrap();
    let mut tally: HashMap<(String, &str), u32> = HashMap::new();
    let mut samples: Vec<String> = Vec::new();
    let started = std::time::Instant::now();
    for fi in 0..index.files.len() {
        let Some(parsed) = index.parsed(fi) else { continue };
        let code = index.code(fi);
        walk(parsed.tree.root_node(), &mut |n| {
            if !NAME_KINDS.contains(&n.kind()) || is_declaration_name(n) {
                return;
            }
            let ctx = n.parent().map(|p| p.kind()).unwrap_or("");
            let what = match index.resolve(fi, n) {
                Resolution::Found(_) => "found",
                Resolution::Ambiguous(_) => "ambiguous",
                Resolution::External => "external",
                Resolution::Unresolved => {
                    if samples.len() < 60 && fi % std::env::var("REVIEW_ME_AUDIT_EVERY").ok().and_then(|v| v.parse().ok()).unwrap_or(7) == 0 {
                        let (line, _) = position(&index.files[fi].source, n.start_byte());
                        samples.push(format!("{}:{} [{}] {} | {}", index.files[fi].rel, line, ctx, text(n, code), line_text(&index.files[fi].source, line as usize - 1)));
                    }
                    "unresolved"
                }
            };
            *tally.entry((ctx.to_string(), what)).or_default() += 1;
        });
    }
    let mut by_ctx: HashMap<String, [u32; 4]> = HashMap::new();
    for ((ctx, what), n) in &tally {
        let slot = match *what { "found" => 0, "ambiguous" => 1, "external" => 2, _ => 3 };
        by_ctx.entry(ctx.clone()).or_default()[slot] += n;
    }
    let mut rows: Vec<_> = by_ctx.into_iter().collect();
    rows.sort_by_key(|(_, c)| std::cmp::Reverse(c[3]));
    let total: [u32; 4] = rows.iter().fold([0; 4], |mut acc, (_, c)| { for i in 0..4 { acc[i] += c[i]; } acc });
    eprintln!("names in {:?}: found {} ambiguous {} external {} unresolved {}", started.elapsed(), total[0], total[1], total[2], total[3]);
    for (ctx, c) in rows.iter().take(15) {
        eprintln!("  {:>28}  found {:6} amb {:5} ext {:6} unres {:6}", ctx, c[0], c[1], c[2], c[3]);
    }
    for s in &samples {
        eprintln!("  {s}");
    }
}

#[test]
fn types_flow_through_destructuring_arrays_and_well_known_calls() {
    let f = fixture(&[
        ("src/model.ts", "export interface Commit {\n  subject: string;\n  author: Person;\n}\nexport interface Person {\n  name: string;\n}\nexport interface Props {\n  commits: Commit[];\n  pinned: Array<Commit>;\n}\n"),
        (
            "src/view.tsx",
            "import { useState, useRef } from 'react';\nimport type { Commit, Props } from './model';\n\nexport function View({ commits, pinned: [top] }: Props) {\n  const [current] = useState<Commit | null>(null);\n  const box = useRef<Commit>(null);\n  for (const c of commits) {\n    c.author.name;\n  }\n  commits.map((c) => c.subject);\n  commits.filter(({ author }) => author.name);\n  return [top.subject, current!.subject, box.current!.author, commits[0].subject];\n}\n",
        ),
        ("src/store.ts", "import { ref, computed } from 'vue';\nimport type { Person } from './model';\nconst me = ref<Person>();\nconst label = computed(() => me.value!.name);\nme.value!.name;\n"),
    ]);
    assert_eq!(f.def_nth("src/view.tsx", "name;\n  }", 0, 0), s(&["src/model.ts:6"]), "for-of, then a member's type");
    assert_eq!(f.def_nth("src/view.tsx", "subject);", 0, 0), s(&["src/model.ts:2"]), "a map callback");
    assert_eq!(f.def_nth("src/view.tsx", "name);", 0, 0), s(&["src/model.ts:6"]), "a destructured callback parameter");
    assert_eq!(f.def_nth("src/view.tsx", "subject, current", 0, 0), s(&["src/model.ts:2"]), "an array pattern in a typed parameter");
    assert_eq!(f.def_nth("src/view.tsx", "subject, box", 0, 0), s(&["src/model.ts:2"]), "useState's first element");
    assert_eq!(f.def_nth("src/view.tsx", "author, commits", 0, 0), s(&["src/model.ts:3"]), "useRef's current");
    assert_eq!(f.def_nth("src/view.tsx", "subject];", 0, 0), s(&["src/model.ts:2"]), "an index");
    assert_eq!(f.def_nth("src/store.ts", "name;\n", 0, 0), s(&["src/model.ts:6"]), "a ref's value");
}

#[test]
fn store_selectors_read_the_store_state() {
    let f = fixture(&[
        ("src/store.ts", "import { create } from 'zustand';\nexport interface UIState {\n  picker: string | null;\n  open: (p: string) => void;\n}\nexport const useUI = create<UIState>()((set) => ({\n  picker: null,\n  open: (p) => set({ picker: p }),\n}));\n"),
        ("src/view.tsx", "import { useUI } from './store';\nconst picker = useUI((s) => s.picker);\nconst state = useUI();\nstate.open('x');\nconst el = <input onKeyDown={(e) => e.key} />;\n"),
    ]);
    assert_eq!(f.def_nth("src/view.tsx", "picker);", 0, 0), s(&["src/store.ts:3"]));
    assert_eq!(f.def_nth("src/view.tsx", "open('x')", 0, 0), s(&["src/store.ts:4"]));
    assert!(f.def_nth("src/view.tsx", "key}", 0, 0).is_empty(), "a DOM event's member is the runtime's");
}

#[test]
fn vue_components_resolve_their_templates() {
    let f = fixture(&[
        ("package.json", r#"{ "dependencies": { "vue": "3" } }"#),
        ("src/components/TodoItem.vue", "<template><li>{{ todo.title }}</li></template>\n<script setup lang=\"ts\">\nimport type { Todo } from '../types'\nconst props = defineProps<{ todo: Todo; done?: boolean }>()\n</script>\n"),
        ("src/types.ts", "export interface Todo {\n  id: number;\n  title: string;\n}\n"),
        (
            "src/App.vue",
            "<template>\n  <ul>\n    <todo-item v-for=\"t in todos\" :key=\"t.id\" :todo=\"t\" @click=\"remove(t)\" />\n  </ul>\n  <p>{{ count }} {{ todos.length }}</p>\n</template>\n\n<script setup lang=\"ts\">\nimport { ref } from 'vue'\nimport TodoItem from './components/TodoItem.vue'\nimport type { Todo } from './types'\nconst todos = ref<Todo[]>([])\nconst count = ref(0)\nfunction remove(t: Todo) {}\n</script>\n",
        ),
        (
            "src/Legacy.vue",
            "<template><div @click=\"bump\">{{ total }} {{ label }}</div></template>\n<script>\nexport default {\n  props: ['label'],\n  data() {\n    return { total: 0 }\n  },\n  methods: {\n    bump() { this.total++ }\n  },\n}\n</script>\n",
        ),
    ]);
    assert_eq!(f.def("src/App.vue", "todo-item"), s(&["src/components/TodoItem.vue:1"]), "a kebab-case tag");
    assert_eq!(f.def("src/App.vue", "todos\" :key"), s(&["src/App.vue:12"]), "into the script");
    assert_eq!(f.def_nth("src/App.vue", "t.id", 0, 2), s(&["src/types.ts:2"]), "a v-for alias's member");
    assert_eq!(f.def_nth("src/App.vue", "t)", 0, 0), s(&["src/App.vue:3"]), "the v-for alias");
    assert_eq!(f.def("src/App.vue", "remove(t)"), s(&["src/App.vue:14"]));
    assert_eq!(f.def("src/App.vue", "count }}"), s(&["src/App.vue:13"]));
    assert_eq!(f.def_nth("src/components/TodoItem.vue", "todo.title", 0, 0), s(&["src/components/TodoItem.vue:4"]), "a prop");
    assert_eq!(f.def_nth("src/components/TodoItem.vue", "title }}", 0, 0), s(&["src/types.ts:3"]), "a prop's member");
    assert_eq!(f.def("src/Legacy.vue", "bump\""), s(&["src/Legacy.vue:9"]), "options API: methods");
    assert_eq!(f.def("src/Legacy.vue", "total }}"), s(&["src/Legacy.vue:6"]), "options API: data");
    assert_eq!(f.def("src/Legacy.vue", "label }}"), s(&["src/Legacy.vue:4"]), "options API: props");

    // The component's uses: its import (the name and the path) and its kebab-case tag.
    let (confirmed, _) = f.refs("src/App.vue", "TodoItem from", 0);
    assert_eq!(confirmed, s(&["src/App.vue:10", "src/App.vue:10", "src/App.vue:3"]));
}

#[test]
fn svelte_and_astro_components() {
    let f = fixture(&[
        ("src/lib/stores.ts", "import { writable } from 'svelte/store';\nexport const count = writable(0);\n"),
        ("src/lib/Row.svelte", "<script lang=\"ts\">\n  export let item: { name: string };\n</script>\n<li>{item.name}</li>\n"),
        (
            "src/routes/+page.svelte",
            "<script lang=\"ts\">\n  import Row from '$lib/Row.svelte';\n  import { count } from '$lib/stores';\n  let items = [{ name: 'a' }];\n</script>\n\n{#each items as item}\n  <Row {item} />\n{/each}\n<p>{$count}</p>\n",
        ),
        ("svelte.config.js", "export default { kit: {} };\n"),
        ("src/components/Card.astro", "---\nconst { title } = Astro.props;\n---\n<h2>{title}</h2>\n"),
        ("src/pages/index.astro", "---\nimport Card from '../components/Card.astro';\nconst posts = [{ title: 'x' }];\n---\n<main>\n  {posts.map((p) => <Card title={p.title} />)}\n  <Card title=\"y\" />\n</main>\n"),
    ]);
    assert_eq!(f.def("src/routes/+page.svelte", "Row {item}"), s(&["src/lib/Row.svelte:1"]));
    assert_eq!(f.def_nth("src/routes/+page.svelte", "item} />", 0, 0), s(&["src/routes/+page.svelte:7"]), "the each binding");
    assert_eq!(f.def("src/routes/+page.svelte", "$count"), s(&["src/lib/stores.ts:2"]), "a store subscription");
    assert_eq!(f.def_nth("src/pages/index.astro", "Card title=\"y\"", 0, 0), s(&["src/components/Card.astro:1"]), "a tag");
    assert_eq!(f.def_nth("src/pages/index.astro", "Card title={", 0, 0), s(&["src/components/Card.astro:1"]), "JSX in an expression");
    assert_eq!(f.def_nth("src/pages/index.astro", "posts.map", 0, 0), s(&["src/pages/index.astro:3"]));
}

#[test]
fn nuxt_conventions() {
    let f = fixture(&[
        ("package.json", r#"{ "devDependencies": { "nuxt": "4" } }"#),
        ("nuxt.config.ts", "export default defineNuxtConfig({})\n"),
        ("app/app.vue", "<template><NuxtLayout><BaseButton /><LazyAppHeader /></NuxtLayout></template>\n"),
        ("app/components/base/BaseButton.vue", "<template><button /></template>\n"),
        ("app/components/AppHeader.vue", "<template><header>{{ user.name }}</header></template>\n<script setup lang=\"ts\">\nconst user = useUser()\nconst route = useRoute()\n</script>\n"),
        ("app/composables/useUser.ts", "export function useUser() {\n  return { name: 'x' }\n}\n"),
        ("app/pages/index.vue", "<script setup lang=\"ts\">\nimport { useUser } from '#imports'\nimport { BaseButton } from '#components'\nconst u = useUser()\n</script>\n"),
    ]);
    assert_eq!(f.def("app/app.vue", "BaseButton"), s(&["app/components/base/BaseButton.vue:1"]));
    assert_eq!(f.def("app/app.vue", "LazyAppHeader"), s(&["app/components/AppHeader.vue:1"]));
    assert!(f.def("app/app.vue", "NuxtLayout").is_empty(), "Nuxt's own");
    assert_eq!(f.def("app/components/AppHeader.vue", "useUser()"), s(&["app/composables/useUser.ts:1"]), "auto-imported");
    assert!(f.def("app/components/AppHeader.vue", "useRoute()").is_empty(), "Vue Router's");
    assert_eq!(f.def_nth("app/components/AppHeader.vue", "name }}", 0, 0), s(&["app/composables/useUser.ts:2"]));
    assert_eq!(f.def("app/pages/index.vue", "useUser()"), s(&["app/composables/useUser.ts:1"]), "#imports");
    assert_eq!(f.def("app/pages/index.vue", "BaseButton }"), s(&["app/components/base/BaseButton.vue:1"]), "#components");
}

#[test]
fn globally_registered_components() {
    let f = fixture(&[
        ("components.d.ts", "export {}\ndeclare module 'vue' {\n  export interface GlobalComponents {\n    AppIcon: typeof import('./src/components/AppIcon.vue')['default']\n  }\n}\n"),
        ("src/components/AppIcon.vue", "<template><i /></template>\n"),
        ("src/components/Panel.vue", "<template><section /></template>\n"),
        ("src/main.ts", "import { createApp } from 'vue';\nimport Panel from './components/Panel.vue';\ncreateApp({}).component('Panel', Panel);\n"),
        ("src/Page.vue", "<template><AppIcon /><Panel /></template>\n"),
    ]);
    assert_eq!(f.def("src/Page.vue", "AppIcon"), s(&["src/components/AppIcon.vue:1"]));
    assert_eq!(f.def("src/Page.vue", "Panel"), s(&["src/components/Panel.vue:1"]));
}
