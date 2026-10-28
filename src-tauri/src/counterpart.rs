//! Test ↔ code: the file a test exercises, or the tests of a file, by naming convention
//! (projectile's toggle between implementation and test). `FooTest.java` ↔ `Foo.java`,
//! `foo.test.ts` ↔ `foo.ts`, `test_foo.py` ↔ `foo.py`, `foo_test.go` ↔ `foo.go`, and a
//! file under `__tests__/` ↔ the same name outside it.

use git2::Repository;
use serde::Serialize;

use crate::error::AppResult;
use crate::fuzzy;
use crate::revision::ProjectSource;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Counterpart {
    /// The file asked about is a test, so `paths` is the code it tests (else its tests).
    pub from_test: bool,
    /// Candidates, best first.
    pub paths: Vec<String>,
    /// The first candidate is strictly better than the rest: open it without asking.
    pub decisive: bool,
}

/// Endings that make a file name a test's, and the part before them its subject's.
/// `IT`/`ITCase` (Maven's integration tests) only after a lowercase letter or digit, so
/// `SPLIT` isn't the test of `SPL`.
const TEST_SUFFIXES: &[&str] = &[
    "Tests", "Test", "ITCase", "IT", "Spec", ".test", ".spec", "_test", "_spec", "-test",
    "-spec",
];

/// Folders that hold tests or code by role rather than by package: left out when
/// comparing where two files live, so `src/test/java/x` sits where `src/main/java/x` does.
const ROLE_DIRS: &[&str] = &["test", "tests", "__tests__", "spec", "specs", "main"];

/// The subject of a test's file stem (`FooTest` → `Foo`), or None when it isn't one.
fn test_subject(stem: &str) -> Option<&str> {
    for suffix in TEST_SUFFIXES {
        if let Some(base) = stem.strip_suffix(suffix) {
            let last = base.chars().last();
            let fits = match *suffix {
                "IT" | "ITCase" => last.is_some_and(|c| c.is_lowercase() || c.is_ascii_digit()),
                _ => last.is_some(),
            };
            if fits {
                return Some(base);
            }
        }
    }
    if let Some(base) = stem.strip_prefix("Test") {
        if base.chars().next().is_some_and(char::is_uppercase) {
            return Some(base);
        }
    }
    stem.strip_prefix("test_").filter(|base| !base.is_empty())
}

/// Extensions a subject and its test may differ by (`foo.test.ts` may test `foo.tsx`).
fn extension_family(ext: &str) -> Vec<&str> {
    match ext {
        "ts" | "tsx" => vec!["ts", "tsx"],
        "js" | "jsx" | "mjs" | "cjs" => vec!["js", "jsx", "mjs", "cjs"],
        other => vec![other],
    }
}

/// A path's folders, file stem and extension (`a/b/foo.test.ts` → `[a, b]`, `foo.test`, `ts`).
fn parts(path: &str) -> (Vec<&str>, &str, &str) {
    let (dir, name) = match path.rsplit_once('/') {
        Some((dir, name)) => (dir.split('/').collect(), name),
        None => (Vec::new(), path),
    };
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (dir, stem, ext),
        _ => (dir, name, ""),
    }
}

fn file_name(stem: &str, ext: &str) -> String {
    if ext.is_empty() {
        stem.to_string()
    } else {
        format!("{stem}.{ext}")
    }
}

/// How well `candidate`'s folders match `origin`'s: the same place (role folders aside),
/// then the longest shared tail (the package), then the longest shared head (the module).
fn closeness(origin: &[&str], candidate: &[&str]) -> (bool, usize, usize) {
    let strip = |dirs: &[&str]| -> Vec<String> {
        dirs.iter()
            .filter(|d| !ROLE_DIRS.contains(d))
            .map(|d| d.to_string())
            .collect()
    };
    let (a, b) = (strip(origin), strip(candidate));
    let tail = a.iter().rev().zip(b.iter().rev()).take_while(|(x, y)| x == y).count();
    let head = a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count();
    (a == b, tail, head)
}

/// The counterpart of `path` among `files`, best first — everything but listing the
/// revision, so it can be tested without a repository.
pub fn rank(path: &str, files: &[String]) -> Counterpart {
    let (dirs, stem, ext) = parts(path);
    let in_tests_dir = dirs.contains(&"__tests__");
    let subject = test_subject(stem).or(if in_tests_dir { Some(stem) } else { None });
    let from_test = subject.is_some();
    let family = extension_family(ext);

    let names: Vec<String> = match subject {
        Some(subject) => family.iter().map(|e| file_name(subject, e)).collect(),
        None => family
            .iter()
            .flat_map(|e| {
                TEST_SUFFIXES
                    .iter()
                    .map(move |suffix| file_name(&format!("{stem}{suffix}"), e))
                    .chain([
                        file_name(&format!("Test{stem}"), e),
                        file_name(&format!("test_{stem}"), e),
                    ])
            })
            .collect(),
    };

    let mut scored: Vec<((bool, usize, usize), &String)> = files
        .iter()
        .filter(|f| f.as_str() != path)
        .filter_map(|f| {
            let (cdirs, cstem, cext) = parts(f);
            let name = file_name(cstem, cext);
            let matches = names.contains(&name)
                // From code, a same-named file under `__tests__/` is its test; from a
                // test there, the same name outside it is the code.
                || (!from_test && cdirs.contains(&"__tests__") && cstem == stem && family.contains(&cext))
                || (from_test && in_tests_dir && !cdirs.contains(&"__tests__") && cstem == stem && family.contains(&cext));
            matches.then(|| (closeness(&dirs, &cdirs), f))
        })
        .collect();
    scored.sort_by(|(a, pa), (b, pb)| b.cmp(a).then_with(|| pa.cmp(pb)));

    let decisive = match scored.as_slice() {
        [] => false,
        [_] => true,
        [first, second, ..] => first.0 > second.0,
    };
    Counterpart {
        from_test,
        paths: scored.into_iter().map(|(_, f)| f.clone()).collect(),
        decisive,
    }
}

