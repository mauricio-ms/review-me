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

## 3. Regression sanity
- [ ] App builds: `npm run build` (frontend) and `cd src-tauri && cargo test` (backend, all green).
- [ ] No console errors in the dev tools during normal use.
- [ ] Theme/contrast readable; long file paths truncate rather than overflow.

---

## Not yet implemented (do not test)
- **Project mode** (M3): file tree + viewer, fuzzy file finder — currently a placeholder.
- **Cross-references** (M4): `gd` / `gr` go-to-definition / find-usages via tree-sitter (Java).

_When M3/M4 land, add their scenarios under new sections here._
