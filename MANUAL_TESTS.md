# review-me — Manual Test Plan

Manual QA scenarios for features that can't be (fully) covered by automated tests —
mostly the keyboard/vim interaction, the magit-style UI, and end-to-end persistence.
Automated tests live in the Rust crate (`cd src-tauri && cargo test`); run those first.

Check items off as you go. Each scenario lists **Steps** and the **Expect**ed result.

---

## 0. Setup

### Run the app

```bash
npm install            # first time only
npm run tauri dev      # launches the desktop window (needs a display)
```

The frontend alone can be smoke-built without the window: `npm run build`.

### Build a test fixture repository

Several tests need a git repo with a variety of uncommitted changes. Create one:

```bash
mkdir -p /tmp/air-fixture && cd /tmp/air-fixture
git init -b master
printf 'one\ntwo\nthree\nfour\nfive\n' > kept.txt
printf 'public class A {\n    int x = 1;\n    int y = 2;\n}\n' > A.java
printf 'binary\0content\n' > logo.bin
git add . && git commit -qm "initial"

# Now produce a dirty working tree:
printf 'one\nTWO-CHANGED\nthree\nfour\nfive\n' > kept.txt   # modified (unstaged)
printf 'public class A {\n    int x = 1;\n    int y = 22;\n    int z = 3;\n}\n' > A.java
git add A.java                                              # staged modification
printf 'brand new file\nsecond line\n' > fresh.txt          # untracked (status A)
printf 'changed\0bytes\n' > logo.bin                        # binary change
```

> Tips for the remaining statuses:
> - **Rename:** `git mv A.java B.java && git add -A` (shows `R`, `old → new`).
> - **Delete:** `rm kept.txt` (shows `D`).

---

## 1. M1 — Open repo & diff view

### 1.1 Startup dashboard
- [ ] **Steps:** Launch the app with no repo open.
- [ ] **Expect:** Centered `review-me` logo, tagline, and a key menu (`Space`, `o p`, `o r`, `:`). Dark theme.

### 1.2 Open via directory browser (path navigator)
- [ ] **Steps:** Press `Space` → `o` → `p`. The prompt is a **colored path** (`~`-abbreviated): ancestors dim teal, the **current level** highlighted bright teal, then your typed filter. **Type to filter** the current directory; navigate rows with `↑`/`↓` (or `Ctrl-n`/`Ctrl-p`). **`Tab` descends** into the highlighted directory; **`Enter` opens** the highlighted directory as a repo (a non-repo folder descends instead). Walk down to `/tmp/air-fixture` with `Tab`.
- [ ] **Expect:** Selection lands on the **first matching directory** (not the `..` / "open this repository" rows). Directory entries listed (dirs only) with **colored folder icons**; git repos tinted git-red and marked `git` in amber. A top row **"open this repository"** appears when the current dir is itself a repo (`Enter` opens it).
- [ ] **Steps:** With the filter empty, press `Backspace` repeatedly.
- [ ] **Expect:** When the filter has text, `Backspace` deletes a character; once empty, `Backspace` removes the **whole last path segment** (climbs to the parent) and the listing updates. `Enter` on the fixture repo opens it; `Esc` cancels.
- [ ] **Steps:** Select the fixture repo and open it.
- [ ] **Expect:** Switches to the diff buffer; status bar appears.

### 1.3 Open via `:` command line
- [ ] **Steps:** `Esc`/close any repo, press `:`, type `open`, `Enter`.
- [ ] **Expect:** Same directory browser opens (noice-style command line filters commands as you type).

### 1.4 Recent repositories
- [ ] **Steps:** After opening once, press `Space` → `o` → `r`.
- [ ] **Expect:** The fixture repo is listed (most-recent first) with a git-tinted folder icon. **Type to filter** by name/path (substring). `↑`/`↓` (or `Ctrl-n`/`Ctrl-p`) move, `Enter` reopens the selected repo. `Ctrl-d` forgets the selected entry (it disappears).

### 1.5 Changed-file list correctness
- [ ] **Steps:** Compare the diff buffer against `git status` / `git diff HEAD` in the fixture.
- [ ] **Expect:** Every changed file appears with the right status glyph (`A`/`M`/`D`/`R`), `+adds −dels` counts, and a green staged dot `●` on files with staged changes (e.g. `A.java`). `fresh.txt` shows as `A`. `logo.bin` shows as **binary** (no expandable diff).
- [ ] **Expect:** Renamed files (if you did `git mv`) show `old → new` with the `R` glyph.

