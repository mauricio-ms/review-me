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
printf 'd1\nd2\nd3\nd4\nd5\nd6\nd7\nd8\n' > shrink.txt
printf 'goodbye\nworld\n' > gone.txt
git add . && git commit -qm "initial"

# Now produce a dirty working tree:
printf 'one\nTWO-CHANGED\nthree\nfour\nfive\n' > kept.txt   # modified (unstaged)
printf 'public class A {\n    int x = 1;\n    int y = 22;\n    int z = 3;\n}\n' > A.java
git add A.java                                              # staged modification
printf 'brand new file\nsecond line\n' > fresh.txt          # untracked (status A)
printf 'changed\0bytes\n' > logo.bin                        # binary change
printf 'd1\nd2\nd6\nd7\nd8\n' > shrink.txt                  # pure-deletion hunk (d3..d5 removed)
rm gone.txt                                                 # deleted text file (status D)
```

> Tips for the remaining statuses:
> - **Rename:** `git mv A.java B.java && git add -A` (shows `R`, `old → new`).
> - **Delete:** `rm kept.txt` (shows `D`).

### Add branches for the comparison tests (§5)

Section 5 needs two branches that have both moved past their fork point, and a
remote-tracking branch. Build them on top of the fixture above:

```bash
cd /tmp/air-fixture
git stash -u                      # park the dirty working tree

git checkout -qb feature
printf 'one\ntwo\nBRANCH\nfour\nfive\n' > kept.txt
printf 'public class Extra {}\n' > Extra.java
rm gone.txt
printf 'branch\0bytes\n' > logo.bin
git add -A && git commit -qm "feature work"

git checkout -q master
printf 'base only\n' > base-only.txt
git add . && git commit -qm "master work"     # master moves too → real merge base

# A "remote" to exercise remote-tracking refs and origin/HEAD:
git clone -q /tmp/air-fixture /tmp/air-clone

