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
    // Stylesheets: every token that isn't a definition.
    let mut styles: HashMap<String, [u32; 4]> = HashMap::new();
    let mut style_samples = Vec::new();
    let mut sheets: Vec<&String> = index.sheets.keys().collect();
    sheets.sort();
    for rel in sheets {
        let text = index.sheet_text(rel).unwrap();
        for t in &index.sheets[rel].tokens(text).tokens {
            if t.def {
                continue;
            }
            let slot = match index.resolve_style(rel, t, 0) {
                Resolution::Found(_) => 0,
                Resolution::Ambiguous(_) => 1,
                Resolution::External => 2,
                Resolution::Unresolved => {
                    if style_samples.len() < 20 {
                        let (line, _) = position(text, t.start);
                        style_samples.push(format!("{rel}:{line} [{:?}] {}", t.space, t.name));
                    }
                    3
                }
            };
            styles.entry(format!("{:?}", t.space)).or_default()[slot] += 1;
        }
    }
    for (space, c) in &styles {
        eprintln!("  style {space:>12}  found {:6} amb {:5} ext {:6} unres {:6}", c[0], c[1], c[2], c[3]);
    }
    for s in &style_samples {
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

#[test]
fn angular_templates_resolve_against_their_components() {
    let f = fixture(&[
        ("package.json", r#"{ "dependencies": { "@angular/core": "19" } }"#),
        ("src/app/hero.ts", "export interface Hero {\n  id: number;\n  name: string;\n}\n"),
        (
            "src/app/hero-detail.component.ts",
            "import { Component, Input, Output, EventEmitter } from '@angular/core';\nimport { Hero } from './hero';\n\n@Component({\n  selector: 'app-hero-detail',\n  templateUrl: './hero-detail.component.html',\n})\nexport class HeroDetailComponent {\n  @Input() hero?: Hero;\n  @Output() deleted = new EventEmitter<Hero>();\n  remove() {}\n}\n",
        ),
        ("src/app/hero-detail.component.html", "<h2>{{ hero?.name | titlecase }}</h2>\n<button (click)=\"remove()\">x</button>\n"),
        ("src/app/shout.pipe.ts", "import { Pipe } from '@angular/core';\n@Pipe({ name: 'shout' })\nexport class ShoutPipe {\n  transform(v: string) { return v; }\n}\n"),
        ("src/app/highlight.directive.ts", "import { Directive, Input } from '@angular/core';\n@Directive({ selector: '[appHighlight]' })\nexport class HighlightDirective {\n  @Input() appHighlight = '';\n}\n"),
        (
            "src/app/app.component.ts",
            "import { Component } from '@angular/core';\nimport { Hero } from './hero';\n\n@Component({\n  selector: 'app-root',\n  template: `\n    <app-hero-detail [hero]=\"selected\" (deleted)=\"onDeleted($event)\"></app-hero-detail>\n    <p [appHighlight]=\"color\">{{ title | shout }}</p>\n    @for (h of heroes; track h.id) {\n      <li>{{ h.name }}</li>\n    }\n  `,\n})\nexport class AppComponent {\n  title = 'Tour';\n  color = 'yellow';\n  heroes: Hero[] = [];\n  selected?: Hero;\n  onDeleted(h: Hero) {}\n}\n",
        ),
    ]);
    let html = "src/app/hero-detail.component.html";
    let app = "src/app/app.component.ts";
    assert_eq!(f.def_nth(html, "hero?.name", 0, 0), s(&["src/app/hero-detail.component.ts:9"]), "a component member");
    assert_eq!(f.def_nth(html, "name |", 0, 0), s(&["src/app/hero.ts:3"]), "through the member's type");
    assert!(f.def(html, "titlecase").is_empty(), "Angular's own pipe");
    assert_eq!(f.def(html, "remove()"), s(&["src/app/hero-detail.component.ts:11"]));
    assert_eq!(f.def(app, "app-hero-detail [hero]"), s(&["src/app/hero-detail.component.ts:8"]), "an element selector");
    assert_eq!(f.def_nth(app, "hero]", 0, 0), s(&["src/app/hero-detail.component.ts:9"]), "an input");
    assert_eq!(f.def_nth(app, "deleted)", 0, 0), s(&["src/app/hero-detail.component.ts:10"]), "an output");
    assert_eq!(f.def(app, "selected\""), s(&["src/app/app.component.ts:18"]), "inline: the component's member");
    assert_eq!(f.def(app, "onDeleted($event)"), s(&["src/app/app.component.ts:19"]));
    assert_eq!(f.def(app, "shout }}"), s(&["src/app/shout.pipe.ts:3"]), "a pipe");
    assert_eq!(f.def_nth(app, "appHighlight]", 0, 0), s(&["src/app/highlight.directive.ts:4"]), "a directive's input");
    assert_eq!(f.def_nth(app, "h.name", 0, 2), s(&["src/app/hero.ts:3"]), "a @for item's member");
    assert_eq!(f.def_nth("src/app/hero-detail.component.ts", "hero-detail.component.html", 0, 0), s(&["src/app/hero-detail.component.html:1"]), "templateUrl");

    // A member's uses in its template, and a component's by its selector.
    let (confirmed, _) = f.refs("src/app/hero-detail.component.ts", "hero?: Hero", 0);
    assert_eq!(confirmed, s(&["src/app/app.component.ts:7", "src/app/hero-detail.component.html:1", "src/app/hero-detail.component.ts:9"]));
    let (confirmed, _) = f.refs("src/app/hero-detail.component.ts", "HeroDetailComponent", 0);
    assert_eq!(confirmed, s(&["src/app/app.component.ts:7", "src/app/hero-detail.component.ts:8"]));
}

#[test]
fn template_bindings_take_the_type_of_what_they_bind() {
    let f = fixture(&[
        ("src/model.ts", "export interface Item {\n  price: number;\n}\nexport interface Decoy {\n  price: string;\n}\n"),
        ("src/List.vue", "<template><p v-for=\"it in items\">{{ it.price }}</p></template>\n<script setup lang=\"ts\">\nimport type { Item } from './model'\ndefineProps<{ items: Item[] }>()\n</script>\n"),
        ("src/List.svelte", "<script lang=\"ts\">\n  import type { Item } from './model';\n  export let items: Item[] = [];\n</script>\n{#each items as it}{it.price}{/each}\n"),
        (
            "src/list.component.ts",
            "import { Component, input, signal } from '@angular/core';\nimport { Item } from './model';\n@Component({\n  selector: 'app-list',\n  template: `\n    @for (it of items(); track it) { {{ it.price }} }\n    @if (current(); as c) { {{ c.price }} }\n  `,\n})\nexport class ListComponent {\n  items = input.required<Item[]>();\n  current = signal<Item | null>(null);\n}\n",
        ),
    ]);
    assert_eq!(f.def_nth("src/List.vue", "price }}", 0, 0), s(&["src/model.ts:2"]));
    assert_eq!(f.def_nth("src/List.svelte", "price}", 0, 0), s(&["src/model.ts:2"]));
    assert_eq!(f.def_nth("src/list.component.ts", "price }} }\n    @if", 0, 0), s(&["src/model.ts:2"]), "@for over a signal input");
    assert_eq!(f.def_nth("src/list.component.ts", "price }} }\n  `", 0, 0), s(&["src/model.ts:2"]), "@if's alias");
}

#[test]
fn stylesheets_resolve_variables_modules_and_custom_properties() {
    let f = fixture(&[
        ("tsconfig.json", r#"{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }"#),
        ("src/styles/_tokens.scss", "$space: 8px;\n@mixin card($pad: $space) {\n  padding: $pad;\n}\n@function double($x) { @return $x * 2; }\n"),
        ("src/styles/index.scss", "@forward 'tokens';\n"),
        ("src/theme.css", ":root {\n  --accent: #f00;\n}\n.dark {\n  --accent: #0f0;\n}\n"),
        (
            "src/app.scss",
            "@use '@/styles' as s;\n@use 'sass:math';\n$local: 1px;\n.app {\n  $inner: 2px;\n  margin: s.$space $local $inner;\n  @include s.card;\n  width: s.double(2) math.div(1, 2);\n  color: var(--accent);\n}\n",
        ),
        ("src/legacy.less", "@gap: 4px;\n.a { margin: @gap; }\n"),
        ("src/Card.module.scss", ".card {\n  padding: 1px;\n  &__title { font-weight: bold; }\n}\n.card-body { x: 1 }\n"),
        ("src/Card.tsx", "import styles from './Card.module.scss';\nexport const Card = () => <div className={styles.card}><h2 className={styles.card__title} /><p className={styles.cardBody} /></div>;\n"),
        ("src/Panel.vue", "<template><div /></template>\n<style lang=\"scss\">\n@use '@/styles' as s;\n.panel { padding: s.$space; color: var(--accent); }\n</style>\n"),
    ]);
    let app = "src/app.scss";
    assert_eq!(f.def_nth(app, "$space", 0, 1), s(&["src/styles/_tokens.scss:1"]), "through @use and @forward");
    assert_eq!(f.def_nth(app, "$local", 1, 1), s(&["src/app.scss:3"]));
    assert_eq!(f.def_nth(app, "$inner", 1, 1), s(&["src/app.scss:5"]), "a block's own");
    assert_eq!(f.def_nth(app, "card;", 0, 0), s(&["src/styles/_tokens.scss:2"]), "a mixin");
    assert_eq!(f.def_nth(app, "double(2)", 0, 0), s(&["src/styles/_tokens.scss:5"]), "a function");
    assert!(f.def_nth(app, "div(1", 0, 0).is_empty(), "sass:math's");
    assert_eq!(f.def_nth(app, "--accent", 0, 0), s(&["src/theme.css:2", "src/theme.css:5"]), "every declaration");
    assert_eq!(f.def_nth(app, "@/styles", 0, 0), s(&["src/styles/index.scss:1"]), "a @use path");
    assert_eq!(f.def_nth("src/legacy.less", "@gap;", 0, 0), s(&["src/legacy.less:1"]));
    assert_eq!(f.def_nth("src/Panel.vue", "$space", 0, 1), s(&["src/styles/_tokens.scss:1"]), "a component's style block");
    assert_eq!(f.def_nth("src/Card.tsx", "card}", 0, 0), s(&["src/Card.module.scss:1"]), "a CSS module's class");
    assert_eq!(f.def_nth("src/Card.tsx", "card__title", 0, 0), s(&["src/Card.module.scss:3"]), "a nested `&__` class");
    assert_eq!(f.def_nth("src/Card.tsx", "cardBody", 0, 0), s(&["src/Card.module.scss:5"]), "camelCased");

    let (confirmed, _) = f.refs("src/styles/_tokens.scss", "$space: 8px", 0);
    assert_eq!(confirmed, s(&["src/Panel.vue:4", "src/app.scss:6", "src/styles/_tokens.scss:1", "src/styles/_tokens.scss:2"]));
    let (confirmed, _) = f.refs("src/Card.module.scss", "card {", 0);
    assert_eq!(confirmed, s(&["src/Card.module.scss:1", "src/Card.tsx:2"]));
}

impl Fixture {
    /// `rel:line` of the first occurrence of `needle` in `rel`.
    fn line_of(&self, rel: &str, needle: &str) -> String {
        format!("{rel}:{}", self.at(rel, needle, 0, 0).0)
    }
}

#[test]
fn typescript_constructs_resolve_by_declaration() {
    let shapes = "src/shapes.ts";
    let f = fixture(&[
        (
            shapes,
            "export abstract class Base {\n  greet(): string { return ''; }\n  static create(): Base { return null!; }\n}\nexport class Child extends Base {\n  own() {}\n}\nexport enum Color { Red, Green = 'g' }\nexport namespace Geo {\n  export interface Point { x: number }\n  export const origin: Point = { x: 0 };\n}\nexport interface Named { name: string }\nexport interface Person extends Named { age: number }\nexport type Both = Named & { id: number };\nexport type Pair = [Named, Person];\nexport function makeChild(): Child { return new Child(); }\nexport async function load(): Promise<Person> { return null!; }\nexport interface ButtonProps { label: string }\nexport function Button(props: ButtonProps) { return null; }\n",
        ),
        (
            "src/use.tsx",
            "import { Child, Color, Geo, Both, Pair, Person, makeChild, load, Base, Button } from './shapes';\nimport * as shapes from './shapes';\nclass Sub extends Child {\n  run() { super.greet(); this.own(); }\n}\nmakeChild().greet();\nColor.Green;\nGeo.origin.x;\nlet p: Geo.Point;\np.x;\nlet both: Both;\nboth.id;\nboth.name;\nlet pair: Pair;\npair[1].age;\nasync function f() { const person = await load(); person.age; }\n({} as Person).age;\nshapes.makeChild().own();\nBase.create().greet();\nload().then((v) => v.name);\nconst people: Person[] = [];\npeople.reduce((sum, who) => sum + who.age, 0);\nconst el = <Button label=\"go\" />;\n",
        ),
        // The same names, declared elsewhere: a name match would find two of each.
        (
            "src/decoys.ts",
            "export class Decoy {\n  greet() {}\n  own() {}\n  static create() {}\n  get() {}\n}\nexport enum Other { Green }\nexport const origin = 0;\nexport interface D { x: string; id: string; name: string; age: string; label: string }\n",
        ),
        ("lib/api.js", "class Api {\n  get() {}\n}\nmodule.exports = new Api();\n"),
        ("lib/main.js", "const api = require('./api');\napi.get();\n"),
    ]);
    let use_ = "src/use.tsx";
    let want = |needle: &str| vec![f.line_of(shapes, needle)];
    assert_eq!(f.def(use_, "greet(); this"), want("greet()"), "super: the base class's");
    assert_eq!(f.def(use_, "own(); }"), want("own()"), "this: an inherited class's own");
    assert_eq!(f.def(use_, "greet();\nColor"), want("greet()"), "inherited, through a return type");
    assert_eq!(f.def(use_, "Green;"), want("Green ="), "an enum member");
    assert_eq!(f.def(use_, "origin.x"), want("origin"), "a namespace's export");
    assert_eq!(f.def_nth(use_, "x;\nlet p", 0, 0), want("x: number }"), "a namespace const's type");
    assert_eq!(f.def_nth(use_, "Point;", 0, 0), want("Point {"), "a qualified type");
    assert_eq!(f.def_nth(use_, "x;\nlet both", 0, 0), want("x: number }"));
    assert_eq!(f.def(use_, "id;"), want("id: number"), "an intersection's object part");
    assert_eq!(f.def(use_, "name;\nlet pair"), want("name: string"), "an intersection's named part");
    assert_eq!(f.def(use_, "age;\nasync"), want("age: number"), "a tuple's element");
    assert_eq!(f.def(use_, "age; }"), want("age: number"), "awaited");
    assert_eq!(f.def(use_, "age;\nshapes"), want("age: number"), "`as`");
    assert_eq!(f.def(use_, "own();\nBase"), want("own()"), "a namespace import's function's return");
    assert_eq!(f.def(use_, "create()"), want("static create"), "a static member");
    assert_eq!(f.def(use_, "greet();\nload"), want("greet()"));
    assert_eq!(f.def(use_, "name);"), want("name: string"), "`.then`'s value, via an interface's `extends`");
    assert_eq!(f.def(use_, "age, 0"), want("age: number"), "`reduce`'s element");
    assert_eq!(f.def(use_, "label="), want("label: string"), "a prop typed by an interface");
    assert_eq!(f.def("lib/main.js", "get()"), vec![f.line_of("lib/api.js", "get()")], "CommonJS exporting an instance");
}
