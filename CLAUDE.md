# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**review-me** is a Tauri v2 desktop tool for reviewing code produced by LLM agents:
a magit-style, vim-driven UI over a git diff — working-tree-vs-HEAD, a
`base...target` branch comparison, or a single commit vs its first parent, entered from a
magit-style commits buffer — with reviewed/flag tagging, review notes exported as
Markdown for an LLM to act on, a fuzzy file finder,
an IDE-like project mode, and tree-sitter cross-references.
The stack deliberately mirrors the sibling app at
`/home/mms/development/projects/video-studio` (buffer model, `NeoPicker`, Zustand) —
consult it when a pattern here looks unfamiliar. The UX has since gone its own way: its
Space palette, `:` command line and centered pickers became an Emacs-style `M-x`
minibuffer here (see "Commands and keys" below).

## Commands

```bash
npm run tauri dev          # run the desktop app (Vite on :1420 + Tauri window; needs a display)
npm run build              # frontend gate: tsc (strict) THEN vite build — run before committing FE
cd src-tauri && cargo test # backend tests (all logic modules have unit tests w/ tempfile fixtures)
cd src-tauri && cargo test diff::tests::marks_staged_files   # single test
cd src-tauri && cargo check                                  # fast backend typecheck
./packaging/build-ubuntu.sh # .deb for Ubuntu 22.04+, built in Docker (see README)
```

There is no linter/formatter configured (matching video-studio); TypeScript runs in
strict mode with `noUnusedLocals`/`noUnusedParameters`, so dead code fails the build.

## Architecture

Two halves talk only through Tauri IPC. The request flow for every feature:

```
React component → src/lib/*.ts action → invoke() wrapper in src/lib/tauri.ts
   → #[tauri::command] in src-tauri/src/commands.rs (thin) → feature module (logic)
```

