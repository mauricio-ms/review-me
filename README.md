# review-me

A magit-style, vim-driven desktop tool for **reviewing code produced by LLM agents**.

When an AI agent rewrites half your project in one shot, the hard part isn't reading
the diff — it's *keeping track of what you've actually checked*. `review-me` gives you a
keyboard-first diff viewer where every changed region can be marked **reviewed** or
**flagged for a closer look later**, plus an IDE-like project mode with cross-reference
navigation so you can verify how a changed symbol is used across the codebase.

---

## The idea

Reviewing agent-generated code has a different shape than reviewing a human PR:

- The diffs are large and arrive all at once.
- You rarely trust it on the first pass — you want to mark "I've verified this" as you go,
  and "come back and scrutinize this" for the parts that smell off.
- Understanding a change often means jumping *out* of the diff to see where a function or
  class is used, even in files the agent didn't touch.

`review-me` is built around those needs:

- **Diff mode** — a magit-style view of the working tree vs `HEAD`, two
  branches (`base...target`, merge-base semantics), *or* a single commit against its
  first parent, grouped into three
  sections — **To review**, **Flagged**, and **Reviewed** — just as magit splits
  untracked / unstaged / staged. Tagging a hunk moves it between sections so "what's
  left" is always front and center (empty sections are hidden). Expand files into hunks
  and lines, navigate entirely from the keyboard, with intra-line word-diff highlighting
  so you see exactly what changed within an edited line.
- **Review / flag tagging** — tag a whole file, a single hunk, or an arbitrary line range
  as **reviewed** (`✓`, "I've checked this") or **flagged** (`⚑`, "come back to this").
  Tags persist across restarts and *re-anchor* to the code as it moves, and each
  comparison keeps its own independent set of marks.
- **A branch under review** — the app has its own notion of "checked out": pick the
  branch you're reviewing once, and both committed-history views derive from it. Nothing
  is fetched, checked out, or staged, so you can review a branch you don't have checked
  out at all.
- **Branch comparison** — review that branch's whole body of work (`master...feature`)
  by choosing only what to compare it against. Project mode follows: files open at the
  compared revision, not whatever happens to be checked out.
- **Commit review** — step through the review branch's history and review one commit's
  change (`git show` semantics). Its marks are keyed to the commit's oid, so they can
  never drift and never mix with the branch-wide review.
- **Fuzzy file finder** — jump to any (non-ignored) file in the repo.
- **Project mode** — a read-only, IDE-like browser over the *entire* repo, not just the
  changed files. You can't mark things reviewed here (reviewing is diff-only), but you can
  still flag regions for later.
- **Cross-references** — go-to-definition and find-references (tree-sitter, Java) so you
  can trace a changed symbol through the project.

The interface is the point: **vim motions everywhere** and a **magit-like** model of
files → hunks → lines, with a `Space` transient palette and a `:` command line.

---

## Core concepts

### Two buffers

Both stay mounted; you toggle between them and keep your cursor/scroll position.

| Buffer | What it is | Tagging |
| --- | --- | --- |
| **Diff** (default) | The active comparison as a navigable file/hunk/line list. | Review **and** flag |
| **Project** | Read-only file tree + syntax-highlighted viewer over the whole repo, at the compared revision. | Flag only |

### The branch under review

The app keeps its own "checkout": the **branch under review**, shown in the status bar as
`⎇ <branch>`. It starts as whatever the working tree is on (or the repo's default branch
if HEAD is detached), and `Space g s` / `:checkout` switches it — to a local branch or a
remote-tracking one.

This is app-level only. Switching **never** fetches, checks out, stages, or writes
anything: the working tree stays exactly where it was, so reviewing a branch you don't
have checked out works like any other. When the two differ, the status-bar segment turns
amber — a reminder that the working-tree diff still belongs to the real checkout.

Both committed-history views derive from it, so you name a branch once:

- `:compare` asks only for a **base** and shows `base...reviewBranch`.
- `:log` lists the **review branch's** history.

Switching while comparing branches re-targets the comparison, so you can walk several
branches against the same base. (If the new branch *is* that base, there's nothing to
compare and the view drops back to the working-tree diff.)

