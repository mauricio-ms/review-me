# ai-review — Manual Test Plan

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
- [ ] **Expect:** Centered `ai-review` logo, tagline, and a key menu (`Space`, `o p`, `o r`, `:`). Dark theme.

### 1.2 Open via directory browser
- [ ] **Steps:** Press `Space` → `o` → `p`. Navigate with `j`/`k`, descend with `Enter`/`l`/`→`, go up with `Backspace`/`h`/`←` until you reach `/tmp/air-fixture`.
- [ ] **Expect:** Directory entries listed (dirs only), git repos marked `git` in amber. A top row **"open this repository"** appears when the current dir is itself a repo. `Esc` cancels.
- [ ] **Steps:** Select the fixture repo and open it.
- [ ] **Expect:** Switches to the diff buffer; status bar appears.

### 1.3 Open via `:` command line
- [ ] **Steps:** `Esc`/close any repo, press `:`, type `open`, `Enter`.
- [ ] **Expect:** Same directory browser opens (noice-style command line filters commands as you type).

### 1.4 Recent repositories
- [ ] **Steps:** After opening once, press `Space` → `o` → `r`.
- [ ] **Expect:** The fixture repo is listed (most-recent first). `Enter` reopens it. `d` forgets the selected entry (it disappears).

### 1.5 Changed-file list correctness
- [ ] **Steps:** Compare the diff buffer against `git status` / `git diff HEAD` in the fixture.
- [ ] **Expect:** Every changed file appears with the right status glyph (`A`/`M`/`D`/`R`), `+adds −dels` counts, and a green staged dot `●` on files with staged changes (e.g. `A.java`). `fresh.txt` shows as `A`. `logo.bin` shows as **binary** (no expandable diff).
- [ ] **Expect:** Renamed files (if you did `git mv`) show `old → new` with the `R` glyph.

### 1.6 Vim navigation
- [ ] **Steps:** With the diff buffer focused, use the keys below.
- [ ] **Expect:**
  - `j` / `k` move the cursor down / up one row (selection stripe follows, auto-scrolls).
  - `gg` jumps to the top, `G` to the bottom.
  - `]f` / `[f` jump to next / previous **file** header.
  - `]h` / `[h` jump to next / previous **hunk** header (after expanding).

### 1.7 Expand / collapse hunks
- [ ] **Steps:** On a file row, press `Tab` (or `Enter`, or double-click).
- [ ] **Expect:** The file expands to show hunk headers (`@@ … @@`, blue) and unified-diff lines: old/new line-number gutters, `+` lines green, `−` lines red, context muted. `Tab` again collapses.

### 1.8 Buffer switching
- [ ] **Steps:** `Space` → `b` → `p` (project), then `Space` → `b` → `d` (diff). Also try `:project` / `:diff`.
- [ ] **Expect:** Project buffer shows a placeholder ("coming in a later milestone"); diff buffer returns with cursor/scroll preserved.

### 1.9 Refresh & close
- [ ] **Steps:** Edit a file in the fixture externally, then `Space` → `r` (refresh). Then `Space` → `c` (close).
- [ ] **Expect:** Refresh recomputes the diff to match the new working-tree state. Close returns to the startup dashboard.

### 1.10 Leader keys & focus
- [ ] **Expect:** `Space` always opens the palette, `:` the command line, from any buffer. `Esc` dismisses overlays. Typing in the command-line input does **not** trigger leader keys.

---

## 2. M2 — Review & flag tagging

> All tagging happens in the diff buffer. Reviewed = "I've checked this".
> Flag = "come back and scrutinize this later".

### 2.1 Review a hunk
- [ ] **Steps:** Expand a file, move the cursor onto a **hunk header**, press `r`.
- [ ] **Expect:** A green `✓` appears on that hunk row. Status bar `✓ done/total hunks` increments.

### 2.2 Review a whole file
- [ ] **Steps:** Move to a **file row**, press `r`.
- [ ] **Expect:** All of that file's hunks become `✓`; the file row shows `✓`. Pressing `u` on the file row clears them.