**Backend (`src-tauri/src/`)** — small feature modules; `commands.rs` is a thin wrapper
layer and `lib.rs` is the module list + `invoke_handler!`. Each command is **stateless**:
it receives `repo` (the repo root path), opens the repo fresh via `repo::open` (cheap
with libgit2), and returns. The one exception is `xref.rs`, which caches a parsed
symbol index in a global `Mutex`.
- `repo.rs` open/validate, `RepoInfo` (incl. `review_branch_ref`, the branch the UI starts reviewing). `branches.rs` local/remote ref discovery + `resolve()` → (base tip, target tip, merge base).
- `commits.rs` `list(repo, ref, skip, limit)` → a newest-first page of `CommitInfo`s, each with its ref `Decoration`s (filled by `list` only), and `resolve(repo, rev)` → (oid, **first** parent oid, info, full message). Any revision resolves (full oid, abbreviation, `HEAD~2`), but only full oids may reach a `DiffSpec`/`ReviewScope`.
- `diff.rs` `compute(repo, &DiffSpec)` → `DiffSummary { comparison, files }` (`ChangedFile`/`Hunk`/`DiffLine`). See "Comparisons" below.
- `revision.rs` `ProjectSource` (worktree | commit) and tree-backed content/listing/file-list reads.
- `tags.rs` review/flag persistence + **anchoring** (see below). `tree.rs` ignore-aware dir listing that **compacts single-folder chains**: a folder holding only one folder is one entry (`name` `java/com/acme`, `path` the deepest folder, which is what expanding it lists) — the changed-files view (`buildChanged`) does the same, and parent navigation climbs to the nearest listed ancestor. `fuzzy.rs` nucleo-matcher file ranking.
- `coverage.rs` review progress over a computed diff (`summarize`, `commit_reviews` for the log's rows) and the covers/overlaps helpers `review_commit.rs` stages by — the Rust twin of `src/lib/coverage.ts`; keep the two in step.
- `counterpart.rs` test ↔ code by naming convention (`FooTest.java` ↔ `Foo.java`, `foo.test.ts`, `test_foo.py`, `foo_test.go`, `__tests__/`) for `C-x 4 t`: `rank` is pure (closeness = same folder with role folders like `test`/`main` set aside, then shared tail, then shared head) and says whether its best is `decisive`.
- `notes.rs` the Markdown export of review notes (see "Notes" below). `review_dir.rs` owns `.review-me/`: every write goes through `ensure`, which also adds it to `.git/info/exclude`.
- `queries.rs` + `xref.rs` tree-sitter symbol index and find-definition/references.
- `window.rs` builds the main window in `setup` (`tauri.conf.json` has it `"create": false`) so decorations can follow the desktop: off on tiling compositors, on elsewhere, `REVIEW_ME_DECORATIONS` overrides.

**Frontend (`src/`)** — Emacs's model: a **frame** (`AppShell`'s `Frame`) holds the
**windows** (`Window`), each showing one **buffer** (`state/windows.ts`'s `BufferKey`):
`"diff"`, `"log"`, `"help"`, or the **project buffer** — an open file (`file:<n>`,
`state/files.ts`), or `"project"` with none open ("no file open"). The project buffer is
what it always was — the file tree (`ProjectTree`) fixed at the left, the viewer beside
it — and the tree exists **only there**: project mode (`inProjectMode`) is the main window
(the first in the layout) showing the project buffer. The diff, the log and help — and the
diff with a file opened beside it by `o` — never show the tree (it stays mounted, hidden,
keeping its cursor and folds). `C-x b project` / `M-x project` (`showProject`) switch the
main window to it — the file it last showed, else "no file open" — with the keyboard where
it was left (`projectPane`: tree or viewer); `q` in the tree or a file (`showDiff` /
`quitFile`) goes back to the diff, except that a window split off beside it closes.
**Switching to the diff from project mode gives it the whole frame**, as magit's status
takes it (`showDiff` — `q`, `M-x diff`, `C-x b diff`, `M-,`, entering a commit — and
`C-x ←`/`→`): `takeFrame` stashes the project's windows (`useWindowStore.stash`), and any
way back to the project buffer — `M-x project`, RET on a file, `C-x b`, `M-,`, `C-x ←` —
puts them back through `display`/`stepBuffer`'s `bringBackProject` (`unstash`), going to
the window that already shows the file if one does. Files killed meanwhile leave their
windows as `forget` has them; back in project mode any other way, the stash is dropped (a
store subscription keeps it only outside project mode). `C-x 4 b diff` still shows the diff
beside the file. A file
opened by a plain gesture (RET in the diff, the finder, the tree, a definition) goes to
`targetWindow()`: the selected window when it's in the project buffer or reading a file,
else the main window — so from the diff or the log it opens the project buffer, as it
always has. `useWindowStore` holds what each window shows, what it showed before (`prev`,
where help's `q` — `quitWindow` — and `C-x ←` go back to), what `C-x ←` stepped back from
(`ahead`, where `C-x →` goes), the selected window, `treeFocused`, and `recent` (`C-x b`'s
order); which kind of buffer has the keyboard (`activeBuffer`: diff/log/help, or `project`
for the project buffer or the tree) is derived, never stored. `DiffBuffer` and `LogBuffer` are rendered **once**, as portals into
persistent host elements that `Window`'s `BufferSlot` moves into whichever window shows
them — so their cursor, folds and scroll survive any move — and the slot carries scroll
offsets and focus across the detach/re-attach (StrictMode re-runs it in dev). Each holds
one cursor, so each shows in one window at most — showing one that another window has
selects that window instead (`lib/windows.ts`'s `display`, Emacs's reuse-window). Help
renders in its window; a file renders as a `FileView` (CodeMirror) per window, so one file
can be in two windows with two cursors. Every switch goes through `lib/buffers.ts`
(`showBuffer`, `openHelp`, `quitWindow`, `killCurrentBuffer`, `stepBuffer`), every
window operation through `lib/windows.ts`.

**Windows** split as Emacs's do: `useWindowStore.layout` is a tree of `split`s (`row` side
by side, `column` stacked, a draggable `ratio`) over window ids, and `WindowArea` places
each window absolutely by its tile rather than nesting it, so a split or a close never
remounts the others. `C-x 3` / `C-x 2` split (a file shows in both halves, at the same
place; a single-cursor buffer can't, so the new half gets the most recent buffer not on
screen), `C-x 0` / `C-x 1` close, `C-x o` cycles (the tree first, in project mode), `C-w h/j/k/l` moves by
screen position (`windmove`, the tree counts as the leftmost). **"The other window"**
(`otherWindowFor`, every `C-x 4` command, `o` in the diff/log/tree, `C-o` in the diff
which shows without selecting) is one already showing the buffer, else the next window,
else a new one split off to the right — so `C-x 4 .` from a test opens the code beside
it, and `C-x 4 t` back from the code just returns to the test's window. `q` in a window
with nothing to go back to (one split off to show something) closes it. The selected
window wears an amber top edge when there are several; a click or focus anywhere in a
window selects it, and a Ctrl+click selects its window before resolving.
The frame's last line is **`Minibuffer.tsx`**: the echo area (`useUIStore.flash`, and
`keyEcho` for a half-typed `C-x-`) while idle, the minibuffer while something is read
(`state/minibuffer.ts`: `command` for `M-x`, `buffer` for `C-x b`, `text` for a prompt,
`confirm` for a `y` / `n` question — Emacs's `y-or-n-p`).
It sits under the mode line (`BufferStatusBar`) and grows upward.

**Commands and keys are Emacs-style; there is no `:` command line and no Space palette**
(the user removed both). A single **`components/useCommands.ts`** registry (typed
`CommandId`s, a `buffer` scope) feeds `M-x`. **`lib/keymap.ts`** is the one table of key
bindings, in Emacs notation (`C-x C-f`, `M-.`, `RET`, `g g`), per scope (`global`,
`start`, `diff`, `log`, `tree`, `viewer`, `help`, `minibuffer`, `editor`), and it drives
three things that therefore can't drift: dispatch, the key column in `M-x`, and the help
buffer (`C-h b`, `C-h m`; `C-h k` describes a key in the echo area). Dispatch lives in
`lib/key-dispatch.ts`: every dispatcher feeds one shared pending sequence (`feedKey`), so
`C-g` quits it whoever started it and a dead end echoes `… is undefined`.
- Global keys (`M-x`, `C-x …`, `C-h …`) are read on the window by `AppShell`'s
  `GlobalKeys`, skipped while a modal or the minibuffer is up (`modalDepth`) or text is
  being typed — a CodeMirror editor counts as typing only in vim insert mode.
- Buffer keys go through each buffer's `onKeyDown` → `dispatchKey(scope, e, KEYMAP[scope],
  handlers)` with a typed `Record<…Action, KeyHandler>`, so an action nothing handles
  fails the build; a handler returning `false` lets the key go on.
- The viewer's keys are a CodeMirror keymap built from the table
  (`editor/viewer-keymap.ts`) — except `vim: true` entries (`q`, `] c`, `[ c`, `] f`,
  `[ f`, `r`, `!`, `u`), which `editor/vim-nav.ts` maps as vim commands, because a
  sequence vim also uses (`]]`, `[(`) must reach vim whole; they stay in the table for
  help and `C-h k`, and get vim's count (`3]c`). `visual: true` ones are mapped in visual
  mode too: the handler is told so, reads the selection, and vim-nav then ends it. The note and commit editors read `C-c C-c` / `C-c C-k` in a
  capture handler on the dialog, before vim sees them (vim's own `:wq`/`:q` stay).
- New command: give it an `M-x` name; give it a key only if it's used often, in Emacs
  conventions. Rare or destructive ones stay `M-x` only (`show`, `note`, `export`,
  `clear`, …).

**Type and color** come from tokens in `styles.css`'s `:root`; never write a px font size
or `--fg-3` for text. Three sizes derive from one base, `--fs` (16px), which
`lib/text-scale.ts` scales (`C-x C-=` / `C-x C--` / `C-x C-0`, then `=` `-` `0` repeat via
`key-dispatch.ts`'s `armRepeat`) and remembers in `localStorage`: `--fs` for what you read
(diff, log, viewer, minibuffer), `--fs-ui` (0.875×) for the chrome around it (tree, mode
line, headers, gutters, annotations), `--fs-sm` (0.75×) for section labels and key hints.
Nothing is bigger than the code. Dim text is `--fg-faint` (≥4.5:1 on `--bg-0`/`--bg-deep`)
or `--fg-dim` (also on `--bg-1`: the tree, headers, pickers); `--fg-3` is 2:1, for rules.

**Paths** are what a reviewer reads, and the file name is the part that matters, so a
path is never cut on the right. `components/PathLabel.tsx` draws one with the folders
dimmed and the name bright: `wrap` (diff rows, the viewer header, the note editor) breaks
between folders (`<wbr>` after each `/`); `elide` (the mode line) keeps the name whole and
shortens the folders from the left (`direction: rtl` + `<bdi>`). Renames are written
git-style, `src/{model/Item.java → catalog/CatalogItem.java}` (`renameParts`). Lists that
need their own markup follow the same rule: the finder and xref put the name first and
left-elide the folders. The mode line describes the selected window: it names the file under
the cursor (`useUIStore.diffCursor`, or the window's file), and its branch labels give way
before it does. `C-x b` writes open files Emacs-uniquify style (`bufferNames`:
`Item.java<model>`, `Item.java<9fceb02>`) with a name column as wide as the longest.

The pickers (open-repo, recent, fuzzy, checkout-branch, branch-compare, commit-pick) are
`NeoPicker`s, which render **docked at the bottom as a minibuffer** — prompt line (count,
`Title:`, input, a hint) over the candidates, in the layout so they push the buffers up —
and xref's results use the same layout; the echo area steps aside while one is open
(`Minibuffer`'s `DOCKED_PICKERS`). What needs a decision or an editor stays a centered
modal (`asset-picker`): the clear confirmation, the commit dialog, the note editor. All
are gated by `useUIStore.picker` or a dedicated store and use `useModalFocus` (which is
what turns the global keys off while they're up).

**State** is Zustand in `src/state/` (`ui`, `windows`, `files`, `minibuffer`, `repo`, `tags`, `log`, `notes`, `project`, `xref`, `history`). Cross-cutting
conventions that will bite if ignored:
- **Wire format:** Rust structs are `#[serde(rename_all = "camelCase")]`; `AppError`
  serializes to a string. serde emits `null` for `Option::None`, so TS types use `| null`
  (not optional `?`).
- **Selectors must not return fresh `[]`/`{}`** — use module-level `EMPTY_*` constants
  (Zustand infinite-rerender trap).

### The branch under review

`useRepoStore.reviewBranch` (`ReviewBranch { ref, display }`) is the app's own notion of a
checkout and the **single place a branch is chosen**: `M-x compare` collects only a base and
targets it, the commits buffer (`M-x log`) lists the commits it introduced over that base.
It is seeded on open from `RepoInfo.reviewBranchRef` (HEAD's branch, else the repo's
default branch, else `None` — a repo with no branches disables `M-x compare`, and the log
lists `HEAD`) and changed by `M-x checkout` (`CheckoutBranchHost`).

It is **app-level only**: nothing fetches, checks out, stages, or writes to the working
tree, so a branch that isn't checked out reviews like any other. Worktree mode still means
the real checkout — that's why the status bar shows the review branch separately and turns
it amber when the two differ.

`lib/open-repo.ts`'s **`switchReviewBranch`** re-targets an active branch comparison so the
concept stays live (same base, new target), falling back to the worktree diff when the new
branch is that comparison's own base. A commit comparison is left alone: a commit belongs
to no branch in particular, which is also why `DiffSpec::Commit.branchRef` is display-only.

### Comparisons

`DiffSpec` (mirrored in `src/types/diff.ts`) selects what the diff buffer shows:
`{kind:"worktree"}`, `{kind:"branches", baseRef, targetRef, strategy:"mergeBase"}`, or
`{kind:"commit", oid, branchRef}`. Two naming invariants hold **everywhere** — requests,
`Comparison` metadata, and persisted review scopes: refs are **canonical**
(`refs/heads/x`, `refs/remotes/origin/x`) so a local `x` and `origin/x` are never
confused, and commit oids are **full 40 chars** so an abbreviation can't split one
commit's review in two (resolve typed revisions via `resolve_commit` *before* building a
spec). Commit mode's `branchRef` is display context only: it is excluded from `sameSpec`
and from `ReviewScope`, so the same commit reached from two branches is one review.

