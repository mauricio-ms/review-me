#!/usr/bin/env bash
# Recreate sample-java/ — a small Java project used to validate the cross-reference
# resolver end to end (`cargo test --lib xref_validate -- --nocapture`) and to poke at
# M-. / M-, / M-? by hand in project mode.
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
JAVA_EOF

mkdir -p sample-java/src/com/example
cat > sample-java/src/com/example/App.java <<'JAVA_EOF'
package com.example;

import com.example.model.Book;
import com.example.model.Genre;
import com.example.service.Library;

public class App {
    public static void main(String[] args) {
        Library library = new Library("central");
        Book book = library.create("Dune", 1965, "Herbert", Genre.SCIENCE);
        library.add(book);
        book.restock();
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