### Three comparisons

The diff buffer shows one of three things, and always says which in its header and the
status bar:

| Comparison | What it shows | Switch with |
| --- | --- | --- |
| **Working tree** (default) | Everything uncommitted vs `HEAD`, staged or not, including untracked files. | `Space g w` / `:worktree` |
| **Branches** | `git diff base...reviewBranch` — the review branch's work since it forked from the base. | `Space g b` / `:compare` |
| **Commit** | `git show <commit>` — one commit of the review branch against its first parent. | `Space g l` / `:log` |

Both committed-history modes are strictly read-only: they never fetch, check out, stage,
or write to the working tree. Only refs and objects your clone already has are offered,
and a dirty checkout can't affect what you see. Because both sides are already committed,
**committing reviewed changes is disabled** in either mode.

Merges are reviewed against their **first parent** (never as a combined diff), and a root
commit — having no parent — reads as all additions.

Opening a repository always starts on the working-tree diff; `:refresh` recomputes
whichever comparison is active (picking up new commits on either branch; a commit
comparison is immutable, so only its marks are re-read).

### Reviewed vs. flagged

- **Reviewed (`✓`)** — "I have checked this region." Fundamentally per-hunk; file- and
  line-level coverage is *derived*, not stored. Diff buffer only.
- **Flag (`⚑`)** — "Scrutinize this later." Works on the same scopes (file / hunk / line
  range), and is available in *both* buffers.

Tags are stored in `<repo>/.review-me/tags.json` and **anchored** to the file's current
content (line range + a hash of those lines + surrounding context). On reload they
re-anchor: exact match at the stored position, else a nearby search, else marked *stale* —
so small edits above a tagged region don't lose the tag, and a fully rewritten region
won't silently mark unrelated code as reviewed.

Every tag also records the **comparison it was made in** (the working tree, a
`base...target` branch pair identified by ref name, or a single commit identified by its
oid). Marking a hunk reviewed in `master...feature` says nothing about the same lines in
the working-tree diff, in another branch pair, or in the individual commit that
introduced them — and `:clear` only wipes the comparison you're looking at. Branch and
commit marks hash the compared trees, so they're unaffected by a dirty checkout; branch
marks follow their branch as it moves, while commit marks can't move at all and survive
even the deletion of the branch you picked the commit from. Tags written before review
scopes existed load as working-tree marks and keep meaning exactly what they did.

---

## Getting started

### Prerequisites