Branch mode diffs the merge-base tree against the target tree; commit mode diffs the
commit's tree against its **first parent's** (a merge is never a combined diff; a root
commit has no old tree, so everything reads as added). Neither **ever** touches the
checkout, index, or working tree, and `ChangedFile.staged` is `None` in both. Binary
detection differs by mode: worktree probes HEAD's blob + the file on disk
(`path_change_is_binary`), while both committed-history modes probe the delta's own blobs,
because the revision under review usually isn't checked out.

`readsCommittedHistory(spec)` in `types/diff.ts` is the "not the worktree" test — use it
rather than checking for `branches` when the point is that nothing here can be staged.

`src/lib/open-repo.ts`'s **`applyComparison(spec)`** is the single loading path: it
computes the diff and loads that scope's tags, then commits both to the stores at once
(retaining the previous comparison on failure) and drops stale in-flight responses via a
request ticket. `useRepoStore.comparison` is the applied spec; `comparisonEpoch` bumps
when its identity changes, which resets folds and the diff cursor. Opening a repo always
resets to worktree; `refresh` recomputes whatever is applied (a branch pair can move under
it; a commit spec is immutable, so only its tags are re-read).

### The commits buffer

`LogBuffer.tsx` (buffer `"log"`) lists **the commits the review branch introduced** as a
magit-status-style list — Head/Review/Base/Changes lines, then the commits with
decorations — and is the way into commit review: `Enter` calls `open-repo.ts`'s
**`enterCommit`** (applies a commit spec, switches to the diff buffer), `b` calls
**`enterLogRange`** (the whole listed range as one `base...branch` comparison), and `q` in
the diff buffer calls **`leaveHistory`** for either (back to the log, refresh a left
commit's row, re-apply the worktree comparison so the diff buffer and project mode mean
the current changes again). Staying mounted is what puts you back on the same row; the
cursor is tracked by **oid**, so reloads don't move it.

