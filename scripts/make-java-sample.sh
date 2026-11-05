#!/usr/bin/env bash
# Recreate sample-java/ — a small Java project used to validate the cross-reference
# resolver end to end (`cargo test --lib xref_validate -- --ignored --nocapture`) and to poke at
# M-. / M-, / M-? by hand in project mode, plus a Markdown design note (docs/design.md)
# to read in the viewer, rendered.
#
# The generated tree is gitignored and is its own git repo, so review-me can open it.
# Safe to re-run: it wipes and rebuilds.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf sample-java

mkdir -p sample-java/.
cat > sample-java/notes.txt <<'JAVA_EOF'
Not a Java file. Used to check that xref declines non-Java sources.
JAVA_EOF

mkdir -p sample-java/.
cat > sample-java/README.md <<'JAVA_EOF'
# java-xref sample

A gitignored fixture for exercising review-me's Java cross-reference navigation
(`M-.` / `M-,` / `M-?`) in project mode. Its own git repo so review-me can open it.

Deliberate traps:
- `com.example.model.Book` and `com.example.dup.Book` share a simple name.
- `Book.restock` has three overloads; `Author.name()` and `Library.name` share one.
- `Library.legacyRestock` uses `var`, which the resolver cannot see through.
- `List`, `RuntimeException` and friends live in jars, so they are unresolvable.
- `service.Catalog` calls `Strings.shout`/`join` and reads `Strings.SEPARATOR` through
  `import static`, and `App` through `import static ...Strings.*`; `dup.Megaphone.shout`
  shares the name. `requireNonNull` is statically imported from the JDK.
JAVA_EOF

# Every construct the Markdown viewer renders, with links into the Java above and a few
# that deliberately go nowhere.
mkdir -p sample-java/docs
cat > sample-java/docs/design.md <<'JAVA_EOF'
---
title: Library service — design notes
status: draft
owners: [catalog-team]
reviewed: 2026-10-30
---

# Library service