### 2.3 Review a sub-range (visual selection)
- [ ] **Steps:** Expand a hunk, move onto a diff line, press `v`, extend with `j`/`k` over a few lines, press `r`.
- [ ] **Expect:** Header shows a `VISUAL` badge while selecting (violet highlight on selected rows). After `r`, only the selected lines get the green reviewed edge-stripe; selection clears. `Esc` cancels a selection without tagging.

### 2.4 Unmark reviewed
- [ ] **Steps:** On a reviewed hunk/file/line, press `u`.
- [ ] **Expect:** The `✓` / reviewed stripe is removed for that scope. Status bar count decrements.

### 2.5 Flag toggle
- [ ] **Steps:** On a file/hunk/line (or a visual selection), press `f`. Press `f` again on the same scope.
- [ ] **Expect:** First `f` adds an amber `⚑` (and amber line stripe); status bar `⚑ count` increments. Second `f` removes it (toggle). Flags work on the same scopes as review.

### 2.6 Reviewed + flagged together
- [ ] **Steps:** Review a line, then flag the same line.
- [ ] **Expect:** The line shows both a green and an amber edge stripe; file/hunk rows can show both `✓` and `⚑`.

### 2.7 Persistence across restart
- [ ] **Steps:** Tag several hunks/lines (review + flag). Fully quit the app and relaunch. Reopen the same repo.
- [ ] **Expect:** All `✓` and `⚑` marks reload exactly. Inspect `/tmp/air-fixture/.ai-review/tags.json` — it contains the `reviewed` and `flags` arrays with anchors.

### 2.8 Anchoring survives small edits
- [ ] **Steps:** Review a hunk. In the fixture, insert 2–3 new lines **above** that hunk's region in the file (external editor). `Space` → `r` to refresh.
- [ ] **Expect:** The reviewed `✓` still lands on the same code (the anchor's line range shifts to follow it), not on the wrong lines.

### 2.9 Stale detection
- [ ] **Steps:** Review a hunk, then **rewrite** that region's content entirely (so the captured text no longer exists). Refresh.
- [ ] **Expect:** The tag is marked stale (it no longer claims those changed lines as reviewed). It must **not** silently mark unrelated code as reviewed.

### 2.10 Refresh keeps tags
- [ ] **Steps:** With tags present, make an unrelated change elsewhere and `Space` → `r`.
- [ ] **Expect:** Existing tags remain attached to their code; new changes appear unreviewed.

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
- [ ] **Expect:** Repo file tree; `.git` and ignored dirs (`build/`) are hidden. Directories sort first. `j`/`k` move, `l`/`Enter` expands a dir (lazy-loads children) or opens a file, `h` collapses an expanded dir or jumps to the parent, `G` to bottom.
- [ ] **Expect:** Directories show a blue folder icon that switches between closed/open as they expand; files show a colored type icon (Java, Rust, TS, JSON, Markdown, …) matching their extension.

### 3.3 File viewer
- [ ] **Steps:** Open a `.java` file. Move the cursor into the viewer (open a file via `Enter`, or `Ctrl-h` toggles back to the tree).
- [ ] **Expect:** Java syntax highlighting, line numbers, **vim motions** (`j/k`, `gg`/`G`, `/search`, `w/b`). The file is **read-only** (insert keys don't change it). `Ctrl-h` returns focus to the tree. `Space`/`:` still open the palette/command line from normal mode.
- [ ] **Steps:** Open files of other types (e.g. `.ts`, `.rs`, `.py`, `.json`, `.md`, `Cargo.toml`).
- [ ] **Expect:** Each gets language-appropriate syntax highlighting (the grammar lazy-loads by file name on first open). Unknown/plain extensions (e.g. `.txt`, `logo.bin`) render as uncolored text — no error.

### 3.4 Flag in project mode
- [ ] **Steps:** In the viewer, visually select a few lines (`v` + `j`), then `Space` → `t` → `f`.
- [ ] **Expect:** Those lines get an amber flag highlight; status-bar `⚑` count increments. Switch buffers / reopen the file → the flag highlight persists (and is in `.ai-review/tags.json`).
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
