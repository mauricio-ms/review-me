# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**review-me** is a Tauri v2 desktop tool for reviewing code produced by LLM agents:
a magit-style, vim-driven UI over a git diff — working-tree-vs-HEAD, a
`base...target` branch comparison, or a single commit vs its first parent, entered from a
magit-style commits buffer — with reviewed/flag tagging, review notes exported as
Markdown for an LLM to act on, a fuzzy file finder,
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
- `tags.rs` review/flag persistence + **anchoring** (see below). `tree.rs` ignore-aware dir listing. `fuzzy.rs` nucleo-matcher file ranking.
- `coverage.rs` review progress over a computed diff (`summarize`, `commit_reviews` for the log's rows) and the covers/overlaps helpers `review_commit.rs` stages by — the Rust twin of `src/lib/coverage.ts`; keep the two in step.
- `notes.rs` the Markdown export of review notes (see "Notes" below). `review_dir.rs` owns `.review-me/`: every write goes through `ensure`, which also adds it to `.git/info/exclude`.
- `queries.rs` + `xref.rs` tree-sitter symbol index and find-definition/references.
- `window.rs` builds the main window in `setup` (`tauri.conf.json` has it `"create": false`) so decorations can follow the desktop: off on tiling compositors, on elsewhere, `REVIEW_ME_DECORATIONS` overrides.

**Frontend (`src/`)** — `AppShell.tsx` keeps all three buffers (`DiffBuffer`, `LogBuffer`,
`ProjectBuffer`) mounted and toggles visibility with `display:none` (preserves
cursor/scroll). A single **`components/useCommands.ts`** registry feeds both the `Space`
transient palette (`CommandTransient`) and the `:` command line (`CommandLine`); commands
carry a `buffer` scope and chord `prefix`/`key`, and `palette: false` keeps one out of the
palette (`:show`, `:note`, `:export` are command-line only — the user wants no new
chords for them). Modal pickers (open-repo, recent, fuzzy, checkout-branch,
branch-compare, commit-pick, xref) and the modal editors (commit message, note) are gated
by `useUIStore.picker` or a dedicated store and use `useModalFocus`.

**State** is Zustand in `src/state/` (`ui`, `repo`, `tags`, `log`, `notes`, `project`, `xref`). Cross-cutting
conventions that will bite if ignored:
- **Wire format:** Rust structs are `#[serde(rename_all = "camelCase")]`; `AppError`
  serializes to a string. serde emits `null` for `Option::None`, so TS types use `| null`
  (not optional `?`).
- **Selectors must not return fresh `[]`/`{}`** — use module-level `EMPTY_*` constants
  (Zustand infinite-rerender trap).

### The branch under review

`useRepoStore.reviewBranch` (`ReviewBranch { ref, display }`) is the app's own notion of a
checkout and the **single place a branch is chosen**: `:compare` collects only a base and
targets it, the commits buffer (`:log`) lists the commits it introduced over that base.
It is seeded on open from `RepoInfo.reviewBranchRef` (HEAD's branch, else the repo's
default branch, else `None` — a repo with no branches disables `:compare`, and the log
lists `HEAD`) and changed by `:checkout` (`Space g s`, `CheckoutBranchHost`).

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

What is listed is `commits::resolve_range(ref, base)` — shared with `:export`, so the
export covers exactly the log's commits — which yields a `LogRange`:
- `unmerged` — `base..ref`, also hiding the base's upstream (a stale local `master`
  mustn't leak `origin/master`'s commits in). An empty result is a real answer
  ("no commits beyond master"), not a reason to fall back.
- `unpushed` — the base names the branch itself (reviewing `master`): `upstream..ref`.
- `all` — no base, or its own base with no upstream or nothing ahead of it.