### 1.5b Review sections (To review / Flagged / Reviewed / Ignored)
- [ ] **Expect:** The diff list is grouped into up to four magit-style sections, always in this order: **TO REVIEW**, **FLAGGED**, **REVIEWED**, **IGNORED** (uppercase headers with a `▾` caret and an item count). With nothing tagged yet, every changed file sits under **TO REVIEW** and the other headers are **hidden** (empty sections never render).
- [ ] **Steps:** Press `Tab` (or double-click) on a section header.
- [ ] **Expect:** The whole section folds (caret flips to `▸`, its files/hunks/lines hide); `Tab` again unfolds it.

### 1.6 Vim navigation
- [ ] **Steps:** With the diff buffer focused, use the keys below.
- [ ] **Expect:**
  - `j` / `k` move the cursor down / up one row (selection stripe follows, auto-scrolls).
  - `gg` jumps to the top, `G` to the bottom.
  - `]f` / `[f` jump to next / previous **file** header.
  - `]h` / `[h` jump to next / previous **hunk** header (after expanding).
  - `]s` / `[s` jump to next / previous **section** header.

### 1.7 Expand / collapse files and hunks (magit-style nested folding)
- [ ] **Steps:** On a file row, press `Tab` (or double-click).
- [ ] **Expect:** The file expands to show hunk headers (`@@ … @@`, blue, each with a `▾`/`▸` caret) and unified-diff lines: old/new line-number gutters, `+` lines green, `−` lines red, context muted. `Tab` on the file row again collapses the whole file.
- [ ] **Steps:** Move the cursor onto a **hunk header** and press `Tab` (or double-click).
- [ ] **Expect:** Only that hunk's lines collapse (caret flips to `▸`); sibling hunks stay expanded. `Tab` again re-expands just that hunk. Pressing `Tab` while on a diff **line** also folds the parent hunk and lands the cursor on its header.
- [ ] **Note:** Only `Tab` (and double-click) folds — `Enter` does **not** (see 1.7c).

### 1.7c Enter opens the file in project mode at the cursor position
- [ ] **Steps:** With the cursor on a diff **line** (an added/context line), press `Enter`.
- [ ] **Expect:** The project buffer comes to the front showing that file, with the viewer cursor scrolled to and placed on the same line.
- [ ] **Steps:** Press `Enter` on a **hunk header** / a **file** row instead.
- [ ] **Expect:** Opens the file at the hunk's start line / the file's first changed line, respectively.

### 1.7b Section highlight follows the cursor
- [ ] **Steps:** With a file expanded, move the cursor onto the **file** header, then a **hunk** header, then a single **line**.
- [ ] **Expect:** On the file header the whole file (header + all its hunks/lines) gets a subtle background; on a hunk header only that hunk (header + its lines) is washed; on a line only that line. On a top-level **section header** the entire section is washed. In every case the exact cursor row keeps the brighter wash + amber left-bar. Entering visual (`v`) replaces the wash with the violet selection highlight.

### 1.8 Buffer switching
- [ ] **Steps:** `Space` → `b` → `p` (project), then `Space` → `b` → `d` (diff). Also try `:project` / `:diff`.
- [ ] **Expect:** Project buffer shows a placeholder ("coming in a later milestone"); diff buffer returns with cursor/scroll preserved.

### 1.9 Refresh & close
- [ ] **Steps:** Edit a file in the fixture externally, then `Space` → `r` (refresh). Then `Space` → `c` (close).
- [ ] **Expect:** Refresh recomputes the diff to match the new working-tree state. Close returns to the startup dashboard.

### 1.9b Clean working tree — fake terminal
- [ ] **Steps:** Make the working tree clean (e.g. `git stash` or commit all changes in the fixture), then `Space` → `r` (refresh).
- [ ] **Expect:** Instead of an empty list, the diff buffer shows a fake terminal window that *types* `git status` and prints "nothing to commit, working tree clean" (last clause green), then `git rev-parse --short HEAD` and `review-me status`. The branch, short HEAD sha, and reviewed/flagged counts are **real** (match the fixture). A green block cursor blinks at a trailing `❯` prompt, and a `r refresh · b p project · o p open repo` hint row fades in below. Editing a file + `r` returns to the normal diff list; making it clean again replays the type-out.
- [ ] **Reduced motion:** With OS "reduce motion" enabled, the whole transcript renders immediately and static (no typewriter, no blink).

### 1.10 Leader keys & focus
- [ ] **Expect:** `Space` always opens the palette, `:` the command line, from any buffer. `Esc` dismisses overlays. Typing in the command-line input does **not** trigger leader keys.

