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

- **Diff mode** — a magit-style view of the working tree vs `HEAD`, grouped into three
  sections — **To review**, **Flagged**, and **Reviewed** — just as magit splits
  untracked / unstaged / staged. Tagging a hunk moves it between sections so "what's
  left" is always front and center (empty sections are hidden). Expand files into hunks
  and lines, navigate entirely from the keyboard, with intra-line word-diff highlighting
  so you see exactly what changed within an edited line.
- **Review / flag tagging** — tag a whole file, a single hunk, or an arbitrary line range
  as **reviewed** (`✓`, "I've checked this") or **flagged** (`⚑`, "come back to this").
  Tags persist across restarts and *re-anchor* to the code as it moves.
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
| **Diff** (default) | Working-tree-vs-`HEAD` diff as a navigable file/hunk/line list. | Review **and** flag |
| **Project** | Read-only file tree + syntax-highlighted viewer over the whole repo. | Flag only |

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
| `r` | `:refresh` | Recompute the diff from the current working tree |
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

Glyphs: `A`/`M`/`D`/`R` file status, `+adds −dels` counts, a green `●` for staged changes,
`✓` reviewed, `⚑` flagged. Edited lines highlight only the characters that changed.

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
  validate via libgit2), `diff` (working-tree-vs-`HEAD`), `tags` (persistence + anchoring),
  `tree` (ignore-aware listing), `fuzzy` (nucleo matcher), `queries` + `xref` (tree-sitter
  symbol index).
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
- Running the app needs a display (it's a desktop window); `npm run build` smoke-builds the
  frontend without one.