What is listed is `commits::resolve_range(ref, base)` — shared with `M-x export`, so the
export covers exactly the log's commits — which yields a `LogRange`:
- `unmerged` — `base..ref`, also hiding the base's upstream (a stale local `master`
  mustn't leak `origin/master`'s commits in). An empty result is a real answer
  ("no commits beyond master"), not a reason to fall back.
- `unpushed` — `upstream..ref`: the base is the branch's upstream, where an empty result
  is a real answer too ("no commits beyond origin/x"); or the base names the branch
  itself (reviewing `master`) and something is ahead of its upstream.
- `all` — no base, or its own base with no upstream or nothing ahead of it.

The base is **`useRepoStore.reviewBase`**: seeded on open from `RepoInfo.reviewBaseRef`
(`branches::review_base_ref`: the review branch's upstream, else the default branch),
followed to the new branch's on `M-x checkout` (`switchReviewBranch`, via the
`review_base` command), and replaced for good by whatever `M-x compare` picks
(`chooseReviewBase` sets `reviewBaseChosen`; it reloads the log) so the log and the
branch diff always share one base. `M-x show`'s picker passes no base — it is for the
whole history.

`useLogStore` holds the listed `ref` (`lib/log.ts`'s `logRef()`: the review branch, else
`HEAD`) and `base` (`logBase()`) — a change to either is a different list — the `range`
the backend resolved, the pages loaded so far, and `reviews` by oid. `loadLog` reloads
page one and is called whenever the log is shown, on `refresh`, and when the review
branch or its base changes; `loadMoreLog` pages (`skip`) as the cursor or scrollbar nears
the end. Row progress comes from `commit_reviews`, which only computes a diff for commits
with a mark in their scope (`tags::marked_scopes`) — an untouched history costs nothing.

`openRepoByPath` lands on the log when the freshly applied worktree diff is empty (and
the repo has a HEAD); a dirty tree lands on the diff buffer. Only *opening* chooses — a
refresh never moves you, which is why the diff buffer's clean state still exists.

### The diff buffer is NOT CodeMirror

