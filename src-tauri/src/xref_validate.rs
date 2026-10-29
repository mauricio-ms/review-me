//! End-to-end validation of the Java resolver against a realistic multi-package
//! project, complementing the two- and three-file fixtures in `xref::tests`.
//!
//!     ./scripts/make-java-sample.sh          # build the fixture (gitignored)
//!     cargo test --lib xref_validate -- --nocapture
//!
//! Skips when `sample-java/` is absent, so a fresh clone still runs `cargo test`
//! clean — run the script above to actually exercise it.

use std::path::{Path, PathBuf};

use git2::Repository;

use crate::revision::ProjectSource;
use crate::xref;

fn sample_root() -> Option<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("sample-java");
    root.is_dir().then(|| root.canonicalize().unwrap())
}

fn java_files(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().map(|n| n == ".git").unwrap_or(false) {
                    continue;
                }
                walk(&path, root, out);
            } else if path.extension().map(|x| x == "java").unwrap_or(false) {
                out.push(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

/// 1-based line / 0-based column of `token`, on the first line containing `anchor`.
fn pos(root: &Path, file: &str, anchor: &str, token: &str) -> (u32, u32) {
    let text = std::fs::read_to_string(root.join(file)).unwrap();
    for (i, line) in text.lines().enumerate() {
        if let Some(start) = line.find(anchor) {
            let col = line[start..]
                .find(token)
                .map(|c| start + c)
                .unwrap_or_else(|| panic!("{token:?} not found in {line:?}"));
            return (i as u32 + 1, col as u32);
        }
    }
    panic!("no line containing {anchor:?} in {file}");
}

fn line_of(root: &Path, file: &str, line: u32) -> String {
    std::fs::read_to_string(root.join(file))
        .unwrap()
        .lines()
        .nth(line.saturating_sub(1) as usize)
        .unwrap_or("")
        .trim()
        .to_string()
}

enum Expect {
    /// Exactly one definition, in this file, on a line containing this text.
    One(&'static str, &'static str),
    /// The picker case: this many candidates.
    Many(usize),
    /// No definition at all.
    Nothing,
}

struct Case {
    what: &'static str,
    file: &'static str,
    anchor: &'static str,
    token: &'static str,
    expect: Expect,
}

#[test]
fn validate() {
    // Shares `xref`'s serialising lock: the symbol index is process-global, so this
    // must not run alongside the unit tests building their own fixtures.
    let _lock = xref::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let Some(root) = sample_root() else {
        eprintln!(
            "SKIPPED: sample-java/ is missing — run ./scripts/make-java-sample.sh to build it"
        );
        return;
    };
    let repo = Repository::open(&root).unwrap();
    let files = java_files(&root);
    let src = ProjectSource::Worktree;

    let stats = xref::build_index(&repo, &root, &src, &files).unwrap();
    println!(
        "\nindexed {} files, {} symbols\n",
        stats.files, stats.symbols
    );

    let cases = vec![
        Case { what: "local variable", file: "src/com/example/service/Library.java",
            anchor: "return label;", token: "label",
            expect: Expect::One("src/com/example/service/Library.java", "String label = Strings.shout") },
        Case { what: "method parameter", file: "src/com/example/service/Library.java",
            anchor: "Strings.shout(name)", token: "name",
            expect: Expect::One("src/com/example/service/Library.java", "public String rename(String name)") },
        Case { what: "field via this (shadowed by param)", file: "src/com/example/service/Library.java",
            anchor: "this.name = label;", token: "name",
            expect: Expect::One("src/com/example/service/Library.java", "private String name;") },
        Case { what: "ctor param on the RHS", file: "src/com/example/model/Media.java",
            anchor: "= title;", token: "title",
            expect: Expect::One("src/com/example/model/Media.java", "protected Media(String title, int year)") },
        Case { what: "inherited field via this", file: "src/com/example/model/Media.java",
            anchor: "this.title = title;", token: "title",
            expect: Expect::One("src/com/example/model/Media.java", "protected String title;") },
        Case { what: "type by explicit import", file: "src/com/example/service/Library.java",
            anchor: "public void add(Book book)", token: "Book",
            expect: Expect::One("src/com/example/model/Book.java", "public class Book extends Media") },
        Case { what: "type in the same package", file: "src/com/example/service/SearchService.java",
            anchor: "private final Library library;", token: "Library",
            expect: Expect::One("src/com/example/service/Library.java", "public class Library") },
        Case { what: "type by wildcard import", file: "src/com/example/service/SearchService.java",
            anchor: "public Book firstOf(Genre genre)", token: "Book",
            expect: Expect::One("src/com/example/model/Book.java", "public class Book extends Media") },
        Case { what: "enum type by wildcard import", file: "src/com/example/service/SearchService.java",
            anchor: "public Book firstOf(Genre genre)", token: "Genre",
            expect: Expect::One("src/com/example/model/Genre.java", "public enum Genre") },
        Case { what: "nested type by simple name", file: "src/com/example/model/Book.java",
            anchor: "Summary result = new Summary(", token: "Summary",
            expect: Expect::One("src/com/example/model/Book.java", "public static class Summary") },
        Case { what: "overload picked by arity (1 arg)", file: "src/com/example/service/Library.java",
            anchor: "made.restock(5);", token: "restock",
            expect: Expect::One("src/com/example/model/Book.java", "public void restock(int amount) {") },
        Case { what: "overload picked by arity (0 args)", file: "src/com/example/App.java",
            anchor: "book.restock();", token: "restock",
            expect: Expect::One("src/com/example/model/Book.java", "public void restock() {") },
        Case { what: "bare call, enclosing class", file: "src/com/example/model/Book.java",
            anchor: "restock(1);", token: "restock",
            expect: Expect::One("src/com/example/model/Book.java", "public void restock(int amount) {") },
        Case { what: "inherited method via subclass", file: "src/com/example/service/SearchService.java",
            anchor: "return book.describe();", token: "describe",
            expect: Expect::One("src/com/example/model/Media.java", "public String describe()") },
        Case { what: "bare inherited call", file: "src/com/example/model/Book.java",
            anchor: "new Summary(describe()", token: "describe",
            expect: Expect::One("src/com/example/model/Media.java", "public String describe()") },
        Case { what: "interface method", file: "src/com/example/service/SearchService.java",
            anchor: "return item.title();", token: "title",
            expect: Expect::One("src/com/example/model/Item.java", "String title();") },
        Case { what: "chained call, 1st link", file: "src/com/example/service/Library.java",
            anchor: ".author().name()", token: "author",
            expect: Expect::One("src/com/example/model/Book.java", "public Author author()") },
        Case { what: "chained call, 2nd link", file: "src/com/example/service/Library.java",
            anchor: ".author().name()", token: "name",
            expect: Expect::One("src/com/example/model/Author.java", "public String name()") },
        Case { what: "field, then method on its type", file: "src/com/example/model/Book.java",
            anchor: "author.name()", token: "name",
            expect: Expect::One("src/com/example/model/Author.java", "public String name()") },
        Case { what: "enhanced-for binding", file: "src/com/example/service/Library.java",
            anchor: "book.copies()", token: "book",
            expect: Expect::One("src/com/example/service/Library.java", "for (Book book : books)") },
        Case { what: "method on for-binding", file: "src/com/example/service/Library.java",
            anchor: "book.copies()", token: "copies",
            expect: Expect::One("src/com/example/model/Book.java", "public int copies()") },
        Case { what: "enum constant", file: "src/com/example/service/SearchService.java",
            anchor: "Genre picked = Genre.FICTION;", token: "FICTION",
            expect: Expect::One("src/com/example/model/Genre.java", "FICTION,") },
        Case { what: "method on enum-typed local", file: "src/com/example/service/SearchService.java",
            anchor: "return picked.label();", token: "label",
            expect: Expect::One("src/com/example/model/Genre.java", "public String label()") },
        Case { what: "static method on imported class", file: "src/com/example/service/Library.java",
            anchor: "Strings.shout(name)", token: "shout",
            expect: Expect::One("src/com/example/util/Strings.java", "public static String shout") },
        Case { what: "type in `new`", file: "src/com/example/service/Library.java",
            anchor: "new Author(authorName)", token: "Author",
            expect: Expect::One("src/com/example/model/Author.java", "public class Author") },
        Case { what: "same simple name, import decides", file: "src/com/example/App.java",
            anchor: "Book book = library.create", token: "Book",
            expect: Expect::One("src/com/example/model/Book.java", "public class Book extends Media") },
        Case { what: "cross-package call", file: "src/com/example/App.java",
            anchor: "library.create(", token: "create",
            expect: Expect::One("src/com/example/service/Library.java", "public Book create(") },
        Case { what: "static import, single", file: "src/com/example/service/Catalog.java",
            anchor: "return shout(book.title());", token: "shout",
            expect: Expect::One("src/com/example/util/Strings.java", "public static String shout") },
        Case { what: "static import, on demand", file: "src/com/example/App.java",
            anchor: "shout(library.rename(", token: "shout",
            expect: Expect::One("src/com/example/util/Strings.java", "public static String shout") },
        Case { what: "static import, nested call", file: "src/com/example/service/Catalog.java",
            anchor: "return join(shout(", token: "join",
            expect: Expect::One("src/com/example/util/Strings.java", "public static String join") },
        Case { what: "static import, constant", file: "src/com/example/service/Catalog.java",
            anchor: "), SEPARATOR);", token: "SEPARATOR",
            expect: Expect::One("src/com/example/util/Strings.java", "SEPARATOR = ") },
        Case { what: "name in an import static", file: "src/com/example/service/Catalog.java",
            anchor: "import static com.example.util.Strings.shout;", token: "shout",
            expect: Expect::One("src/com/example/util/Strings.java", "public static String shout") },
        // --- the residue: these must fail honestly, not silently guess ---
        Case { what: "static import from the JDK", file: "src/com/example/service/Catalog.java",
            anchor: "requireNonNull(library)", token: "requireNonNull",
            expect: Expect::Nothing },
        Case { what: "var receiver -> picker", file: "src/com/example/service/Library.java",
            anchor: "legacy.restock(2);", token: "restock",
            expect: Expect::Many(4) },
        Case { what: "jar-typed receiver (List.add)", file: "src/com/example/service/Library.java",
            anchor: "books.add(book);", token: "add",
            expect: Expect::Nothing },
        Case { what: "jar method on catch param", file: "src/com/example/service/Library.java",
            anchor: "failure.getMessage()", token: "getMessage",
            expect: Expect::Nothing },
        Case { what: "inherited-from-jar enum method", file: "src/com/example/model/Genre.java",
            anchor: "SCIENCE.toString()", token: "toString",
            expect: Expect::Nothing },
    ];

    let mut failures = 0;
    println!("{:<38} {:<8} {}", "CASE", "RESULT", "DETAIL");
    println!("{}", "-".repeat(100));

    for case in &cases {
        let (line, col) = pos(&root, case.file, case.anchor, case.token);
        let symbol = match xref::symbol_at(&repo, &root, &src, case.file, line, col).unwrap() {
            Some(s) => s,
            None => {
                failures += 1;
                println!("{:<38} {:<8} symbol_at found nothing at {}:{}:{}", case.what, "FAIL", case.file, line, col);
                continue;
            }
        };
        let defs = xref::find_definition(&repo, &root, &src, &files, &symbol).unwrap();

        let (ok, detail) = match &case.expect {
            Expect::One(file, snippet) => {
                if defs.len() != 1 {
                    (false, format!("expected 1 definition, got {} [{}]", defs.len(),
                        defs.iter().map(|d| format!("{}:{}", d.file, d.line)).collect::<Vec<_>>().join(", ")))
                } else {
                    let got = &defs[0];
                    let got_line = line_of(&root, &got.file, got.line);
                    if got.file == *file && got_line.contains(snippet) {
                        (true, format!("{}:{}", got.file, got.line))
                    } else {
                        (false, format!("landed on {}:{} `{}`", got.file, got.line, got_line))
                    }
                }
            }
            Expect::Many(n) => {
                if defs.len() == *n { (true, format!("{} candidates", defs.len())) }
                else { (false, format!("expected {} candidates, got {}", n, defs.len())) }
            }
            Expect::Nothing => {
                if defs.is_empty() { (true, "no definition".to_string()) }
                else {
                    (false, format!("expected none, got {} [{}]", defs.len(),
                        defs.iter().map(|d| format!("{}:{}", d.file, d.line)).collect::<Vec<_>>().join(", ")))
                }
            }
        };
        if !ok { failures += 1; }
        println!("{:<38} {:<8} {}", case.what, if ok { "ok" } else { "FAIL" }, detail);
    }

    // ---- references ----
    println!("\n{:<38} {:<8} {}", "REFERENCE CASE", "RESULT", "DETAIL");
    println!("{}", "-".repeat(100));

    let ref_checks: Vec<(&str, &str, &str, &str, Vec<(&str, &str, Option<bool>)>)> = vec![
        (
            "Book.restock(int)",
            "src/com/example/model/Book.java",
            "public void restock(int amount) {",
            "restock",
            vec![
                ("src/com/example/service/Library.java", "made.restock(5)", Some(true)),
                ("src/com/example/service/Library.java", "legacy.restock(2)", Some(false)),
                ("src/com/example/model/Book.java", "restock(1);", Some(true)),
                ("src/com/example/dup/Book.java", "public void restock(int amount)", None),
                ("src/com/example/App.java", "book.restock();", None),
            ],
        ),
        (
            "Author.name()",
            "src/com/example/model/Author.java",
            "public String name()",
            "name",
            vec![
                ("src/com/example/service/Library.java", ".author().name()", Some(true)),
                ("src/com/example/model/Book.java", "author.name()", Some(true)),
                ("src/com/example/service/Library.java", "private String name;", None),
                ("src/com/example/service/Library.java", "this.name = label;", None),
            ],
        ),
        (
            "Strings.shout",
            "src/com/example/util/Strings.java",
            "public static String shout",
            "shout",
            vec![
                ("src/com/example/service/Library.java", "Strings.shout(name)", Some(true)),
                ("src/com/example/service/Catalog.java", "return shout(book.title());", Some(true)),
                ("src/com/example/service/Catalog.java", "import static com.example.util.Strings.shout;", Some(true)),
                ("src/com/example/App.java", "shout(library.rename(", Some(true)),
                ("src/com/example/dup/Megaphone.java", "public String shout(", None),
                ("src/com/example/dup/Megaphone.java", "return shout(shout(words));", None),
            ],
        ),
    ];

    for (label, file, anchor, token, checks) in &ref_checks {
        let (line, col) = pos(&root, file, anchor, token);
        let symbol = xref::symbol_at(&repo, &root, &src, file, line, col)
            .unwrap()
            .expect("symbol");
        let refs = xref::find_references(&repo, &root, &src, &files, &symbol).unwrap();

        for (want_file, want_anchor, want) in checks {
            let (want_line, _) = pos(&root, want_file, want_anchor, token);
            let hit = refs
                .iter()
                .find(|r| r.file == *want_file && r.line == want_line);
            let (ok, detail) = match (want, hit) {
                (Some(c), Some(r)) if r.confirmed == *c => (true, format!("confirmed={}", r.confirmed)),
                (Some(c), Some(r)) => (false, format!("confirmed={}, wanted {}", r.confirmed, c)),
                (Some(_), None) => (false, "missing from results".to_string()),
                (None, None) => (true, "correctly dropped".to_string()),
                (None, Some(r)) => (false, format!("should be dropped, got confirmed={}", r.confirmed)),
            };
            if !ok { failures += 1; }
            println!("{:<38} {:<8} {} {}",
                format!("{label} @ {want_anchor}"),
                if ok { "ok" } else { "FAIL" }, want_file, detail);
        }
    }

    println!("\n{} failure(s)\n", failures);
    assert_eq!(failures, 0, "see report above");
}