/// The counterpart of `path` in `source`'s files.
pub fn find(repo: &Repository, source: &ProjectSource, path: &str) -> AppResult<Counterpart> {
    let files = fuzzy::repo_files(repo, source)?;
    Ok(rank(path, &files))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|p| p.to_string()).collect()
    }

    #[test]
    fn java_test_finds_the_class_in_the_same_package() {
        let repo = files(&[
            "src/main/java/com/acme/OrderService.java",
            "src/main/java/com/acme/billing/OrderService.java",
            "src/test/java/com/acme/OrderServiceTest.java",
        ]);
        let found = rank("src/test/java/com/acme/OrderServiceTest.java", &repo);
        assert!(found.from_test);
        assert!(found.decisive);
        assert_eq!(found.paths[0], "src/main/java/com/acme/OrderService.java");
    }

    #[test]
    fn java_class_finds_its_tests() {
        let repo = files(&[
            "src/main/java/com/acme/OrderService.java",
            "src/test/java/com/acme/OrderServiceTest.java",
            "src/test/java/com/acme/OrderServiceIT.java",
            "src/test/java/com/acme/OtherTest.java",
        ]);
        let found = rank("src/main/java/com/acme/OrderService.java", &repo);
        assert!(!found.from_test);
        assert_eq!(
            found.paths,
            vec![
                "src/test/java/com/acme/OrderServiceIT.java",
                "src/test/java/com/acme/OrderServiceTest.java",
            ]
        );
        // Two tests of the same class, equally close: the reader picks.
        assert!(!found.decisive);
    }

    #[test]
    fn same_package_in_another_module_loses_to_this_module() {
        let repo = files(&[
            "billing/src/main/java/com/acme/Order.java",
            "shop/src/main/java/com/acme/Order.java",
        ]);
        let found = rank("shop/src/test/java/com/acme/OrderTest.java", &repo);
        assert!(found.decisive);
        assert_eq!(found.paths[0], "shop/src/main/java/com/acme/Order.java");
    }

    #[test]
    fn equally_close_candidates_are_not_decisive() {
        let repo = files(&["a/Order.java", "b/Order.java"]);
        let found = rank("c/OrderTest.java", &repo);
        assert_eq!(found.paths.len(), 2);
        assert!(!found.decisive);
    }

    #[test]
    fn typescript_spec_and_test_files() {
        let repo = files(&["src/cart.tsx", "src/cart.test.ts", "src/util.ts"]);
        let to_code = rank("src/cart.test.ts", &repo);
        assert!(to_code.from_test);
        assert_eq!(to_code.paths, vec!["src/cart.tsx"]);
        let to_test = rank("src/cart.tsx", &repo);
        assert_eq!(to_test.paths, vec!["src/cart.test.ts"]);
    }

    #[test]
    fn a_file_under_tests_folder_pairs_with_the_same_name_outside() {
        let repo = files(&["src/cart.ts", "src/__tests__/cart.ts"]);
        assert_eq!(rank("src/__tests__/cart.ts", &repo).paths, vec!["src/cart.ts"]);
        assert_eq!(rank("src/cart.ts", &repo).paths, vec!["src/__tests__/cart.ts"]);
    }

    #[test]
    fn python_and_go_conventions() {
        let repo = files(&["shop/cart.py", "tests/test_cart.py", "cart.go", "cart_test.go"]);
        assert_eq!(rank("tests/test_cart.py", &repo).paths, vec!["shop/cart.py"]);
        assert_eq!(rank("shop/cart.py", &repo).paths, vec!["tests/test_cart.py"]);
        assert_eq!(rank("cart_test.go", &repo).paths, vec!["cart.go"]);
        assert_eq!(rank("cart.go", &repo).paths, vec!["cart_test.go"]);
    }

    #[test]
    fn names_that_only_look_like_tests_are_not() {
        assert_eq!(test_subject("SPLIT"), None);
        assert_eq!(test_subject("Testimony"), None);
        assert_eq!(test_subject("Test"), None);
        assert_eq!(test_subject("FooIT"), Some("Foo"));
        assert_eq!(test_subject("TestFoo"), Some("Foo"));
        assert_eq!(test_subject("FooTests"), Some("Foo"));
    }

    #[test]
    fn nothing_to_pair_with() {
        let repo = files(&["src/Lonely.java"]);
        let found = rank("src/Lonely.java", &repo);
        assert!(!found.from_test);
        assert!(found.paths.is_empty());
        assert!(!found.decisive);
    }
}