The base is **`useRepoStore.reviewBase`**: seeded on open from
`RepoInfo.defaultBranchRef`, replaced by whatever `:compare` picks (`chooseReviewBase`,
which reloads the log) so the log and the branch diff always share one base. `:show`'s
picker passes no base — it is for the whole history.

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
own `onKeyDown` over a flattened `Row[]` (file/hunk/line) with a `pending` ref for chords
(`gg`, `]h`, `]f`) and a `visualAnchor` for `v` selection. Line rows carry **intra-line
word-diff** segments (`lib/word-diff.ts`: pairs each removed line with the added line that
replaced it, LCS over tokens) — on by default; the `diff highlight` command (`Space h` /
`:diffmode`) toggles `useUIStore.diffHighlight` between `word` and whole-`line`. Only the
**project viewer** (`ProjectBuffer.tsx`) uses CodeMirror (read-only + vim + per-file syntax
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
scope. `review_commit.rs` stages reviewed new-side + old-side hunks via `apply` and
reviewed binary files via index add/remove; it loads **worktree-scoped tags only**, and
`:commit` is disabled (with a defensive guard in `CommitReviewedHost`) whenever
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
section and `u` for free. `:note` (`lib/notes.ts`) reads the diff buffer's cursor or
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
export is logged, never fatal. `:export` writes `notes/branches/<branch>.md` — every note
reachable from the review branch, oldest first. Rendering must stay **deterministic**
(dates from the commit, write only when content changes) so an unchanged review never
churns; excerpts are the commit's own diff lines over the note's range, or tree lines for
code the commit didn't touch, because the reader works at a later HEAD where line numbers
have drifted.

### Project mode is revision-aware

`useProjectStore.source` (`ProjectSource`: worktree | commit) is the single revision the
tree, viewer, fuzzy finder, and xref index all read through — `read_file`,
`list_repo_dir`, `fuzzy_files`, and every xref command take it. `applyComparison` points
it at the target commit in branch mode (so a moved branch re-points it on refresh), at the
reviewed commit in commit mode, and at the worktree otherwise (`lib/project.ts`'s
`ambientSource`); `openFileFromDiff` switches to the **old side's** revision for deletions
— the merge base, or the commit's first parent (`baseSource`) — since that's the only
revision containing them. Changing the source drops cached listings and the open file —
they belong to the old snapshot — and `ProjectBuffer`'s modeline names the revision
whenever it isn't the worktree.

`useProjectStore.filter` (`all` | `changed`, `c` in the tree / `:changed`) narrows the
tree and the fuzzy finder to **the applied comparison's files** (`useRepoStore.diff`): a
commit's, a branch's, or the uncommitted ones. It is a standing preference — `setSource`
and `reset` leave it alone — so it keeps following whatever is under review. The changed
tree is synthesized from those paths (`buildChanged`), never listed from disk; the finder
passes them to `fuzzy_files` as `only`. Changed files open through `openFileFromDiff`,
so a deletion reads from `baseSource`. Xref still indexes the whole revision —
definitions mostly live in files the change didn't touch.

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
Chained calls recurse through a method's declared return type. Locals aren't indexed
(too many, each visible in one method) — they're `Target::Local`, identified by byte
offset.

Failing to resolve splits into **two different answers**, and conflating them is what
makes navigation lie:

- **`External`** — resolved to something outside the project: a JDK/jar type, a member
  of one, a member absent from a type whose supertype chain we fully see, or an
  unresolvable identifier shaped like a type (`System`, `Math`). Nothing declared here
  can be the answer, so `find_definition` returns **nothing** rather than falling back,
  and `find_references` **drops** the occurrence. `books.add(..)` on a `List` must not
  land on some unrelated `add` in this repo.
- **`Unresolved`** — genuinely undecidable: `var`, generic element types, static
  imports, or a member missing from a type that extends something we can't read. Here a
  kind-filtered name match is still the best guess, so `find_definition` falls back to
  it and `find_references` keeps the hit as unconfirmed.

So **the picker only appears when resolution genuinely couldn't decide** — never for a
symbol we know isn't ours.

`find_references` name-matches first (the cheap prefilter) and resolves only the
survivors. An occurrence proved to be a *different* symbol is **dropped**; one that
can't be proved either way comes back with `confirmed: false` and is shown in a
separate section. Nothing is silently omitted — a missed caller is a worse failure than
a spurious one in a review tool. `rank` puts confirmed hits first, then same-file.

The frontend binds emacs-xref keys in the viewer (`editor/xref-keymap.ts`, an Alt
keymap rather than vim mappings — codemirror-vim's own `C-o`/`C-i` jump list anchors
marks into a document the viewer replaces on every file open, so it can't follow a jump
across files): **`M-.`** definition, **`M-,`** back, **`M-?`** references, plus
`Space g d`/`g r`/`g o` palette commands. A Ctrl/Cmd+click (`editor/xref-click.ts`) also
jumps to definition; it and `M-.` both route through `xref.ts`'s
`gotoDefinitionAt(line, col)`. The index is warmed in the background on repo
open/refresh (`applyComparison`).

`useJumpStore` (`state/jumps.ts`) is the emacs marker stack: pop-only, no forward.
`lib/jumps.ts`'s **`recordJump`** is called by the navigation *gestures* — `navigateTo`,
`openFileInProject`, activating a tree row — and deliberately not by `openProjectFile`,
which they all share, so `jumpBack` can reuse the same open path without recording the
position it's leaving (which would make `M-,` ping-pong). Recording inside `navigateTo`
rather than `gotoDefinitionAt` also means dismissing the picker records nothing.
Entries are viewer-local (file + cursor, never a revision), so `useProjectSource` clears
the stack whenever the source changes.

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
- Leader keys (`Space`/`:`) inside the viewer must check vim insert mode and type a
  literal char there — see `editor/cm-shared.ts` (`inVimInsertMode`). Don't rely on keymap
  precedence; read the authoritative vim state from the view.
- codemirror-vim's ex commands are **global**: modal editors share `editor/vim-modal.ts`
  and take turns with `claimModalEditor` (its release only clears a still-current claim).
- In a `@uiw/react-codemirror` modal editor (see `NoteEditorHost`): keep `basicSetup` and
  `extensions` identity-stable (the wrapper reconfigures on change), prefer an uncontrolled
  `value`, and turn **autocompletion off** for prose — with Markdown loaded, a pending
  completion's `Escape` binding swallows a quick `<Esc>` out of insert mode. Put
  `Prec.highest(vim())` first so vim reads keys before any other keymap.

## Testing

Logic is unit-tested in Rust against `tempfile` git fixtures (`diff`, `tags`, `commits`,
`coverage`, `notes`, `review_dir`, `fuzzy`, `xref`, `repo_library`). UI/interaction is covered by the manual checklist in
`MANUAL_TESTS.md` (fixture setup + per-milestone scenarios) — keep it current when adding
features.

`xref`'s two- and three-file fixtures are too small to catch resolution bugs that only
appear across packages, so `xref_validate.rs` runs the resolver over a realistic
multi-package project — 40 assertions covering every tier plus the residue. Build it with
`./scripts/make-java-sample.sh` (the tree is gitignored); the test skips loudly without
it. It's also the fixture to open in the app for hand-testing `M-.`/`M-,`/`M-?`.

**`xref`'s symbol index is a process-global `Mutex`**, so any test that builds one must
hold `xref::TEST_LOCK` for its whole body — otherwise parallel tests clobber each
other's fixture and fail in ways that vanish under a `cargo test <filter>`.