`DiffBuffer.tsx` is a custom keyboard-navigable HTML list (magit-status), driven by its
own `onKeyDown` over a flattened `Row[]` (file/hunk/line) — its keys, sequences like
`g g` and `] h` included, are `keymap.ts`'s `diff` scope — and a `visualAnchor` for `v`
selection. Line rows carry **intra-line word-diff** segments (`lib/word-diff.ts`: pairs
each removed line with the added line that replaced it, LCS over tokens) — on by default;
`M-x diffmode` toggles `useUIStore.diffHighlight` between `word` and whole-`line`. Only the
**file viewer** (`FileView.tsx`) uses CodeMirror (read-only + vim + per-file syntax
highlighting lazy-loaded by extension via `@codemirror/language-data`).

**One row ≠ one visual line.** Line content wraps (`pre-wrap` + `overflow-wrap: anywhere`
in `styles.css`) rather than truncating, so a row can be several lines tall: keep gutters
`align-items: start`, and measure a *visual* line from the list's computed `line-height`
(what `scrollByLine` does for `Ctrl-e`/`Ctrl-r`) instead of a row's `offsetHeight`.

### Tagging & anchoring (the subtle part)

Reviewed/flag/ignore tags live in `<repo>/.review-me/tags.json` (three parallel arrays:
`reviewed`, `flags`, `ignored`), anchored by `[startLine,endLine]` + sha256 of those
lines + context lines. Each anchor carries a **`side`** (`AnchorSide`) and a
**`scope`** (`ReviewScope`).

`side`: `new` anchors to the new side (added/modified hunks, the default), `old` to the
old side (pure-deletion hunks + deleted text files), `file` to a whole binary-file change
identified by `old:new` blob oids (line numbers unused).

`scope`: `worktree`, `{branches, baseRef, targetRef}`, or `{commit, oid}` — **which
comparison the mark belongs to**. `tags::load(root, scope)` returns *only* that scope's
tags, so identical paths and line ranges stay isolated across comparisons — including the
pair that renders identically, a branch pair and that branch's tip commit. Dedup,
`unmark_range`, and `clear_scope` are all scope-filtered. Both fields
`#[serde(default)]`, so pre-existing tags load as new-side worktree marks unchanged. A
commit scope holds the oid alone (never the branch it was picked from), which makes it the
most stable scope there is: deleting that branch leaves every mark live.

The scope also decides **what content the anchor hashes**: `tags.rs`'s `Snapshot` reads
the working tree + HEAD for worktree scope, the merge-base + target trees for a branch
scope, and the first-parent + commit trees for a commit scope; it is shared by
`build_anchor` and `reanchor` so they can't disagree. `Snapshot::Trees.old` is `Option`
because a root commit has no old side — absence there is *definitive* (so `readable` still
answers true), unlike a snapshot that can't be resolved at all. `load`
re-anchors by side: exact hash at the stored position → else a ±200-line search → else
`stale: true`. A snapshot that *can't read* a side (no repo; a branch or commit that no
longer resolves) leaves the anchor untouched rather than declaring it stale on missing
evidence; an anchor whose captured hash is empty has nothing to verify and stays live.
The frontend sends `(scope, file, startLine, endLine, kind, side)`; the backend computes
the hash/context so add and re-anchor stay consistent. "Reviewed" is fundamentally per-unit (text hunk, on whichever side, or a
binary file); file/line coverage is **derived** in `src/lib/coverage.ts`
(`hunkTarget`/`isHunkReviewed`/`isFileReviewed`), not stored. The diff buffer buckets
each unit into one of four sections — To review / Flagged / Reviewed / Ignored — by
precedence **flagged > ignored > reviewed > to-review** (`sectionForHunk`/
`sectionForFile`); `r` reviews, `f` flags, `i` ignores, and `u` unmarks the current
scope. **Project mode reviews whole files only** (`lib/project-review.ts`): `r` `f` `i`
`u` in the tree and `r` / `u` in the viewer act on the file — `reviewWholeFile` /
`ignoreWholeFile` mark it unit by unit, a flag spans `fileTarget`, `unmarkWholeFile` takes
every mark on either side — while the viewer's `!` (and `M-x flag`) flags lines and `u` on
a visual selection unmarks lines. Lines are marked only on the side the buffer reads
(`sideRead`: the new side, or the old one for a deleted file); the flag tint follows the
same rule. **`u` asks first (`confirm`) whenever it would delete a note**, in every buffer,
and `addFlag` passes an existing same-range flag's note on, because `add_flag` replaces a
flag on the same lines. `review_commit.rs` stages reviewed new-side + old-side hunks via `apply` and
reviewed binary files via index add/remove; it loads **worktree-scoped tags only**, and
`M-x commit` is disabled (with a defensive guard in `CommitReviewedHost`) whenever
`readsCommittedHistory` holds — a branch pair or a single commit — where both sides are
already committed. NB: libgit2's `DiffFile::is_binary()` is
unreliable before patches are generated, so binary detection uses
`diff::path_change_is_binary` (NUL-byte heuristic over HEAD blob + working file).

`.review-me/` is review-me's own state inside the reviewed repo and must never look like
part of the project: `review_dir::ensure` (called by every write) appends `/.review-me/`
to the repo's `.git/info/exclude` — the *local* ignore file, never the project's
`.gitignore` — resolving the common git dir for linked worktrees, and `compute_worktree`
also skips untracked paths under it for repos marked before that existed.

