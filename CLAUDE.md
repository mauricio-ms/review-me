# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**review-me** is a Tauri v2 desktop tool for reviewing code produced by LLM agents:
a magit-style, vim-driven UI over a git diff — either working-tree-vs-HEAD or a
`base...target` branch comparison — with reviewed/flag tagging, a fuzzy file finder,
an IDE-like project mode, and tree-sitter cross-references.
The stack and UX deliberately mirror the sibling app at
`/home/mms/development/projects/video-studio` (buffer model, command palette, neo-picker
modals, Zustand) — consult it when a pattern here looks unfamiliar.

## Commands

```bash
npm run tauri dev          # run the desktop app (Vite on :1420 + Tauri window; needs a display)
npm run build              # frontend gate: tsc (strict) THEN vite build — run before committing FE
cd src-tauri && cargo test # backend tests (all logic modules have unit tests w/ tempfile fixtures)
cd src-tauri && cargo test diff::tests::marks_staged_files   # single test
cd src-tauri && cargo check                                  # fast backend typecheck
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
- `repo.rs` open/validate, `RepoInfo`. `branches.rs` local/remote ref discovery + `resolve()` → (base tip, target tip, merge base).
- `diff.rs` `compute(repo, &DiffSpec)` → `DiffSummary { comparison, files }` (`ChangedFile`/`Hunk`/`DiffLine`). See "Comparisons" below.
- `revision.rs` `ProjectSource` (worktree | commit) and tree-backed content/listing/file-list reads.
- `tags.rs` review/flag persistence + **anchoring** (see below). `tree.rs` ignore-aware dir listing. `fuzzy.rs` nucleo-matcher file ranking.
- `queries.rs` + `xref.rs` tree-sitter symbol index and find-definition/references.

**Frontend (`src/`)** — `AppShell.tsx` keeps both buffers (`DiffBuffer`, `ProjectBuffer`)
mounted and toggles visibility with `display:none` (preserves cursor/scroll). A single
**`components/useCommands.ts`** registry feeds both the `Space` transient palette
(`CommandTransient`) and the `:` command line (`CommandLine`); commands carry a `buffer`
scope and chord `prefix`/`key`. Modal pickers (open-repo, recent, fuzzy, branch-compare,
xref) are gated
by `useUIStore.picker` or a dedicated store and use `useModalFocus`.

**State** is Zustand in `src/state/` (`ui`, `repo`, `tags`, `project`, `xref`). Cross-cutting
conventions that will bite if ignored:
- **Wire format:** Rust structs are `#[serde(rename_all = "camelCase")]`; `AppError`
  serializes to a string. serde emits `null` for `Option::None`, so TS types use `| null`
  (not optional `?`).
- **Selectors must not return fresh `[]`/`{}`** — use module-level `EMPTY_*` constants
  (Zustand infinite-rerender trap).

### Comparisons

`DiffSpec` (mirrored in `src/types/diff.ts`) selects what the diff buffer shows:
`{kind:"worktree"}` or `{kind:"branches", baseRef, targetRef, strategy:"mergeBase"}`.
Refs are **canonical** (`refs/heads/x`, `refs/remotes/origin/x`) everywhere — requests,
`Comparison` metadata, and persisted review scopes — so a local `x` and `origin/x` are
never confused. Branch mode diffs the merge-base tree against the target tree and
**never** touches the checkout, index, or working tree; `ChangedFile.staged` is `None`
there. Binary detection differs by mode: worktree probes HEAD's blob + the file on disk
(`path_change_is_binary`), branch mode probes the delta's own blobs, because the compared
branch usually isn't checked out.

`src/lib/open-repo.ts`'s **`applyComparison(spec)`** is the single loading path: it
computes the diff and loads that scope's tags, then commits both to the stores at once
(retaining the previous comparison on failure) and drops stale in-flight responses via a
request ticket. `useRepoStore.comparison` is the applied spec; `comparisonEpoch` bumps
when its identity changes, which resets folds and the diff cursor. Opening a repo always
resets to worktree; `refresh` recomputes whatever is applied.

### The diff buffer is NOT CodeMirror

`DiffBuffer.tsx` is a custom keyboard-navigable HTML list (magit-status), driven by its
own `onKeyDown` over a flattened `Row[]` (file/hunk/line) with a `pending` ref for chords
(`gg`, `]h`, `]f`) and a `visualAnchor` for `v` selection. Line rows carry **intra-line
word-diff** segments (`lib/word-diff.ts`: pairs each removed line with the added line that
replaced it, LCS over tokens) — on by default; the `diff highlight` command (`Space h` /
`:diffmode`) toggles `useUIStore.diffHighlight` between `word` and whole-`line`. Only the
**project viewer** (`ProjectBuffer.tsx`) uses CodeMirror (read-only + vim + per-file syntax
highlighting lazy-loaded by extension via `@codemirror/language-data`).

### Tagging & anchoring (the subtle part)

Reviewed/flag/ignore tags live in `<repo>/.review-me/tags.json` (three parallel arrays:
`reviewed`, `flags`, `ignored`), anchored by `[startLine,endLine]` + sha256 of those
lines + context lines. Each anchor carries a **`side`** (`AnchorSide`) and a
**`scope`** (`ReviewScope`).

