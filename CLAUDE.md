# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**review-me** is a Tauri v2 desktop tool for reviewing code produced by LLM agents:
a magit-style, vim-driven UI over a git working-tree-vs-HEAD diff, with reviewed/flag
tagging, a fuzzy file finder, an IDE-like project mode, and tree-sitter cross-references.
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
- `repo.rs` open/validate, `RepoInfo`. `diff.rs` working-tree-vs-HEAD via git2 (`ChangedFile`/`Hunk`/`DiffLine`).
- `tags.rs` review/flag persistence + **anchoring** (see below). `tree.rs` ignore-aware dir listing. `fuzzy.rs` nucleo-matcher file ranking.
- `queries.rs` + `xref.rs` tree-sitter symbol index and find-definition/references.

**Frontend (`src/`)** — `AppShell.tsx` keeps both buffers (`DiffBuffer`, `ProjectBuffer`)
mounted and toggles visibility with `display:none` (preserves cursor/scroll). A single
**`components/useCommands.ts`** registry feeds both the `Space` transient palette
(`CommandTransient`) and the `:` command line (`CommandLine`); commands carry a `buffer`
scope and chord `prefix`/`key`. Modal pickers (open-repo, recent, fuzzy, xref) are gated
by `useUIStore.picker` or a dedicated store and use `useModalFocus`.

**State** is Zustand in `src/state/` (`ui`, `repo`, `tags`, `project`, `xref`). Cross-cutting
conventions that will bite if ignored:
- **Wire format:** Rust structs are `#[serde(rename_all = "camelCase")]`; `AppError`
  serializes to a string. serde emits `null` for `Option::None`, so TS types use `| null`
  (not optional `?`).
- **Selectors must not return fresh `[]`/`{}`** — use module-level `EMPTY_*` constants
  (Zustand infinite-rerender trap).

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

Reviewed/flag tags live in `<repo>/.review-me/tags.json`, anchored to a file's *current*
content by `[startLine,endLine]` + sha256 of those lines + context lines. `tags::load`
**re-anchors** every tag: exact hash at the stored position → else a ±200-line search →
else `stale: true`. The frontend sends only `(file, startLine, endLine, kind)`; the
backend computes the hash/context so add and re-anchor stay consistent. "Reviewed" is
fundamentally per-hunk; file/line coverage is **derived** in `src/lib/coverage.ts`
(`isHunkReviewed`/`isFileReviewed`), not stored.

### Cross-references

`xref.rs` parses every `.java` file once into a cached index (trees + a name→definitions
map). Resolution is **name+kind only** (no type/scope resolution) — navigation-grade, so
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