### Notes

A **note** is a flag's `note`: a fix left for later, written while reviewing a commit.
There is no separate store — notes ride on flags, so they get anchoring, the Flagged
section and `u` for free. `M-x note` (`lib/notes.ts`) reads the diff buffer's cursor or
selection through `lib/diff-view.ts` (the diff-buffer twin of `project-view.ts`) and opens
`NoteEditorHost` on the flag found there (`flagAt`: same range, else overlapping), or on
bare lines that its first save flags (`review-actions.ts`'s `saveNote`). Existing notes
are edited in place by `set_flag_note` (same id/anchor/`createdAt`; blank clears). Notes
are commit-scope only (`notesAvailable`). The diff buffer renders each as a `note` row
under the first hunk it touches (or under the file row), and a note row's scope is its
flag's lines.

`notes.rs` exports them as Markdown, a **projection** never read back: every command
that can change a commit's flags (`add_flag_tag`, `set_flag_note`, `remove_tag`,
`clear_tags`, `unmark_range`) calls `commands.rs`'s `sync_notes`, which rewrites
`.review-me/notes/commits/<full-oid>.md` (or removes it) and `notes/README.md`; a failed
export is logged, never fatal. `M-x export` writes `notes/branches/<branch>.md` — every note
reachable from the review branch, oldest first. Rendering must stay **deterministic**
(dates from the commit, write only when content changes) so an unchanged review never
churns; excerpts are the commit's own diff lines over the note's range, or tree lines for
code the commit didn't touch, because the reader works at a later HEAD where line numbers
have drifted.

### Files are buffers, and revision-aware

`useProjectStore.source` (`ProjectSource`: worktree | commit) is the revision the tree and
the fuzzy finder list — `list_repo_dir` and `fuzzy_files` take it. `applyComparison` points
it at the target commit in branch mode (so a moved branch re-points it on refresh), at the
reviewed commit in commit mode, and at the worktree otherwise (`lib/project.ts`'s
`ambientSource`); after that it follows the revision of the file in the selected window
(`Frame`'s effect) — a deletion opened at the old side puts the tree there too, as it
always has. Changing it drops cached listings.

Opening a file never replaces another: **`visitFile(path, choice, at?)`** (Emacs's
find-file) shows the buffer already open for `(revision, path)` in `targetWindow()`, or
opens a new one (`FileBuffer`: path, its own `source`, content read by `read_file`). Each
buffer carries its revision: `openFileFromDiff` opens a deletion at the **old side's**
revision — the merge base, or the commit's first parent (`baseSource`), the only revision
containing it — as its own buffer, and xref resolves in the revision of the buffer it
starts from. The viewer's header names the revision whenever it isn't the worktree. A
buffer's id (`file:<n>`) is stable, so a buffer can be re-pointed in place: on every
`applyComparison`, `reconcileFileBuffers` keeps buffers whose revision the comparison still
reads (re-reading working-tree ones — that is the refresh), re-points ones whose revision
moved under a refresh (a branch got commits), and kills the rest — a review that's over.
Where each window stands in each buffer (cursor and top line) is remembered per
`(window, buffer)` in `lib/project-view.ts` (`placeCursor` puts a jump target there before
the view even mounts), which also keeps each window's CodeMirror view for commands that
read the selected window's cursor. `C-x k` kills the selected window's file. `C-x <left>` /
`C-x <right>` (`stepBuffer`, Emacs's previous-buffer / next-buffer) walk the selected
window's own history — back through what it showed, any buffer, then forward again (a new
switch drops the way forward); once its history runs out, back goes on through the recently
shown buffers. `<left>`/`<right>` alone repeat.

The tree's width (`useProjectStore.treeWidth`: dragged on its edge or `C-x {` / `C-x }`,
remembered, clamped so the windows keep 320px) and `treeHidden` (`M-x toggle-tree`; `C-x o`
brings it back) are layout state, not per-revision. In the project buffer `C-x o` moves
between the tree and the viewer (and on through any other windows); the tree opens files in
the selected window, and its `q` goes back to the diff.

**The tree previews; it doesn't open.** Moving its cursor onto a file (after a 60ms rest,
so holding `j` reads nothing) or clicking one calls `lib/project.ts`'s `previewFile`, and
the tree keeps the keyboard: `useWindowStore.preview` (`{win, key, under}`) lays the file
over `targetWindow()` — `Window` renders `onScreen`, not `shown` — without touching
`shown`, any history or `recent`. An open buffer for it is shown as it stands; otherwise
it is read into `useFilesStore.preview`, a buffer outside `buffers` (so `C-x b` and every
list skip it) that the next preview replaces. It opens — `adopt`, same id, so the
`FileView` isn't remounted — on `RET`/double-click (`bufferFor` adopts a matching preview)
or when focus lands in its window (`Window`'s focusin → `openPreview`, which records a
jump): a click in the file, `C-x o`, `C-w l`, `C-x 1`. That's why a plain `select` of
the preview's window keeps it (the window store's subscription drops it only when the
window shows something else, another window is selected, or project mode ends), while
`display` and `selectWindow` — something deliberately shown — clear it first.
`applyComparison` clears it too. `currentPlace` falls back to the saved position because
the covered window's own view is unmounted.