### 1.11 Word-diff highlighting & mode toggle
- [ ] **Steps:** Expand a file that has a *modified* line (a line edited in place, not purely added/removed). Look at the changed `+`/`−` line pair.
- [ ] **Expect (default):** Only the parts that actually changed within the line carry a stronger green/red background; the unchanged parts keep the plain line tint. Purely added/removed lines (no counterpart) stay fully tinted.
- [ ] **Steps:** In the diff buffer, `Space` → `h` (or `:diffmode` / `:highlight`).
- [ ] **Expect:** The view switches to whole-line highlighting (no intra-line emphasis); the command label flips to `diff highlight → word`. Toggling again restores word highlighting. The command only appears while the diff buffer is active.

---

## 2. M2 — Review, flag & ignore tagging

> All tagging happens in the diff buffer. Reviewed = "I've checked this".
> Flag = "come back and scrutinize this later". Ignore (`i`) = "set this aside, I
> don't need to review it".
> Tagging **moves** items between the four sections (§1.5b): reviewing pulls a hunk
> into **REVIEWED**, flagging into **FLAGGED**, ignoring into **IGNORED**;
> `u`/un-flag/un-ignore returns it to **TO REVIEW**.
> Classification is per-hunk with precedence **flagged > ignored > reviewed > to-review**.

### 2.1 Review a hunk
- [ ] **Steps:** Expand a file, move the cursor onto a **hunk header**, press `r`.
- [ ] **Expect:** The hunk leaves **TO REVIEW** and reappears under **REVIEWED** with a green `✓`. Status bar `✓ done/total hunks` increments. If it was the file's last hunk in To review, the file header leaves that section too.

### 2.2 Review a whole file
- [ ] **Steps:** Move to a **file row**, press `r`.
- [ ] **Expect:** All of that file's hunks become `✓` and move under **REVIEWED**; the file header now appears under Reviewed (and is gone from To review). Pressing `u` on that file row moves it back to **TO REVIEW**.

### 2.2b Partial review splits a file across sections
- [ ] **Steps:** Expand a file with **two or more** hunks. Review just one hunk (`r` on its header).
- [ ] **Expect:** The file header appears **twice** — once under **TO REVIEW** (listing only the still-unreviewed hunks) and once under **REVIEWED** (listing only the reviewed hunk) — exactly like magit repeats a file across Unstaged/Staged.

### 2.3 Review a sub-range (visual selection)
- [ ] **Steps:** Expand a hunk, move onto a diff line, press `v`, extend with `j`/`k` over a few lines, press `r`.
- [ ] **Expect:** Header shows a `VISUAL` badge while selecting (violet highlight on selected rows). After `r`, only the selected lines get the green reviewed edge-stripe; selection clears. `Esc` cancels a selection without tagging.

### 2.4 Unmark reviewed
- [ ] **Steps:** On a reviewed hunk/file/line, press `u`.
- [ ] **Expect:** The `✓` / reviewed stripe is removed for that scope. Status bar count decrements.

### 2.5 Flag toggle (scope follows the highlighted selection)
- [ ] **Steps:** On a file/hunk/line (or a visual selection), press `f`. Press `f` again on the same scope.
- [ ] **Expect:** First `f` adds an amber `⚑` (and amber line stripe) and moves the hunk under **FLAGGED**; status bar `⚑ count` increments. Second `f` removes it (toggle) and the hunk returns to its prior section. The flag covers exactly the scope currently highlighted — flagging a **hunk** stripes only that hunk's lines (sibling hunks stay unflagged), flagging a **line** stripes only that line.

### 2.5b Ignore toggle (`i`)
- [ ] **Steps:** On a file/hunk/line (or a visual selection) in **TO REVIEW**, press `i`. Press `i` again on the same scope.
- [ ] **Expect:** First `i` adds a violet `⊘` (and violet line stripe) and moves the hunk under **IGNORED**; status bar `⊘ count` increments. Second `i` removes it (toggle) and the hunk returns to its prior section. Scope follows the highlighted selection exactly like flag (§2.5). Binary/hunkless files can be ignored at file scope.

### 2.5c Ignore vs flag precedence
- [ ] **Steps:** Ignore a hunk (it moves to **IGNORED**), then flag a line inside it.
- [ ] **Expect:** The hunk moves to **FLAGGED** (flag wins over ignore); the hunk row can show both `⚑` and `⊘`. Removing the flag drops it back into **IGNORED**.

