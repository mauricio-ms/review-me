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