`useProjectStore.filter` (`all` | `changed`, `c` in the tree / `M-x changed`) narrows the
tree and the fuzzy finder to **the applied comparison's files** (`useRepoStore.diff`): a
commit's, a branch's, or the uncommitted ones. It is a standing preference — `setSource`
and `reset` leave it alone — so it keeps following whatever is under review. The changed
tree is synthesized from those paths (`buildChanged`), never listed from disk; the finder
passes them to `fuzzy_files` as `only`. Changed files open through `openFileFromDiff`,
so a deletion reads from `baseSource`. Xref still indexes the whole revision —
definitions mostly live in files the change didn't touch.

The viewer marks a file's changes (`editor/diff-marks.ts`): gutter signs and line
tints always, and inline diffs — removed lines as block widgets, changed words as marks —
for the blocks shown. Blocks come from `lib/project-diff.ts`'s `changeBlocks` (one per
maximal removed+added run of a hunk) and only while the buffer reads the comparison's
new side (`changeForFile`: its source must be `ambientSource`, so a file opened at
the merge base shows no marks). `] c` / `[ c` (`gotoChange`) walk a file's blocks by their
first line, `] f` / `[ f` (`gotoChangedFile`) the comparison's files in the changed-files
tree's order (`lib/changed-tree.ts`), opened at their first change; the mode line says
`change i/n` from each window's published cursor line (`useUIStore.fileLines`).
`changeBlocks` is cached per `ChangedFile`. What is shown is `useProjectStore.inlineDiff` (`M-x hunks`,
all files) XOR `inlineFlipped` (`M-x hunk`, the blocks at the cursor/selection, cleared when
the comparison changes). The changed-files view (`filter === "changed"`) always shows the
removed lines (`ShownBlock.showRemoved`); the full diff — green new lines, word marks —
still follows `M-x hunk`/`M-x hunks`. Block widgets must come from a `StateField`, never a view
plugin — CodeMirror rejects them there.

### Cross-references

`xref.rs` parses every `.java` file once into a cached index, keyed by
`(root, ProjectSource)` so a branch index never mixes in the checkout's version of a
file. The index stores syntax and *declarations* — each file's `package`/`import`s,
each type's members, supertype names, method arity, and declared types — but never
resolved edges. Everything hangs off one primitive:

```rust
resolve(index, file, node) -> Found(Target) | Ambiguous(Vec<DefId>) | Unresolved
```

Go-to-definition is `resolve` at the cursor; find-references is `resolve` at every
occurrence that matches by name. Resolution is **lazy** (per query, never at build
time), so index warm-up cost doesn't grow with it. It proceeds in three tiers:
an in-file **scope walk** for locals/parameters/catch-and-for bindings; **type
resolution** by explicit import → same package → wildcard → project-wide name; and
**member resolution**, which types the receiver via the first two, looks the member up
on that type, walks `extends`/`implements`, and splits overloads by argument count.
A member named with no receiver (`foo(..)`, a bare field) is looked up in the enclosing
types, innermost first, then in what `import static` brings in — a single import naming
it before the `.*` ones, as in Java; a name inside an `import` line resolves to the type
(or, in `import static`, the members) it spells.
Chained calls recurse through a method's declared return type. Locals aren't indexed
(too many, each visible in one method) — they're `Target::Local`, identified by byte
offset.

Failing to resolve splits into **two different answers**, and conflating them is what
makes navigation lie:

- **`External`** — resolved to something outside the project: a JDK/jar type, a member
  of one (`import static org.junit.Assert.assertEquals` included), a member absent from
  every type that could declare it when their supertype chains are fully visible, or an
  unresolvable identifier shaped like a type (`System`, `Math`). Nothing declared here
  can be the answer, so `find_definition` returns **nothing** rather than falling back,
  and `find_references` **drops** the occurrence. `books.add(..)` on a `List` must not
  land on some unrelated `add` in this repo.
- **`Unresolved`** — genuinely undecidable: `var`, generic element types, or a member
  missing from a type that extends something we can't read. Here a
  kind-filtered name match is still the best guess, so `find_definition` falls back to
  it and `find_references` keeps the hit as unconfirmed.

So **the picker only appears when resolution genuinely couldn't decide** — never for a
symbol we know isn't ours.

`find_references` name-matches first (the cheap prefilter) and resolves only the
survivors. An occurrence proved to be a *different* symbol is **dropped**; one that
can't be proved either way comes back with `confirmed: false` and is shown in a
separate section. Nothing is silently omitted — a missed caller is a worse failure than
a spurious one in a review tool. `rank` puts confirmed hits first, then same-file.

The frontend binds emacs-xref keys in the viewer (`editor/viewer-keymap.ts`, an Alt
keymap rather than vim mappings — codemirror-vim's own `C-o`/`C-i` jump list anchors
marks into a document the viewer replaces on every file open, so it can't follow a jump
across files): **`M-.`** definition, **`M-?`** references, plus
`M-x definition`/`references` (`M-,` back is global — see below). A Ctrl/Cmd+click (`editor/xref-click.ts`) also
jumps to definition; it and `M-.` both route through `xref.ts`'s
`gotoDefinitionAt(line, col)`. The index is warmed in the background on repo
open/refresh (`applyComparison`).