Design notes for the sample's library domain: what each class is for, how a book moves
through the system, and what to look at when reviewing a change to it. The Java lives in
[`src/com/example`](../src/com/example/), and the fixture itself is described in the
[README](../README.md#java-xref-sample).

> [!NOTE]
> Every link in this file goes somewhere real in this repository, except the ones under
> [Links that go nowhere](#links-that-go-nowhere). Follow one with `C-c C-o`, `M-.` or
> Ctrl+click, and come back with `M-,`.

## Contents

1. [The model](#the-model)
2. [Services](#services)
3. [Lifecycle of a book](#lifecycle-of-a-book)
4. [Review checklist](#review-checklist)
5. [Configuration](#configuration)
6. [Open questions](#open-questions)

## The model

A [`Book`](../src/com/example/model/Book.java) is a
[`Media`](../src/com/example/model/Media.java), and every `Media` is an [Item][] — the
interface the search service types its receivers by, so that `titleOf` works for anything
with a title. Authors are their own class rather than a string on the book, because two
books by the same person should be *one* author, not two spellings of one.

| Class      |      Kind      | Fields | Notes                                     |
|:-----------|:--------------:|-------:|:------------------------------------------|
| `Item`     |   interface    |      — | `title()` only                            |
| `Media`    | abstract class |      2 | `title`, `year`; *describes itself*       |
| `Book`     |     class      |      3 | **three** `restock` overloads             |
| `Author`   |     class      |      1 | [`name()`](../src/com/example/model/Author.java) |
| `Genre`    |      enum      |      3 | `FICTION`, `HISTORY`, `SCIENCE`           |
| `dup.Book` |     class      |        | ~~same package~~ shares the simple name only |
| `Strings`  |  final class   |      1 | `join(a, b)` is `a \| b`, no separator    |

### Genres

[`Genre`](../src/com/example/model/Genre.java) is an enum with a `label()` for display:
the catalog prints labels, never constant names, so `SCIENCE` reads as "Science".

#### Why not strings?

A typo in a string compiles, ships, and turns up as a genre of its own in the next
report. A typo in an enum constant doesn't compile.

##### What about new genres?

Adding one is a code change, reviewed like any other — which is the point.

###### Fine print

Six levels of heading exist; this file uses all of them so you can see each one.

## Services

### Library

[`Library`](../src/com/example/service/Library.java) owns the books. It creates them
(with their author), adds them to the shelf, renames itself, and totals the copies it
holds:

```java
Library library = new Library("central");
Book book = library.create("Dune", 1965, "Herbert", Genre.SCIENCE);
library.add(book);
book.restock();
int copies = library.totalCopies();
```

### Catalog

[`Catalog`](../src/com/example/service/Catalog.java) turns books into lines of text —
`headline(book)` and `label(book)` — using the helpers in [`Strings`][strings]. It reads
from the library but never changes it.

### SearchService

[`SearchService`](../src/com/example/service/SearchService.java) answers questions:
the first book of a genre, an item's title, a book's description. ***Nothing here
writes.***

## Lifecycle of a book

1. **Created** by `Library.create`, which also makes its `Author`.
2. **Added** to the shelf with `Library.add`.
3. **Restocked**, by one of three overloads:
   - `restock()` — one more copy;
   - `restock(int amount)` — several;
   - `restock(int amount, boolean force)` — past the shelf's limit, when `force` is set,
     which is the case a reviewer should look at twice because nothing else checks it.
4. **Described** by `Media.describe`, which the catalog wraps for display.
10. **Retired** — not implemented yet; the number is here to show a wide marker.

## Review checklist

- [x] `Book.restock`'s overloads are told apart by argument count
- [x] `Author.name()` and `Library.name` don't resolve to each other
- [ ] `Library.legacyRestock` uses `var`, so navigation there falls back to matching by
  name — check what it lands on
- [ ] `List` and `RuntimeException` live in the JDK: `M-.` on them goes nowhere, on purpose
- Plain items mix with tasks, too
  - and nest under them
    - three levels deep

> [!TIP]
> Flag a line with `!` and leave a fix for later with `M-x note`: notes on a commit are
> exported as Markdown for an agent to act on.

> [!IMPORTANT]
> A note is anchored to the lines it was written on, and follows them when they move.

> [!WARNING]
> `restock(int, boolean)` with `force` set skips the shelf limit.

> [!CAUTION]
> `M-x clear` deletes every mark in the comparison, notes included.

## Configuration

The sample reads nothing at runtime; if it did, it would look like this:

```json
{
  "library": { "name": "central", "shelfLimit": 12 },
  "catalog": { "separator": " / " }
}
```

Rebuild the fixture and run the resolver's checks against it:

```bash
./scripts/make-java-sample.sh
cd src-tauri && cargo test --lib xref_validate -- --ignored --nocapture
```

The last change to `Book`, as a diff:

```diff
-    public void restock(int amount) {
+    public void restock(int amount, boolean force) {
```

An indented block is code too:

    $ git log --oneline
    74f22c1 java xref fixture

```
A fence with no language is shown as plain monospace.
```

## Open questions

> Should `Catalog` know about `Library` at all, or only about the books it's given? It
> holds a reference today and uses it for nothing a list of books couldn't give it.
>
> > Only the books, said the first review — *the catalog formats, it doesn't fetch.*

Plain prose with a hard line break at the end of this one  
and the line that follows it. An escaped \*asterisk\*, an escaped \_underscore\_ and a
literal \`backtick\` stay as written. Autolinks: <https://github.github.com/gfm/>, a bare
https://commonmark.org, and mail to <reviews@example.com>.

<details>
<summary>Raw HTML stays as written</summary>

The viewer leaves HTML blocks alone.

</details>

<!-- An HTML comment: a reviewer sees it, a renderer doesn't. -->

---

## Links that go nowhere

Each of these says why it can't be followed:

- [a file that doesn't exist](missing.md)
- [a heading that doesn't exist](#no-such-heading)
- [a path out of the repository](../../outside.md)
- [WIP] — brackets with no definition behind them are just text

## Services

A second heading with the same name gets the anchor `#services-1`:
[jump to this one](#services-1), or [back to the first](#services).

Setext heading, level one
=========================

Setext heading, level two
-------------------------

![The class diagram](diagram.png)

[item]: ../src/com/example/model/Item.java "The Item interface"
[strings]: <../src/com/example/util/Strings.java>
JAVA_EOF

mkdir -p sample-java/src/com/example
cat > sample-java/src/com/example/App.java <<'JAVA_EOF'
package com.example;

import static com.example.util.Strings.*;

import com.example.model.Book;
import com.example.model.Genre;
import com.example.service.Library;

public class App {
    public static void main(String[] args) {
        Library library = new Library("central");
        Book book = library.create("Dune", 1965, "Herbert", Genre.SCIENCE);
        library.add(book);
        book.restock();
        String banner = shout(library.rename("main"));
    }
}
JAVA_EOF

mkdir -p sample-java/src/com/example/dup
cat > sample-java/src/com/example/dup/Book.java <<'JAVA_EOF'
package com.example.dup;

/** Deliberately shares its simple name with com.example.model.Book. */
public class Book {
    public String title() {
        return "legacy";
    }

    public void restock(int amount) {
    }
}
JAVA_EOF

mkdir -p sample-java/src/com/example/dup
cat > sample-java/src/com/example/dup/Megaphone.java <<'JAVA_EOF'
package com.example.dup;

/** Its shout shares a name with Strings.shout, which the static imports bring in. */
public class Megaphone {
    public String shout(String words) {
        return words + "!";
    }

    public String twice(String words) {
        return shout(shout(words));
    }
}
JAVA_EOF

mkdir -p sample-java/src/com/example/model
cat > sample-java/src/com/example/model/Author.java <<'JAVA_EOF'
package com.example.model;

public class Author {
    private final String name;

    public Author(String name) {
        this.name = name;
    }

    public String name() {
        return name;
    }
}
JAVA_EOF

mkdir -p sample-java/src/com/example/model
cat > sample-java/src/com/example/model/Book.java <<'JAVA_EOF'
package com.example.model;

public class Book extends Media {
    private final Author author;
    private final Genre genre;
    private int copies;

    public Book(String title, int year, Author author, Genre genre) {
        super(title, year);
        this.author = author;
        this.genre = genre;
        this.copies = 1;
    }

    public Author author() {
        return author;
    }

    public Genre genre() {
        return genre;
    }

    public int copies() {
        return copies;
    }

    public void restock() {
        restock(1);
    }

    public void restock(int amount) {
        this.copies = copies + amount;
    }

    public void restock(int amount, boolean force) {
        if (force || amount > 0) {
            this.copies = copies + amount;
        }
    }

    /** Nested type, referenced by its simple name from the outer class. */
    public static class Summary {
        private final String text;

        Summary(String text) {
            this.text = text;
        }

        public String text() {
            return text;
        }
    }

    public Summary summarize() {
        Summary result = new Summary(describe() + " by " + author.name());
        return result;
    }
}
JAVA_EOF

mkdir -p sample-java/src/com/example/model
cat > sample-java/src/com/example/model/Genre.java <<'JAVA_EOF'
package com.example.model;

public enum Genre {
    FICTION,
    HISTORY,
    SCIENCE;

    public String label() {
        return SCIENCE.toString();
    }
}
JAVA_EOF

mkdir -p sample-java/src/com/example/model
cat > sample-java/src/com/example/model/Item.java <<'JAVA_EOF'
package com.example.model;

/** Interface method declarations are definitions too. */
public interface Item {
    String title();

    int year();
}
JAVA_EOF

mkdir -p sample-java/src/com/example/model
cat > sample-java/src/com/example/model/Media.java <<'JAVA_EOF'
package com.example.model;

public abstract class Media implements Item {
    protected String title;
    protected int year;

    protected Media(String title, int year) {
        this.title = title;
        this.year = year;
    }

    @Override
    public String title() {
        return title;
    }

    @Override
    public int year() {
        return year;
    }

    public String describe() {
        return title() + " (" + year() + ")";
    }
}
JAVA_EOF

mkdir -p sample-java/src/com/example/service
cat > sample-java/src/com/example/service/Catalog.java <<'JAVA_EOF'
package com.example.service;

import static com.example.util.Strings.SEPARATOR;
import static com.example.util.Strings.join;
import static com.example.util.Strings.shout;
import static java.util.Objects.requireNonNull;

import com.example.model.Book;

/** Static imports: the helpers are called bare, as if they were Catalog's own. */
public class Catalog {
    private final Library library;

    public Catalog(Library library) {
        this.library = requireNonNull(library);
    }

    /** Strings.shout, not Megaphone's. */
    public String headline(Book book) {
        return shout(book.title());
    }

    /** Nested static-import calls, and a static-import constant. */
    public String label(Book book) {
        return join(shout(book.title()), SEPARATOR);
    }
}
JAVA_EOF

mkdir -p sample-java/src/com/example/service
cat > sample-java/src/com/example/service/Library.java <<'JAVA_EOF'
package com.example.service;

import com.example.model.Author;
import com.example.model.Book;
import com.example.model.Genre;
import com.example.util.Strings;

import java.util.ArrayList;
import java.util.List;

public class Library {
    private final List<Book> books = new ArrayList<>();
    private String name;

    public Library(String name) {
        this.name = name;
    }

    public void add(Book book) {
        books.add(book);
    }

    public Book create(String title, int year, String authorName, Genre genre) {
        Author author = new Author(authorName);
        Book made = new Book(title, year, author, genre);
        made.restock(5);
        return made;
    }

    /** The local shadows the field of the same name. */
    public String rename(String name) {
        String label = Strings.shout(name);
        this.name = label;
        return label;
    }

    /** Chained: create(..) -> Book, .author() -> Author, .name() lives on Author. */
    public String firstAuthorName(String title, int year, String who, Genre genre) {
        return create(title, year, who, genre).author().name();
    }

    /** Enhanced-for binding, then a call on it. */
    public int totalCopies() {
        int total = 0;
        for (Book book : books) {
            total = total + book.copies();
        }
        return total;
    }

    /** Catch parameter typed by a jar class. */
    public String safeJoin(String left, String right) {
        try {
            return Strings.join(left, right);
        } catch (RuntimeException failure) {
            return failure.getMessage();
        }
    }

    /** `var` erases the receiver type -- the picker case. */
    public void legacyRestock() {
        var legacy = new com.example.dup.Book();
        legacy.restock(2);
    }
}
JAVA_EOF

mkdir -p sample-java/src/com/example/service
cat > sample-java/src/com/example/service/SearchService.java <<'JAVA_EOF'
package com.example.service;

import com.example.model.*;

public class SearchService {
    private final Library library;

    public SearchService(Library library) {
        this.library = library;
    }

    /** Book and Genre both arrive through the wildcard import. */
    public Book firstOf(Genre genre) {
        Book found = null;
        return found;
    }

    /** Library is in this same package -- no import needed. */
    public Library library() {
        return library;
    }

    /** Interface-typed receiver: title() is declared on Item. */
    public String titleOf(Item item) {
        return item.title();
    }

    /** Inherited method reached through a subclass reference. */
    public String describeBook(Book book) {
        return book.describe();
    }

    /** Enum constant, then a method on the enum. */
    public String defaultGenre() {
        Genre picked = Genre.FICTION;
        return picked.label();
    }
}
JAVA_EOF

mkdir -p sample-java/src/com/example/util
cat > sample-java/src/com/example/util/Strings.java <<'JAVA_EOF'
package com.example.util;

public final class Strings {
    public static final String SEPARATOR = " / ";

    private Strings() {
    }

    public static String join(String left, String right) {
        return left + right;
    }

    public static String shout(String value) {
        return value.toUpperCase();
    }
}
JAVA_EOF

cd sample-java
git init -q -b master
git add -A
git -c user.email=fixture@example.com -c user.name=fixture commit -qm "java xref fixture"

# Leave one deliberately large untracked file for exercising diff virtualization and
# file/hunk folding without adding thousands of Java symbols to the xref fixture. Every
# 25th line is long enough to wrap, so scrolling crosses rows taller than estimated.
long=$(printf 'wrapped fixture content %.0s' {1..30})
for ((line = 1; line <= 50000; line++)); do
    if ((line % 25 == 0)); then
        printf 'line %05d: %s\n' "$line" "$long"
    else
        printf 'line %05d: large diff fixture content for scrolling and folding\n' "$line"
    fi
done > large-diff.txt

echo "sample-java/ rebuilt ($(find . -name '*.java' | wc -l) java files, 50000-line diff fixture)"