### 2.6 Reviewed + flagged together (flag precedence)
- [ ] **Steps:** Review a hunk (it moves to **REVIEWED**), then flag a line inside it.
- [ ] **Expect:** The hunk moves to **FLAGGED** (flag wins over reviewed); the line shows both a green and an amber edge stripe, and the hunk row can show both `✓` and `⚑`. Removing the flag drops it back into **REVIEWED**.

### 2.7 Persistence across restart
- [ ] **Steps:** Tag several hunks/lines (review + flag). Fully quit the app and relaunch. Reopen the same repo.
- [ ] **Expect:** All `✓`, `⚑`, and `⊘` marks reload exactly. Inspect `/tmp/air-fixture/.review-me/tags.json` — it contains the `reviewed`, `flags`, and `ignored` arrays with anchors.

### 2.8 Anchoring survives small edits
- [ ] **Steps:** Review a hunk. In the fixture, insert 2–3 new lines **above** that hunk's region in the file (external editor). `Space` → `r` to refresh.
- [ ] **Expect:** The reviewed `✓` still lands on the same code (the anchor's line range shifts to follow it), not on the wrong lines.

### 2.9 Stale detection
- [ ] **Steps:** Review a hunk, then **rewrite** that region's content entirely (so the captured text no longer exists). Refresh.
- [ ] **Expect:** The tag is marked stale (it no longer claims those changed lines as reviewed). It must **not** silently mark unrelated code as reviewed.

### 2.10 Refresh keeps tags
- [ ] **Steps:** With tags present, make an unrelated change elsewhere and `Space` → `r`.
- [ ] **Expect:** Existing tags remain attached to their code; new changes appear unreviewed.

### 2.11 Clear all tags (`:clear`)
- [ ] **Steps:** Review a couple of hunks and flag a line, then press `:`, type `clear`, `Enter`.
- [ ] **Expect:** A small centered confirm modal "Clear all tags?" appears, reading e.g. "Removes 2 reviewed + 1 flagged + 0 ignored tags. This can't be undone." with footer `y confirm · n / Esc cancel`.
- [ ] **Steps:** Press `Esc` (or `n`).
- [ ] **Expect:** The modal closes and every `✓`/`⚑`/`⊘` is untouched.
- [ ] **Steps:** Run `:clear` again and press `y` (or `Enter`).
- [ ] **Expect:** All sections reset — every file returns to **TO REVIEW**, FLAGGED/REVIEWED/IGNORED headers disappear, and `/tmp/air-fixture/.review-me/tags.json` now has empty `reviewed`, `flags`, and `ignored` arrays.
- [ ] **Steps:** Press `Space` and scan the palette; also try `:clear` with no tags present.
- [ ] **Expect:** There is **no** chord/shortcut for clear anywhere in the `Space` palette (command-line only). With nothing tagged, the modal reads "No tags to clear." and `y` is a harmless no-op.

---

## 3. M3 — Fuzzy finder & project mode

> Optional fixture prep for ignore-awareness: in `/tmp/air-fixture`, add
> `echo 'build/' > .gitignore && mkdir build && echo junk > build/out.o`, and a
> nested source dir: `mkdir -p src/app && echo 'class B {}' > src/app/B.java`.

### 3.1 Fuzzy file finder
- [ ] **Steps:** With a repo open, press `Space` → `f` (or `:` → `find`). Type part of a filename (e.g. `bjava`).
- [ ] **Expect:** Results rank by fuzzy score; the matched characters are highlighted amber. `↑`/`↓` (or `Ctrl-n`/`Ctrl-p`) move, `Enter` opens the file in **project mode**, `Esc` cancels. Empty query lists files immediately.
- [ ] **Expect:** Git-ignored files (e.g. `build/out.o`) do **not** appear.
- [ ] **Expect:** Each row shows a colored file-type icon left of the path (e.g. the orange Java glyph for `*.java`, a generic file glyph for unknown types) — never a broken/empty box.

### 3.2 Project tree navigation
- [ ] **Steps:** `Space` → `b` → `p` to enter project mode (or open a file via the finder). Focus the left tree.
- [ ] **Expect:** Repo file tree; `.git` and ignored dirs (`build/`) are hidden. Directories sort first. `j`/`k` move, `l`/`Enter` expands a dir (lazy-loads children) or opens a file, `h` collapses an expanded dir or jumps to the parent, `Tab` toggles the folder under the cursor (expand/collapse; no-op on files), `G` to bottom, `q` returns to the diff buffer.
- [ ] **Expect:** Directories show a blue folder icon that switches between closed/open as they expand; files show a colored type icon (Java, Rust, TS, JSON, Markdown, …) matching their extension.

### 3.3 File viewer
- [ ] **Steps:** Open a `.java` file. Move the cursor into the viewer (open a file via `Enter`, or `Ctrl-h` toggles back to the tree).
- [ ] **Expect:** Java syntax highlighting, line numbers, **vim motions** (`j/k`, `gg`/`G`, `/search`, `w/b`). The file is **read-only** (insert keys don't change it). `Ctrl-h` returns focus to the tree; `q` (vim normal mode) returns to the diff buffer at its previous position. `Space`/`:` still open the palette/command line from normal mode.
- [ ] **Steps:** With the viewer focused, press `/` to start a search and type a query containing the letter `q`.
- [ ] **Expect:** The `q` is typed into the search field — it does **not** leave the buffer (the `q→diff` mapping is normal-mode only).
- [ ] **Steps:** Open files of other types (e.g. `.ts`, `.rs`, `.py`, `.json`, `.md`, `Cargo.toml`).
- [ ] **Expect:** Each gets language-appropriate syntax highlighting (the grammar lazy-loads by file name on first open). Unknown/plain extensions (e.g. `.txt`, `logo.bin`) render as uncolored text — no error.

### 3.4 Flag in project mode
- [ ] **Steps:** In the viewer, visually select a few lines (`v` + `j`), then `Space` → `t` → `f`.
- [ ] **Expect:** Those lines get an amber flag highlight; status-bar `⚑` count increments. Switch buffers / reopen the file → the flag highlight persists (and is in `.review-me/tags.json`).
- [ ] **Expect:** There is **no** "reviewed" action in project mode (reviewing is diff-only); only flagging is available here.

---

## 4. M4 — Cross-references (tree-sitter, Java)

> Use the nested Java fixture from §3 (`src/app/B.java` plus the existing
> `A.java`/`B.java`). For a meatier test, add a class that's used across files,
> e.g. a `Greeter` class referenced from a `Main` class.

### 4.1 Go to definition
- [ ] **Steps:** Open a `.java` file in project mode, put the cursor on a type or method name that's defined elsewhere, press `gd` (or `Space` → `g` → `d`).
- [ ] **Expect:** If there's a single definition, the viewer jumps straight to it (opening the defining file if needed, cursor on the declaration). If multiple, the **Cross-reference** panel lists them; `Enter` navigates. A symbol with no definition shows a "no definition" panel.

### 4.2 Click to definition
- [ ] **Steps:** In the viewer, hold `Ctrl` (or `Cmd` on macOS) and click directly on a type/method reference that's defined elsewhere.
- [ ] **Expect:** The cursor turns into a pointer while the modifier is held; clicking jumps to the definition exactly like `gd` (single hit navigates; multiple hits open the Cross-reference panel). A plain click (no modifier) still just places the cursor / selects text. `Ctrl`/`Cmd`+click on whitespace or an unresolved word does nothing.

### 4.3 Find references
- [ ] **Steps:** Cursor on a symbol, press `gr` (or `Space` → `g` → `r`).
- [ ] **Expect:** The panel lists every occurrence as `file:line` + source snippet, with `def`/`ref` badges; same-file results are ranked first. `↑`/`↓`/`j`/`k` move, `Enter` opens the chosen location in the viewer at that line, `Esc` closes.

### 4.4 Index freshness
- [ ] **Steps:** Open a repo (the index builds in the background). Run `gd`/`gr` — they should work without a manual build step. Add/rename a Java symbol, then `Space` → `r` (refresh).
- [ ] **Expect:** After refresh, cross-references reflect the updated code.

### 4.5 Non-Java / no symbol
- [ ] **Steps:** Try `gd` on whitespace, or in a non-`.java` file.
- [ ] **Expect:** Nothing happens (no symbol resolved) — no crash.

> **Known limitation:** resolution is name+kind based (no full type/scope
> resolution), so references to same-named symbols in different classes may all
> appear. This is intended for navigation, not exact semantic analysis.

---

## 5. Regression sanity
- [ ] App builds: `npm run build` (frontend) and `cd src-tauri && cargo test` (backend, all green).
- [ ] No console errors in the dev tools during normal use.
- [ ] Theme/contrast readable; long file paths truncate rather than overflow.
- [ ] Cross-buffer flow: open repo → review/flag in diff → `Space f` to a file →
      `gd`/`gr` to navigate → flag in project mode → all marks persist after restart.