The viewer marks **the other occurrences of the symbol under the cursor** once it rests
there (`editor/occurrences.ts`). In Java the index answers (`xref::occurrences`:
find-references' drop rule over one file, so a field and a same-named local stay
apart); it never waits for the index lock, and says `None` when the index isn't built
for that revision. Elsewhere — or when the index can't say, or read the file before it
changed on disk — the word matches by name, skipping keywords, comments and literals by
their highlight tags. Columns cross the wire in UTF-16 units, CodeMirror's.

**History** (`state/history.ts`'s `useHistoryStore`) is back/forward, as a browser or
Emacs 29's xref keeps it: **`M-,`** back, **`C-M-,`** forward, both global, and a new move
drops the way forward. A `Place` is a spot in a file at a revision, a diff row (path +
line, read from `useUIStore.diffCursor`, put back through `diff-view.ts`'s `moveDiffCursor`),
or a log commit (`log.ts`'s `logCursor` / `moveLogCursor`). `lib/jumps.ts`'s
**`recordJump`** records the selected window's place and is called by the navigation
*gestures* — `navigateTo`, `openFileInProject`, `openFileFromDiff`, `visitCounterpart`,
`M-g g`, `C-x b`, `C-x g`, `M-x diff` — and deliberately not by `visitFile` or
`showBuffer`, which they share, so `lib/history.ts` can reuse them to go back and forth
without recording the place it's leaving. Recording inside `navigateTo` rather than
`gotoDefinitionAt` also means dismissing the picker records nothing; small moves (`] c`,
`j`) aren't recorded at all. Going to a file already shown in another window selects
that window — after `C-x 4 .`, `M-,` returns to the test beside the code. `applyComparison`
clears the history whenever the comparison (or its revision) changes.

## Extending

- **New backend command:** add logic to a feature module, a thin `#[tauri::command]` in
  `commands.rs`, register it in `lib.rs`'s `invoke_handler!`, and add an `invoke<T>`
  wrapper in `src/lib/tauri.ts` (+ a TS type mirroring the Rust struct).
- **New tree-sitter language:** add a `queries::<lang>` module and register its parser +
  extension dispatch in `xref.rs`. The capture-name → `SymbolKind` map is the contract.
- **Anything that reads repo content:** take a `ProjectSource` (project/browse reads) or a
  `ReviewScope` (tag reads) rather than assuming the working tree — that assumption is
  exactly what branch comparison broke.
- **New comparison mode:** a `DiffSpec` variant needs a matching `Comparison` variant
  (metadata for the header/status bar/clean state), a `ReviewScope` variant, a `Snapshot`
  arm in `tags.rs`, `sameSpec`/`comparisonLabel`/`scopeForSpec` cases, and
  `ambientSource`/`baseSource` cases so project mode follows it. If it involves a branch,
  take it from `useRepoStore.reviewBranch` rather than adding another branch picker.

## CodeMirror gotchas (carried from video-studio)

- The editor wrapper needs an explicit height chain or it collapses (see
  `.project-viewer .cm-editor { height: 100% }` in `styles.css`).
- App keys inside the viewer must check vim insert mode and type a literal char there —
  see `editor/cm-shared.ts` (`inVimInsertMode`; `AppShell`'s `isTypingTarget` uses it too).
  Don't rely on keymap precedence; read the authoritative vim state from the view. `:` is
  swallowed in the viewer (`swallowColonKeymap`) so it never opens vim's ex prompt.
- codemirror-vim's ex commands are **global**: modal editors share `editor/vim-modal.ts`
  and take turns with `claimModalEditor` (its release only clears a still-current claim).
- In a `@uiw/react-codemirror` modal editor (see `NoteEditorHost`): keep `basicSetup` and
  `extensions` identity-stable (the wrapper reconfigures on change), prefer an uncontrolled
  `value`, and turn **autocompletion off** for prose — with Markdown loaded, a pending
  completion's `Escape` binding swallows a quick `<Esc>` out of insert mode. Put
  `Prec.highest(vim())` first so vim reads keys before any other keymap.

## Testing

Logic is unit-tested in Rust against `tempfile` git fixtures (`diff`, `tags`, `commits`,
`coverage`, `notes`, `review_dir`, `fuzzy`, `tree`, `xref`, `repo_library`), and
`counterpart`'s ranking over plain path lists. UI/interaction has no automated or written
test plan.

`xref`'s two- and three-file fixtures are too small to catch resolution bugs that only
appear across packages, so `xref_validate.rs` runs the resolver over a realistic
multi-package project — 52 assertions covering every tier plus the residue. Build it with
`./scripts/make-java-sample.sh` (the tree is gitignored); the test skips loudly without
it. It's also the fixture to open in the app for hand-testing `M-.`/`M-,`/`M-?`.

**`xref`'s symbol index is a process-global `Mutex`**, so any test that builds one must
hold `xref::TEST_LOCK` for its whole body — otherwise parallel tests clobber each
other's fixture and fail in ways that vanish under a `cargo test <filter>`.