This is a [Tauri v2](https://tauri.app) app, so you need both toolchains:

- **Node.js** (18+) and npm
- **Rust** (1.78+) and Cargo
- The platform's Tauri system dependencies (WebKitGTK, etc. on Linux) — see the
  [Tauri prerequisites guide](https://tauri.app/start/prerequisites/).

### Install & run

```bash
npm install            # first time only
npm run tauri dev      # launches the desktop window (needs a display)
```

### Build

```bash
npm run build          # frontend gate: tsc (strict) THEN vite build
npm run tauri build    # produce a packaged desktop binary
```

### Install locally (app launcher entry)

`./install.sh` builds the release binary into `bin/`, installs the icon set into the
hicolor theme, and writes an XDG `.desktop` entry so **review-me** shows up in your app
launcher (Walker on Omarchy — `SUPER + SPACE` — or any GNOME/KDE search). The release
build is slow; it only needs to re-run when the binary changes.

```bash
./install.sh            # build + register the launcher entry
./install.sh --restart  # also (re)start the running app afterwards
```

The entry sets `Path=` to the repo root, so any cwd-relative lookups resolve there.

The icon is the app's own startup-dashboard logo — the pixel-art magnifying-glass badge
from `StartupDashboard.tsx` — so the launcher, window and taskbar all show the mark you
see on screen. `src-tauri/icons/.gen/logo-mark.html` reproduces that badge at a fixed
large size and `.gen/generate-icons.sh` screenshots it with headless Chromium, then
downscales to the Tauri bundle icons plus the launcher master (`icon-512.png`).
Re-run it after changing the startup logo's markup, its `.startup-logo-*` CSS, or the
theme tokens; `install.sh` runs it automatically when Chromium is present.

The PNGs must be RGBA or `tauri::generate_context!` fails the build with
`icon … is not RGBA` — the script forces this and asserts it. `cd src-tauri && cargo check`
re-runs that validation in seconds, without the slow release build.

---

## Usage

Open the app, then open a git repository (`Space → o → p`, or `:open`). The diff buffer
shows everything changed in the working tree. Expand a file, walk its hunks, and tag as
you review. Switch to project mode (`Space → b → p`) to browse the rest of the repo or
chase a definition.

### Leader keys (work anywhere)

| Key | Action |
| --- | --- |
| `Space` | Open the transient command palette (chord menu) |
| `:` | Open the command line (type a command name, filters as you go) |
| `Esc` | Dismiss any overlay / cancel a visual selection |

### Palette / command-line commands

| Palette chord | `:` command | Action |
| --- | --- | --- |
| `o p` | `:open` | Open a repository (directory browser) |
| `o r` | `:recent` | Open a recent repository |
| `f` | `:find` | Fuzzy file finder → opens in project mode |
| `r` | `:refresh` | Recompute the active comparison |
| `g s` | `:checkout` | Choose the branch under review (app-level; no real checkout) |
| `g b` | `:compare` | Compare the review branch against a base (`base...review`) |
| `g l` | `:log` | Review a single commit of the review branch (`git show`) |
| `g w` | `:worktree` | Return to the working-tree diff |
| `g c` | `:commit` | Commit the reviewed working-tree changes |
| `c` | `:close` | Close the repository |
| `b d` | `:diff` | Switch to the diff buffer |
| `b p` | `:project` | Switch to the project buffer |
| `h` | `:diffmode` | (diff) Toggle word-diff ↔ whole-line highlighting |
| `t f` | `:flag` | (project) Flag the current selection |
| `g d` | `:definition` | (project) Go to definition |
| `g r` | `:references` | (project) Find references |

### Diff buffer

| Key | Action |
| --- | --- |
| `j` / `k` | Move cursor down / up |
| `gg` / `G` | Jump to top / bottom |
| `]f` / `[f` | Next / previous **file** |
| `]h` / `[h` | Next / previous **hunk** |
| `]s` / `[s` | Next / previous **section** |
| `Tab` | Fold / unfold the section, file, or hunk under the cursor |
| `Enter` | Open the file under the cursor in project mode at that line |
| `v` / `V` | Start/clear a visual line selection (extend with `j`/`k`) |
| `r` | Mark the file / hunk / selection **reviewed** (`✓`) |
| `u` | Un-review |
| `f` | Toggle **flag** (`⚑`) on the file / hunk / selection |
| `Esc` | Cancel a visual selection |

Glyphs: `A`/`M`/`D`/`R` file status, `+adds −dels` counts, a green `●` for staged changes
(working-tree diff only — committed history has no staging state), `✓` reviewed, `⚑`
flagged. Edited lines highlight only the characters that changed.

`Enter` opens the file at the revision the diff came from: the target branch (or the
reviewed commit) for added/modified content, the merge base (or that commit's first
parent) for a deletion. The project modeline names that revision whenever it isn't the
working tree.

### Branch pickers

`Space g s` (**Branch to review**) lists every local and remote-tracking branch — rows
badged `reviewing`, `default`, `checkout`, `local`/`remote`, plus the short oid — and
selection starts on the branch already under review. `origin/HEAD` is never listed (it's
an alias for a branch that is).

`Space g b` (**Compare against**) collects just the base, defaulting to the repo's default
branch (from `refs/remotes/*/HEAD`, else `master`, else `main`). The branch under review is
dimmed and unselectable — it can't be its own base. Errors (an unknown ref, two branches
with no common ancestor) show inline without closing the picker.

Neither picker fetches, so remote-tracking branches are as fresh as your last `git fetch`.

### Commit picker

`Space g l` lists the review branch's history, newest first: short oid, subject,
`merge` / `HEAD` badges, author and relative age. `Enter` reviews that commit against its
first parent.

History is listed 300 commits deep. Anything older — or a commit on another branch
entirely — is reachable by typing its sha: when no listed commit matches, the picker offers
to resolve what you typed against the whole object database. A commit reached that way
shows no branch context, since it needn't be on the review branch.

### Project buffer

**Tree (left):**

| Key | Action |
| --- | --- |
| `j` / `k` | Move down / up |
| `l` / `Enter` | Expand a directory (lazy-loads) or open a file |
| `h` | Collapse the directory, or jump to its parent |
| `Tab` | Toggle the folder under the cursor |
| `G` | Jump to bottom |
| `Ctrl-h` | Toggle focus between tree and viewer |

**Viewer (right)** — read-only CodeMirror with vim motions and per-file syntax highlighting:

| Key | Action |
| --- | --- |
| `j`/`k`, `gg`/`G`, `w`/`b`, `/search` | Standard vim motions |
| `gd` / `g r` | Go to definition / find references |
| `Ctrl`/`Cmd` + click | Jump to definition of the symbol clicked |
| `v` + `j`, then `Space t f` | Flag the selected lines |
| `Ctrl-h` | Return focus to the tree |

### Cross-references

Definitions and usages resolve via a tree-sitter index (currently **Java**) that warms in
the background on open/refresh. Resolution is **name + kind** based (navigation-grade, not
full type/scope analysis), so identically-named symbols in different classes may all show
up. A single definition jumps straight there; multiple open a results panel.

---

## How it's built

A Tauri app: a React/TypeScript frontend and a Rust backend that talk only over Tauri IPC.

```
React component → src/lib/*.ts action → invoke() in src/lib/tauri.ts
   → #[tauri::command] in src-tauri/src/commands.rs → feature module (logic)
```

- **Backend (`src-tauri/src/`)** — small, mostly-stateless feature modules: `repo` (open/
  validate via libgit2), `branches` (ref discovery + merge-base resolution), `commits`
  (history listing + revision resolution), `diff` (working-tree-vs-`HEAD`,
  `base...target`, or one commit vs its first parent), `revision` (reading a commit's tree),
  `tags` (scoped persistence + anchoring), `tree` (ignore-aware listing), `fuzzy` (nucleo
  matcher), `queries` + `xref` (tree-sitter symbol index).
- **Frontend (`src/`)** — `AppShell` keeps both buffers mounted; a single command registry
  (`components/useCommands.ts`) feeds both the palette and the command line; state is
  Zustand (`src/state/`). The diff buffer is a custom keyboard-navigable list (not
  CodeMirror); only the project viewer uses CodeMirror.

**Stack:** Tauri 2, React 18, TypeScript (strict), Zustand, CodeMirror 6 (+ vim), git2,
nucleo-matcher, tree-sitter. There's no separate linter/formatter; `tsc` in strict mode
(`noUnusedLocals`/`noUnusedParameters`) is the gate.

See [`CLAUDE.md`](./CLAUDE.md) for a deeper architecture tour.

---

## Development & testing

```bash
npm run build                 # frontend gate (tsc strict → vite build)
cd src-tauri && cargo test    # backend unit tests (tempfile git fixtures)
cd src-tauri && cargo check   # fast backend typecheck
```

Logic is unit-tested in Rust against temporary git fixtures. UI and keyboard interaction
are covered by the manual checklist in [`MANUAL_TESTS.md`](./MANUAL_TESTS.md) — keep it
current when adding features.

---

## Known limitations

- Cross-references currently cover **Java** only, and resolve by name + kind (no full
  semantic/type resolution).
- The project viewer is **read-only** — this is a review tool, not an editor.
- Branch comparison never fetches, so remote-tracking branches are only as fresh as your
  last `git fetch`. Comparison is always merge-base (`base...target`); there's no
  two-dot/direct-diff mode.
- The commit picker lists the newest **300** commits of the chosen branch; older commits
  are reachable only by typing a sha. Merge commits are reviewed against their first
  parent, so changes brought in from the other side of the merge show as that merge's
  work — there's no combined-diff view.
- Running the app needs a display (it's a desktop window); `npm run build` smoke-builds the
  frontend without one.