git stash pop                     # restore the dirty working tree
git add A.java                    # stash pop doesn't restore the index
```

`/tmp/air-fixture` is the dirty-worktree repo; `/tmp/air-clone` is the one with
`origin/*` refs. Use whichever a step calls for.

### Add commits for the commit-review tests (§6)

Section 6 needs a merge commit and an empty commit. Both go on branches of their own so
`master...feature` (§5) keeps its merge base:

```bash
cd /tmp/air-fixture
git stash -u

git checkout -qb merged master
git merge -q --no-ff -m "merge feature" feature   # first parent = master work

git checkout -qb empties master
git commit -q --allow-empty -m "an empty commit"

git checkout -q master
git stash pop
git add A.java
```

The fixture's first commit (`initial`) is the **root** commit — §6 reviews that one too.

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

### 1.6b Scroll content without moving the cursor (`Ctrl-e` / `Ctrl-r`)
- [ ] **Steps:** Open a repo whose diff is taller than the window. With the diff buffer focused, hold `Ctrl-e`, then `Ctrl-r`.
- [ ] **Expect:** `Ctrl-e` scrolls the content **down** one line per press, `Ctrl-r` scrolls **up** one line — while the selected row's highlight stays put. At the very top/bottom the scroll stops cleanly (no error). `Ctrl-r` does **not** reload the app.
- [ ] **Steps:** Keep pressing `Ctrl-e` until the selected row would scroll off the top (then `Ctrl-r` past the bottom).
- [ ] **Expect:** The selection hops to the nearest still-visible row so the cursor never disappears. Pressing `j`/`k` afterward resumes normal cursor movement and re-centers as usual.

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
> `u` unmarks the current file/hunk/line/visual selection and returns it to **TO REVIEW**.
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

### 2.2c Review a deletion-only hunk
- [ ] **Steps:** Expand `shrink.txt` (the `d3..d5` removed block), put the cursor on its hunk header or a removed (`−`) line, press `r`.
- [ ] **Expect:** The deletion hunk leaves **TO REVIEW** and moves under **REVIEWED** with a green `✓`; the removed lines get the green reviewed stripe. Status bar `✓ done/total units` increments. `u` returns it to **TO REVIEW**.

### 2.2d Review a deleted file
- [ ] **Steps:** Move to `gone.txt` (status `D`), expand it, and review its single deletion hunk (or press `r` on the file row).
- [ ] **Expect:** The file moves under **REVIEWED**. Reviewing the file row reviews its whole deletion at once.

### 2.2e Review / flag / ignore a binary file
- [ ] **Steps:** Move to `logo.bin` (shown as **binary**, no expandable diff). Press `r`; then `u`; then `f`; then `i`.
- [ ] **Expect:** `r` moves the binary file under **REVIEWED** with a `✓`; `u` returns it to **TO REVIEW**; `f` flags it (`⚑`, **FLAGGED**); `i` ignores it (`⊘`, **IGNORED**). All operate at file scope (binary content can't be line-tagged).

### 2.3 Review a sub-range (visual selection)
- [ ] **Steps:** Expand a hunk, move onto a diff line, press `v`, extend with `j`/`k` over a few lines, press `r`.
- [ ] **Expect:** Header shows a `VISUAL` badge while selecting (violet highlight on selected rows). After `r`, only the selected lines get the green reviewed edge-stripe; selection clears. `Esc` cancels a selection without tagging.

### 2.4 Unmark a scope
- [ ] **Steps:** On a reviewed, flagged, or ignored hunk/file/line, press `u`.
- [ ] **Expect:** Any `✓` / `⚑` / `⊘` markers covering that scope are removed. The item returns to **TO REVIEW** and matching status bar counts decrement.

### 2.5 Flag mark (scope follows the highlighted selection)
- [ ] **Steps:** On a file/hunk/line (or a visual selection), press `f`. Press `f` again on the same scope, then press `u`.
- [ ] **Expect:** `f` adds an amber `⚑` (and amber line stripe) and moves the hunk under **FLAGGED**; pressing `f` again keeps it flagged instead of toggling it off. `u` removes the flag. The flag covers exactly the scope currently highlighted — flagging a **hunk** stripes only that hunk's lines (sibling hunks stay unflagged), flagging a **line** stripes only that line.

### 2.5b Ignore mark (`i`)
- [ ] **Steps:** On a file/hunk/line (or a visual selection) in **TO REVIEW**, press `i`. Press `i` again on the same scope, then press `u`.
- [ ] **Expect:** `i` adds a violet `⊘` (and violet line stripe) and moves the hunk under **IGNORED**; pressing `i` again keeps it ignored instead of toggling it off. `u` removes the ignore. Scope follows the highlighted selection exactly like flag (§2.5). Binary/hunkless files can be ignored at file scope.

### 2.5c Ignore vs flag precedence
- [ ] **Steps:** Ignore a hunk (it moves to **IGNORED**), then flag a line inside it.
- [ ] **Expect:** The hunk moves to **FLAGGED** (flag wins over ignore); the hunk row can show both `⚑` and `⊘`. Pressing `u` on the hunk clears both scoped markers and returns it to **TO REVIEW**.

### 2.6 Reviewed + flagged together (flag precedence)
- [ ] **Steps:** Review a hunk (it moves to **REVIEWED**), then flag a line inside it.
- [ ] **Expect:** The hunk moves to **FLAGGED** (flag wins over reviewed); the line shows both a green and an amber edge stripe, and the hunk row can show both `✓` and `⚑`. Pressing `u` on the hunk clears both scoped markers and returns it to **TO REVIEW**.

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

### 2.12 Commit reviewed changes (`:commit` / `Space` → `g` → `c`)
- [ ] **Steps:** Review one text hunk, leave another text hunk in **TO REVIEW**, then run `:commit` (or `Space` → `g` → `c`).
- [ ] **Expect:** The app stages only reviewed text hunks and opens an in-app Vim-style commit message buffer. The template has commented `#` help lines, a reviewed-hunk count, and the staged paths. `:wq` or `:x` commits; `:q` or `:cq` aborts and unstages the reviewed content. `Ctrl-Enter` also commits.
- [ ] **Steps:** Enter a message, commit with `:wq`, then compare `git log --oneline`, `git diff HEAD`, and `.review-me/tags.json`.
- [ ] **Expect:** A new commit exists containing only the reviewed text hunk. Unreviewed content remains in the working tree. Reviewed tags for committed content are cleared. Flagged and ignored tags remain.
- [ ] **Steps:** Stage any unrelated path manually with `git add`, then run `:commit` again.
- [ ] **Expect:** A confirmation appears explaining that continuing resets only the staging area to `HEAD` and does not modify working-tree files. `n`/`Esc` cancels without changing the index. `y`/`Enter` unstages the existing staged content, stages reviewed hunks, and opens the commit editor.
- [ ] **Steps:** With the commit editor open, abort with `:q`.
- [ ] **Expect:** The reviewed content staged by the flow is unstaged, the working tree content remains untouched, and the diff refreshes.
- [ ] **Steps:** Try committing with only blank/comment lines in the commit message.
- [ ] **Expect:** Commit is rejected and the editor stays open with an error message.

### 2.12b Commit reviewed deletions and binary files
- [ ] **Steps:** Review the `shrink.txt` deletion-only hunk (§2.2c), the deleted `gone.txt` (§2.2d), and the `logo.bin` binary change (§2.2e). Leave at least one text edit unreviewed. Run `:commit`, enter a message, `:wq`.
- [ ] **Expect:** The template's "Reviewed units staged" count includes the deletion hunk, the deleted file, and the binary file, and all three paths appear under "Changes to be committed". After committing, `git show --stat HEAD` shows the `d3..d5` removal in `shrink.txt`, `gone.txt` deleted, and `logo.bin` modified — and **nothing** from the unreviewed text edit. Reviewed tags for those three are cleared; any flag/ignore tags remain.
- [ ] **Steps:** Flag the `logo.bin` change (instead of reviewing it) and review only the `shrink.txt` deletion, then `:commit`.
- [ ] **Expect:** Only the `shrink.txt` deletion is staged/committed; the flagged binary file is excluded and its `⚑` remains afterward.

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

## 5. M5 — The review branch & branch comparison

> Uses the branch fixture from §0 (§6's additions give `merged`). Steps that mention
> `origin/*` need `/tmp/air-clone`.

### 5.0 The branch under review
- [ ] **Steps:** Open `/tmp/air-fixture` (checked out on `master`).
- [ ] **Expect:** The status bar carries `review: master` in grey — the branch under review starts as the checkout. Hovering says it's also the checkout.
- [ ] **Steps:** Press `Space` → `g` → `s` (or `:checkout`).
- [ ] **Expect:** A **Branch to review** picker (`N refs`). Rows badge `reviewing` (teal) on `master`, `default` (amber) on `master`, `checkout` (green) on the checked-out branch, `local`/`remote`, plus the short oid. Selection starts on the branch already under review.
- [ ] **Steps:** `Enter` on `feature`.
- [ ] **Expect:** The picker closes; the status bar reads `review: feature` in **amber** (it isn't the checkout), and hovering explains the working tree is on `master`. In a terminal, `git -C /tmp/air-fixture status` shows **`On branch master`** with the same dirty files as before — nothing was checked out.
- [ ] **Expect:** The working-tree diff on screen is unchanged: it still belongs to the real checkout.
- [ ] **Steps:** Open the palette (`Space` → `g`).
- [ ] **Expect:** The entries name the branch: `compare feature against a base`, `review a commit on feature`.

### 5.1 Compare against a base
- [ ] **Steps:** With `feature` under review, press `Space` → `g` → `b` (or `:compare`).
- [ ] **Expect:** A **Compare against** picker listing every branch (`N refs`), footer `reviewing: feature · ↵ compare · Esc cancel`. Selection starts on the **default branch** (`master`). The `feature` row is **dimmed and unselectable** — `↑`/`↓` skip it and `Enter` does nothing (a branch can't be its own base).
- [ ] **Steps:** Type a few characters of a branch name.
- [ ] **Expect:** The list filters (substring, case-insensitive) and the count updates; `Esc` closes the picker.
- [ ] **Steps:** Reopen and `Enter` on `master`.
- [ ] **Expect:** The picker closes and the diff buffer shows `master...feature`, with `merge-base <sha> → <sha>` and the changed-file count in the header. The comparison segment turns violet: `⇄ master...feature`.
- [ ] **Expect:** The files are `feature`'s work only: `kept.txt` modified, `Extra.java` added, `gone.txt` deleted, `logo.bin` binary. **`base-only.txt` is absent** (merge-base semantics) and so are the dirty working-tree changes and untracked `fresh.txt`.
- [ ] **Expect:** No file shows the green staged `●` — committed history has no staging state.

### 5.2 Switching the review branch re-targets the comparison
- [ ] **Steps:** While showing `master...feature`, `Space g s` → `Enter` on `merged`.
- [ ] **Expect:** The diff becomes `master...merged` without asking for a base again — same base, new target — and the status bar shows `review: merged` plus `⇄ master...merged`.
- [ ] **Steps:** `Space g s` → `Enter` on `master` (the comparison's own base).
- [ ] **Expect:** Instead of comparing `master` to itself, the view drops back to the **working-tree diff** (`review: master`, an `⎇ master` comparison segment, staged `●` markers back).

### 5.3 Errors stay inline
- [ ] **Steps:** Create a branch with unrelated history (`git checkout --orphan lonely && git commit -qm x --allow-empty && git checkout -q master`). Put `lonely` under review (`Space g s`), then `:compare` against `master`.
- [ ] **Expect:** A red message in the footer (`… have no common ancestor`), the picker **stays open**, and the previously shown comparison is still intact behind it.

### 5.4 Remote-tracking branches
- [ ] **Steps:** Open `/tmp/air-clone` and press `Space` → `g` → `s`.
- [ ] **Expect:** Locals are listed first, then `origin/…` rows badged `remote` (violet). **`origin/HEAD` is not listed** (it's an alias). `master` is marked `default`.
- [ ] **Steps:** Put `origin/feature` under review, then `:compare` against `master`.
- [ ] **Expect:** Works exactly like a local branch; the header shows `master...origin/feature` and the status bar `review: origin/feature` in amber.

### 5.5 A repo with no branches
- [ ] **Steps:** `mkdir /tmp/air-empty && git -C /tmp/air-empty init -b master` (no commits), then open it.
- [ ] **Expect:** No `⎇` segment. In the palette, `compare …` and `review a commit …` are **dimmed** and labelled `(no branch to review)`; `:compare` and `:log` do nothing.

### 5.6 Marks are scoped per comparison
- [ ] **Steps:** In `master...feature`, mark the `kept.txt` hunk reviewed (`r`). Note the status-bar count.
- [ ] **Steps:** `Space` → `g` → `w` (or `:worktree`) to return to the working-tree diff.
- [ ] **Expect:** The header/comparison segment return to the plain branch name; `kept.txt`'s working-tree hunk is **not** reviewed even though it covers the same file and lines.
- [ ] **Steps:** Mark that working-tree hunk reviewed, then compare again (`Space g b` → `master`).
- [ ] **Expect:** Both marks exist independently — each comparison shows only its own. Repeat with another review branch against the same base (`master...merged`) to confirm pairs don't bleed into each other.
- [ ] **Steps:** Restart the app, reopen the repo, put `feature` under review and compare against `master`.
- [ ] **Expect:** The branch marks are still there (opening the repo starts on the **working-tree** diff, as designed).

### 5.7 Scoped clear
- [ ] **Steps:** With marks in both comparisons, switch to `master...feature` and run `:clear`, confirm with `y`.
- [ ] **Expect:** The dialog title names the comparison (`Clear tags for master...feature?`) and the body says other comparisons keep theirs. After confirming, the branch marks are gone and the **working-tree** marks are untouched (switch with `Space g w` to verify).

### 5.8 Committing is disabled in branch mode
- [ ] **Steps:** While comparing branches, open the palette (`Space` → `g`).
- [ ] **Expect:** `commit reviewed changes` is **dimmed/disabled** and labelled `(working-tree diff only)`; `Space g c` does nothing. Typing `:commit` likewise refuses.
- [ ] **Steps:** Return to the working-tree diff (`Space g w`).
- [ ] **Expect:** `:commit` works normally, and only the **working-tree** reviewed marks are staged — branch marks never contribute.

### 5.9 Project mode reads the compared revision
- [ ] **Steps:** In `master...feature`, put the cursor on a `kept.txt` hunk and press `Enter`.
- [ ] **Expect:** The project viewer shows `feature`'s content (the line reads `BRANCH`), **not** the dirty working tree. The modeline shows the path followed by a violet `@ feature@<sha>`.
- [ ] **Steps:** Navigate to the deleted `gone.txt` and press `Enter` on it.
- [ ] **Expect:** The file opens from the **merge base** — the modeline reads `@ master@<sha> (merge-base)` — instead of failing because the path is gone from the working tree.
- [ ] **Steps:** With a branch comparison active, browse the project tree and run `Space f` (fuzzy find).
- [ ] **Expect:** Both list the **revision's** files: `Extra.java` is present, and the untracked `fresh.txt` is absent. `gd`/`gr` in a Java file resolve against that same revision.
- [ ] **Steps:** Switch back to the working-tree diff (`Space g w`).
- [ ] **Expect:** The modeline revision badge disappears, the tree/finder show the working tree again (`fresh.txt` reappears), and the previously open file is cleared.

### 5.10 Refresh follows the branch
- [ ] **Steps:** While comparing `master...feature`, add a commit to `feature` in a terminal (`git -C /tmp/air-fixture branch -f feature <new sha>`, or check it out, commit, and come back), then press `Space` → `r`.
- [ ] **Expect:** `later.txt` appears in the diff, the header's target sha updates, existing marks re-anchor (not stale), and the project buffer's revision badge shows the new sha.

### 5.11 Nothing is mutated
- [ ] **Steps:** Before comparing, run `git status --porcelain=v1 --branch` in the fixture and save the output. Do a full session (switch the review branch several times, compare, mark, clear), then run it again.
- [ ] **Expect:** Identical output — the checkout, index, and working tree are untouched throughout, including by `:checkout`.

### 5.12 Empty comparison
- [ ] **Steps:** `git branch twin feature`, put `feature` under review, then compare against `twin`.
- [ ] **Expect:** The empty state says **"no changes between twin and feature"** — *not* "working tree clean" — and the fake terminal shows `git diff --stat twin...feature` rather than `git status`.

---

## 6. M6 — Commit review

> Uses the fixtures from §0 (including the §6 additions).

### 6.1 Open the picker
- [ ] **Steps:** Open `/tmp/air-fixture`, put `feature` under review (`Space g s`), then press `Space` → `g` → `l` (or `:log`).
- [ ] **Expect:** A **Review a commit** picker over **`feature`'s** history — no branch stage. Footer: `on feature · ↵ review commit · Esc cancel`. Rows are newest-first: amber short oid, subject, then author and a relative age (`3m ago`); the commit `HEAD` points at is badged `HEAD` (green). Count reads `N commits`. Selection starts on the **newest** commit.
- [ ] **Steps:** `Esc`, switch the review branch to `master`, and reopen.
- [ ] **Expect:** The history now lists `master`'s commits (`master work` on top) — the picker always follows the review branch.

### 6.2 Review a commit
- [ ] **Steps:** Put `feature` back under review and open the picker.
- [ ] **Steps:** Type `feature` (or part of the author name).
- [ ] **Expect:** Rows filter on oid + subject + author, case-insensitive.
- [ ] **Steps:** `Enter` on `feature work`.
- [ ] **Expect:** The picker closes; the header reads `<sha> feature work` with `parent <sha> → <sha>` and the changed-file count. The status bar segment turns violet: `⊙ <sha> feature work`; hovering it names the range, the branch, the subject and the author.
- [ ] **Expect:** The files are that commit's own work: `kept.txt` modified, `Extra.java` added, `gone.txt` deleted, `logo.bin` binary. **`base-only.txt` is absent** (it's on master, not in this commit), as are the dirty working-tree changes and untracked `fresh.txt`.
- [ ] **Expect:** No file shows the green staged `●`.
- [ ] **Steps:** Tag a hunk reviewed (`r`), a line range flagged (`v j` then `f`), and a hunk ignored (`i`).
- [ ] **Expect:** Sections behave exactly as in the working-tree diff (§1.5b / §2).

### 6.3 A merge commit is reviewed against its first parent
- [ ] **Steps:** Put `merged` under review (`Space g s`), then `Space g l` → `Enter` on `merge feature`.
- [ ] **Expect:** The row was badged `merge` (violet). The header says `first parent <sha> → <sha>`, and the diff shows the work merged **in** from `feature` (`Extra.java`, `kept.txt`, …) — but **not** `base-only.txt`, which the first parent already had.

### 6.4 The root commit reads as all additions
- [ ] **Steps:** With `master` under review, `Space g l` → `Enter` on the oldest commit (`initial`).
- [ ] **Expect:** Every file is status `A` with no removed lines, and the header reads `root commit <sha>` (no parent).

### 6.5 The review branch is unaffected by the commit choice
- [ ] **Steps:** While reviewing a commit of `feature`, check the status bar, then `Space g s` → `Enter` on `merged`.
- [ ] **Expect:** `review: feature` throughout the commit review (the review branch is where the commit came from), and switching to `merged` **leaves the commit diff on screen** — a commit belongs to no branch in particular, so there is nothing to re-target. Only the `review:` segment changes.
- [ ] **Expect:** Reopening `:log` now lists `merged`'s history.

### 6.6 Typing a sha reaches outside the list
- [ ] **Steps:** In the picker, type the full or abbreviated sha (≥4 hex chars) of a commit **not** on the review branch — e.g. `master`'s `master work` while reviewing `feature`.
- [ ] **Expect:** When no listed commit matches, a single row appears: the typed sha with an italic `resolve this revision…`. `Enter` reviews that commit.
- [ ] **Expect:** The header shows the resolved commit, and the status-bar tooltip mentions **no branch** (a typed sha carries no branch context).
- [ ] **Steps:** Type a sha that doesn't exist (e.g. `abcdef1`) and press `Enter`.
- [ ] **Expect:** A red inline error (`unknown revision …`); the picker stays open and the previous comparison is intact behind it.

### 6.7 Marks are scoped per commit
- [ ] **Steps:** With `feature work`'s `kept.txt` hunk reviewed (from §6.2), switch to the working-tree diff (`Space g w`).
- [ ] **Expect:** `kept.txt`'s working-tree hunk is **not** reviewed, even though it covers the same file and lines.
- [ ] **Steps:** Compare against `master` (`Space g b`) — with `feature` under review this is `master...feature`, a diff that looks identical to §6.2's.
- [ ] **Expect:** The branch pair shows **no** marks: a branch review and a commit review are separate scopes even when the diff on screen is the same.
- [ ] **Steps:** Review a hunk there, then go back to the commit (`Space g l` → `feature work`).
- [ ] **Expect:** Each comparison shows only its own marks. Restart the app, reopen the repo, and return to the commit — its marks are still there (a fresh open starts on the working-tree diff, as designed).

### 6.8 The same commit from another branch is the same review
- [ ] **Steps:** With marks on `feature work`, switch the review branch to **`merged`** (`Space g s`) and pick the same `feature work` commit from its history (it is reachable from both).
- [ ] **Expect:** The marks are **already there** — the review is keyed to the commit's oid, not the branch it was picked from — and folds/cursor are not reset.

### 6.9 Marks outlive the branch
- [ ] **Steps:** With marks on `feature work`, delete the branch it was picked from in a terminal: `git -C /tmp/air-fixture branch -D feature`. Reach the commit again through `merged` (it's still in that history) or by typing its sha, then `Space r`.
- [ ] **Expect:** The marks are intact and **not stale** — a commit can't move, so losing the branch changes nothing. (Recreate it afterwards for the other sections: `git -C /tmp/air-fixture branch feature <sha>`.)

### 6.10 Scoped clear
- [ ] **Steps:** With marks in the commit and in the working tree, review the commit and run `:clear`, confirm with `y`.
- [ ] **Expect:** The dialog title names the comparison (`Clear tags for <sha> feature work?`). After confirming, the commit's marks are gone and the working-tree marks are untouched (`Space g w` to verify).

### 6.11 Committing is disabled while reviewing a commit
- [ ] **Steps:** While reviewing a commit, open the palette (`Space` → `g`).
- [ ] **Expect:** `commit reviewed changes` is **dimmed/disabled** and labelled `(working-tree diff only)`; `Space g c` does nothing and `:commit` refuses with "This comparison is committed history already".
- [ ] **Expect:** `working-tree diff` (`g w`) is **enabled** here.

### 6.12 Project mode reads the reviewed commit
- [ ] **Steps:** Reviewing `feature work`, put the cursor on a `kept.txt` hunk and press `Enter`.
- [ ] **Expect:** The viewer shows that commit's content (the line reads `BRANCH`), **not** the dirty working tree. The modeline badge reads `@ feature@<sha>` (or just `<sha>` for a commit reached by typing a sha).
- [ ] **Steps:** Press `Enter` on the deleted `gone.txt`.
- [ ] **Expect:** It opens from the commit's **first parent** — modeline `@ <sha> (parent of <sha>)` — instead of failing because the path is gone.
- [ ] **Steps:** Browse the tree, run `Space f`, and use `gd`/`gr` in a Java file.
- [ ] **Expect:** All three read that commit's revision: `Extra.java` present, untracked `fresh.txt` absent.
- [ ] **Steps:** `Space g w` back to the working tree.
- [ ] **Expect:** The revision badge disappears, the tree/finder show the working tree again, and the open file is cleared.

### 6.13 Refresh is stable
- [ ] **Steps:** While reviewing a commit, press `Space` → `r`.
- [ ] **Expect:** The same diff and the same header sha (a commit is immutable); marks stay put and are not stale. Adding new commits to the branch in a terminal changes nothing here.

### 6.14 Empty commit
- [ ] **Steps:** Put `empties` under review, then `Space g l` → `Enter` on `an empty commit`.
- [ ] **Expect:** The empty state says **`<sha> changes nothing`** — not "working tree clean" — and the fake terminal runs `git show --stat <sha>` followed by the commit's subject.

### 6.15 Nothing is mutated
- [ ] **Steps:** Save `git status --porcelain=v1 --branch` before a full commit-review session (pick several commits, mark, clear, open files in project mode), then compare after.
- [ ] **Expect:** Identical output — the checkout, index, and working tree are untouched throughout.

---

## 7. Regression sanity
- [ ] App builds: `npm run build` (frontend) and `cd src-tauri && cargo test` (backend, all green).
- [ ] No console errors in the dev tools during normal use.
- [ ] Theme/contrast readable; long file paths truncate rather than overflow.
- [ ] Cross-buffer flow: open repo → review/flag in diff → `Space f` to a file →
      `gd`/`gr` to navigate → flag in project mode → all marks persist after restart.
- [ ] Comparison flow: worktree → `Space g b` compare → review → `Space g w` back →
      marks stay separate, project mode follows the revision, nothing is staged.
- [ ] Three-mode round trip: `Space g s` pick a review branch → `Space g b` compare it
      against a base → `Space g l` one of its commits → `Space g w` back to the worktree.
      Each mode keeps its own marks, header, comparison glyph (`⎇` / `⇄` / `⊙`) and project
      revision; only the worktree allows `:commit`; `git status` is unchanged throughout.