`side`: `new` anchors to the new side (added/modified hunks, the default), `old` to the
old side (pure-deletion hunks + deleted text files), `file` to a whole binary-file change
identified by `old:new` blob oids (line numbers unused).

`scope`: `worktree` or `{branches, baseRef, targetRef}` — **which comparison the mark
belongs to**. `tags::load(root, scope)` returns *only* that scope's tags, so identical
paths and line ranges stay isolated across comparisons; dedup, `unmark_range`, and
`clear_scope` are all scope-filtered. Both fields `#[serde(default)]`, so pre-existing
tags load as new-side worktree marks unchanged.

The scope also decides **what content the anchor hashes**: `tags.rs`'s `Snapshot` reads
the working tree + HEAD for worktree scope and the merge-base + target trees for a branch
scope, and is shared by `build_anchor` and `reanchor` so they can't disagree. `load`
re-anchors by side: exact hash at the stored position → else a ±200-line search → else
`stale: true`. A snapshot that *can't read* a side (no repo; a branch that no longer
resolves) leaves the anchor untouched rather than declaring it stale on missing evidence.
The frontend sends `(scope, file, startLine, endLine, kind, side)`; the backend computes
the hash/context so add and re-anchor stay consistent. "Reviewed" is fundamentally per-unit (text hunk, on whichever side, or a
binary file); file/line coverage is **derived** in `src/lib/coverage.ts`
(`hunkTarget`/`isHunkReviewed`/`isFileReviewed`), not stored. The diff buffer buckets
each unit into one of four sections — To review / Flagged / Reviewed / Ignored — by
precedence **flagged > ignored > reviewed > to-review** (`sectionForHunk`/
`sectionForFile`); `r` reviews, `f` flags, `i` ignores, and `u` unmarks the current
scope. `review_commit.rs` stages reviewed new-side + old-side hunks via `apply` and
reviewed binary files via index add/remove; it loads **worktree-scoped tags only**, and
`:commit` is disabled (with a defensive guard in `CommitReviewedHost`) while comparing
branches, where both sides are already committed. NB: libgit2's `DiffFile::is_binary()` is
unreliable before patches are generated, so binary detection uses
`diff::path_change_is_binary` (NUL-byte heuristic over HEAD blob + working file).

### Project mode is revision-aware

`useProjectStore.source` (`ProjectSource`: worktree | commit) is the single revision the
tree, viewer, fuzzy finder, and xref index all read through — `read_file`,
`list_repo_dir`, `fuzzy_files`, and every xref command take it. `applyComparison` points
it at the target commit in branch mode (so a moved branch re-points it on refresh) and at
the worktree otherwise; `openFileFromDiff` switches to the **merge base** for old-side
content (deletions), since that's the only revision containing it. Changing the source
drops cached listings and the open file — they belong to the old snapshot — and
`ProjectBuffer`'s modeline names the revision whenever it isn't the worktree.

### Cross-references

`xref.rs` parses every `.java` file once into a cached index (trees + a name→definitions
map), keyed by `(root, ProjectSource)` so a branch index never mixes in the checkout's
version of a file. Resolution is **name+kind only** (no type/scope resolution) — navigation-grade, so
same-named symbols across classes may all appear. `symbol_at` resolves the identifier
under a cursor; results are ranked same-file-first. The frontend binds `gd`/`gr` as vim
actions (`editor/vim-xref.ts`) and as `Space g d`/`g r` palette commands; a Ctrl/Cmd+click
in the viewer (`editor/xref-click.ts`) also jumps to definition. Both the `gd` action and
the click route through `xref.ts`'s `gotoDefinitionAt(line, col)`. The index is
warmed in the background on repo open/refresh.

## Extending

- **New backend command:** add logic to a feature module, a thin `#[tauri::command]` in
  `commands.rs`, register it in `lib.rs`'s `invoke_handler!`, and add an `invoke<T>`
  wrapper in `src/lib/tauri.ts` (+ a TS type mirroring the Rust struct).
- **New tree-sitter language:** add a `queries::<lang>` module and register its parser +
  extension dispatch in `xref.rs`. The capture-name → `SymbolKind` map is the contract.
- **Anything that reads repo content:** take a `ProjectSource` (project/browse reads) or a
  `ReviewScope` (tag reads) rather than assuming the working tree — that assumption is
  exactly what branch comparison broke.

## CodeMirror gotchas (carried from video-studio)

- The editor wrapper needs an explicit height chain or it collapses (see
  `.project-viewer .cm-editor { height: 100% }` in `styles.css`).
- Leader keys (`Space`/`:`) inside the viewer must check vim insert mode and type a
  literal char there — see `editor/cm-shared.ts` (`inVimInsertMode`). Don't rely on keymap
  precedence; read the authoritative vim state from the view.

## Testing

Logic is unit-tested in Rust against `tempfile` git fixtures (`diff`, `tags`, `fuzzy`,
`xref`, `repo_library`). UI/interaction is covered by the manual checklist in
`MANUAL_TESTS.md` (fixture setup + per-milestone scenarios) — keep it current when adding
features.
