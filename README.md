# review-me

> [!WARNING]
> ### This is a vibecoded project
>
> **review-me** was built almost entirely by prompting an LLM coding agent ("vibe
> coding"). It is an **experiment to test an idea** — whether a tool like this fits my
> own workflow for reviewing agent-generated code — **not a maintained product**.
>
> - Expect bugs, rough edges, and design decisions that were never revisited.
> - Nothing is stable: keybindings, behavior, and the on-disk `.review-me/` format may
>   change or break without notice.
> - It may be abandoned at any time, and issues or pull requests may go unanswered.
>
> It's public in case the idea is useful to someone else. **Use it at your own risk.**

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
- **Commit review** — a magit-style **commits buffer** lists the review branch's history;
  enter a commit to review its change (`git show` semantics), `q` to come back to the
  list, where each row shows how far its review got. Marks are keyed to the commit's
  oid, so they can never drift and never mix with the branch-wide review.
- **Notes for later** — `M-x note` leaves a Markdown note on the lines of a commit: a fix to
  make later, typically by an LLM. Every commit's notes are kept as structured Markdown
  under `.review-me/notes/`, and `M-x export` bundles a whole branch's into one file.
- **Fuzzy file finder** — jump to any (non-ignored) file in the repo.
- **Project mode** — a read-only, IDE-like browser over the *entire* repo, or (`c`) just
  the files the comparison on screen changed — a commit's, a branch's, the uncommitted
  ones. Review a whole file at a time here — from the tree or from the file itself — and
  flag lines for later.
- **Cross-references** — go-to-definition and find-references (tree-sitter, Java) so you
  can trace a changed symbol through the project.

The interface is the point: **vim motions everywhere** and a **magit-like** model of
files → hunks → lines, with Emacs keys: `M-x` and a minibuffer at the bottom of the window.

---

## Core concepts

### Three buffers

All stay mounted; you switch between them and keep your cursor/scroll position.

| Buffer | What it is | Tagging |
| --- | --- | --- |
| **Diff** | The active comparison as a navigable file/hunk/line list. | Review, flag **and** note |
| **Commits** | The review branch's history, magit-style; `Enter` opens a commit in the diff buffer. | — |
| **Project** | Read-only file tree + syntax-highlighted viewer over the whole repo, at the compared revision. Every file you open in it stays open as a buffer of its own. | Review whole files, flag lines |

The file tree belongs to the project buffer only: the diff, the commits and help never show
it. Opening a file *beside* the diff (`o`) keeps you in the diff, with no tree; `RET` takes
you to the project buffer.

### Windows

Split the screen as in Emacs — `C-x 3` side by side, `C-x 2` stacked — to read two things
at once: a test and the code it tests, the diff and the whole file, the commits and one
commit. Each window shows any buffer (a file can be in two windows, each with its own
cursor); `C-x o` cycles through them, `C-w h`/`j`/`k`/`l` moves left/down/up/right (in project mode,
left of the first window is the file tree), and the window with the keyboard wears an amber
edge.
Drag a boundary to resize.

The `C-x 4` keys open something **in the other window**, keeping the one you're in on
screen: `C-x 4 .` goes to a definition there, `C-x 4 t` to the code a test tests (or a
file's test), `C-x 4 C-f` finds a file there, `C-x 4 b` switches it to another buffer.
"The other window" is the one already showing that file, else the next window, else a new
one split off to the right — so from `OrderServiceTest.java`, `C-x 4 .` on `OrderService`
puts the class beside the test, and `C-x 4 t` from the class brings you back to the test.
`q` in a window that was split off to show something closes it again.

Switching to the diff from your files — `q`, `M-x diff`, `C-x b diff`, entering a commit —
gives it the whole screen, as magit's status does, and keeps your windows: come back to
the project (`M-x project`, RET on a file, `C-x b`, `M-,`, `C-x ←`) and they're there as you
left them. A file already in one of them is gone back to there. `C-x 4 b diff` puts the
diff beside your file instead.

Opening a repository lands on the diff buffer when the working tree has uncommitted
changes, and on the commits buffer when it's clean (there would be nothing to diff).

### The branch under review

The app keeps its own "checkout": the **branch under review**, shown in the status bar as
`review: <branch>`. It starts as whatever the working tree is on (or the repo's default branch
if HEAD is detached), and `M-x checkout` switches it — to a local branch or a
remote-tracking one.

This is app-level only. Switching **never** fetches, checks out, stages, or writes
anything: the working tree stays exactly where it was, so reviewing a branch you don't
have checked out works like any other. When the two differ, the status-bar segment turns
amber — a reminder that the working-tree diff still belongs to the real checkout.

Both committed-history views derive from it, so you name a branch once:

- `M-x compare` asks only for a **base** and shows `base...reviewBranch`.
- `M-x log` (the commits buffer) lists the commits the **review branch introduced** over
  its base — `M-x compare`'s pick; until you make one, the branch it tracks (its
  upstream, so the log lists what isn't pushed yet), else the repo's default branch.

Switching while comparing branches re-targets the comparison, so you can walk several
branches against the same base. (If the new branch *is* that base, there's nothing to
compare and the view drops back to the working-tree diff.)

### Three comparisons

The diff buffer shows one of three things, and always says which in its header and the
status bar:

| Comparison | What it shows | Switch with |
| --- | --- | --- |
| **Working tree** (default) | Everything uncommitted vs `HEAD`, staged or not, including untracked files. | `C-x v =` |
| **Branches** | `git diff base...reviewBranch` — the review branch's work since it forked from the base. | `M-x compare`, or `b` in the commits buffer |
| **Commit** | `git show <commit>` — one commit of the review branch against its first parent. | `RET` in the commits buffer (`C-x g`) |

Both committed-history modes are strictly read-only: they never fetch, check out, stage,
or write to the working tree. Only refs and objects your clone already has are offered,
and a dirty checkout can't affect what you see. Because both sides are already committed,
**committing reviewed changes is disabled** in either mode.

Merges are reviewed against their **first parent** (never as a combined diff), and a root
commit — having no parent — reads as all additions.

A commit's diff starts with its message, as magit's revision buffer does: the subject,
the author and date, then the body. `Tab` on it folds it down to the subject line, and it
stays folded for the next commit until you unfold it.

Opening a repository always starts on the working-tree diff (shown in the commits buffer
instead when there is none); `C-x x g` recomputes whichever comparison is active (picking
up new commits on either branch; a commit comparison is immutable, so only its marks are
re-read) and reloads the commits buffer.

### Reviewed vs. flagged

- **Reviewed (`✓`)** — "I have checked this region." Fundamentally per-hunk; file- and
  line-level coverage is *derived*, not stored. The diff buffer reviews a file, a hunk or
  lines; the project buffer a whole file at a time (every hunk of it).
- **Flag (`⚑`)** — "Scrutinize this later." Works on the same scopes (file / hunk / line
  range), and is available in the diff buffer and in open files.
- **Note (`✎`)** — a flag that says what to fix, written with `M-x note` while reviewing a
  commit (see [Notes](#notes)).

Tags are stored in `<repo>/.review-me/tags.json` — a folder review-me adds to the repo's
`.git/info/exclude`, git's *local* ignore file, so it never shows up in `git status`, in
the diff, or in an agent's `git add -A`, and the project itself is never changed. They
are **anchored** to the file's current
content (line range + a hash of those lines + surrounding context). On reload they
re-anchor: exact match at the stored position, else a nearby search, else marked *stale* —
so small edits above a tagged region don't lose the tag, and a fully rewritten region
won't silently mark unrelated code as reviewed.

Every tag also records the **comparison it was made in** (the working tree, a
`base...target` branch pair identified by ref name, or a single commit identified by its
oid). Marking a hunk reviewed in `master...feature` says nothing about the same lines in
the working-tree diff, in another branch pair, or in the individual commit that
introduced them — and `M-x clear` only wipes the comparison you're looking at. Branch and
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

### Which build is running

`M-x version` says, e.g. `review-me 0.1.102 · built 2026-10-29 18:52 (4m ago)`; the start
screen and the help buffer show it too. The number is `package.json`'s major.minor plus
the commit count (`scripts/version.sh`), so it goes up by itself with every commit and the
same code always gets the same number; a build with uncommitted changes adds `-dev`. After
`./install.sh --restart`, the build time is the quick check that the app you're looking at
is the one you just built.

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

### Distribution

`./packaging/build-ubuntu.sh` produces installable packages for other machines. It builds
inside a Docker container running the target distribution, so the binary links against
that release's glibc and webkit2gtk instead of whatever the build host happens to ship —
which is what makes the output portable. Docker is the only prerequisite, and a build
touches nothing in the repo: `node_modules/` and `src-tauri/target/` stay out of the build
context, so the container compiles its own.

```bash
./packaging/build-ubuntu.sh                 # .deb, built on Ubuntu 22.04
./packaging/build-ubuntu.sh --appimage      # also emit a single-file AppImage
./packaging/build-ubuntu.sh --ubuntu 24.04  # build against a newer base
```

**Supported targets** — all **x86_64**; artifacts land in `dist-linux/` (gitignored):

| Package | Runs on | Size | Notes |
| --- | --- | --- | --- |
| **`.deb`** | Ubuntu 22.04 LTS and newer | 5 MB | The default. Declares `libwebkit2gtk-4.1-0` + `libgtk-3-0` so apt resolves them, and registers the same launcher entry and icons `install.sh` does. |
| **`.AppImage`** | Any glibc 2.35+ desktop with GTK 3 | 81 MB | Built only with `--appimage`. Bundles webkit2gtk, so it needs no package manager and no root — `chmod +x` and run. |
| **`review-me`** | Same as the `.deb` | 16 MB | The bare executable, to place yourself. Install its libraries manually: `sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0`. |

The base you build on sets the floor, since glibc is backward but not forward compatible:
22.04 (glibc 2.35) covers every later Ubuntu, while `--ubuntu 24.04` targets 24.04+ only.
Build against the **oldest** release you need to support. Debian-based derivatives that
carry webkit2gtk 4.1 should accept the same `.deb`, though only Ubuntu 22.04 and 24.04 are
tested. arm64 would need a separate cross-build setup.

On the target machine:

```bash
sudo apt install ./review-me_0.1.102_amd64.deb   # the version the app reports
dpkg -l review-me                                # which one is installed
review-me                                    # or find it in the app launcher
```

The window has a title bar on floating desktops (GNOME, KDE) and none on tiling
compositors (Hyprland, sway, niri, river, i3), where GTK would otherwise draw its own
header bar inside the tile. It decides at startup from `XDG_CURRENT_DESKTOP`;
`REVIEW_ME_DECORATIONS=1` or `=0` forces either way.

Note that the AppImage bundles webkit but still links the host's GTK 3 and graphics stack
(`libGL`/`libEGL`/`libgbm`) — linuxdeploy deliberately excludes those as system libraries.
That holds on any desktop install, but not on a minimal or headless box.

To check a build without a spare machine, install it into a stock `ubuntu:22.04` or
`ubuntu:24.04` container: `ldd -r /usr/bin/review-me` should report no missing libraries
and no undefined symbols, and running it should reach *"Failed to initialize GTK"* — the
no-display error, meaning every library loaded and the app started.

---

## Usage

Open the app and pick a repository on the start screen (`j`/`k` and `RET`, or its
number), `C-x p p` for every recent one, or `M-x open` to browse the disk. The diff buffer
shows everything changed in the working tree. Expand a file, walk its hunks, and tag as
you review. `RET` opens the file at that line in the project buffer, where the file tree
browses the rest of the repo (`C-x o` moves to it) and `q` comes back; every file you open
stays open as a buffer, and `C-x b` switches between them.

The keys are Emacs's: `M-x` runs any command by name in a minibuffer at the bottom of the
window — where every picker reads too (find file, branches, commits, recent repositories,
references) — the commands you reach for often have a `C-x` key, and **`C-h b` lists every key
and command** (generated from the keymap, so it is always the real list). `C-h m` shows
just the current buffer's keys; `C-h k` tells you what a key does.

### Keys everywhere

| Key | `M-x` command | Action |
| --- | --- | --- |
| `M-x` | — | Run any command by name: type to narrow, `↑`/`↓` or `C-n`/`C-p`, `TAB` completes, `RET` runs |
| `C-g` | — | Cancel: a half-typed key, the minibuffer, a picker, a selection |
| `C-x C-f` | `find` | Fuzzy file finder → opens the file as a buffer |
| `M-,` / `C-M-,` | `back` / `forward` | Back to where you were — a file, the diff, the log — and forward again |
| `C-x b` | `switch-buffer` | Switch buffer (diff, log, project, help, every open file); `RET` alone goes back to the last one |
| `C-x k` | `kill-buffer` | Close the file in the window |
| `C-x ←` / `C-x →` | `previous-buffer` / `next-buffer` | Back through what this window showed — the diff, the log, files — and forward again (then `←` `→` alone keep going) |
| `C-x o` | `other-window` | The next window (the file tree first, in project mode) |
| `C-w h` / `j` / `k` / `l` | `windmove-left` / `-down` / `-up` / `-right` | The window to the left / below / above / to the right |
| `C-x 3` / `C-x 2` | `split-window-right` / `-below` | Split the window side by side / stacked |
| `C-x 0` / `C-x 1` | `delete-window` / `delete-other-windows` | Close this window / every other window |
| `C-x 4 .` | `definition-other-window` | Go to definition in the other window, keeping this file in view |
| `C-x 4 t` | `test-or-code-other-window` | From a test to the code it tests, or code to its test, in the other window |
| `C-x p t` | `test-or-code` | The same, in this window |
| `C-x 4 C-f` | `find-file-other-window` | Find a file, into the other window |
| `C-x 4 b` | `switch-buffer-other-window` | Switch the other window to another buffer |
| `C-x g` | `log` | The commits buffer: the commits the review branch introduced |
| `C-x p p` | `recent` | Open a recent repository |
| `C-x p k` | `close` | Close the repository |
| `C-x v =` | `worktree` | Return to the working-tree diff |
| `C-x v v` | `commit` | Commit the reviewed working-tree changes |
| `C-x x g` | `refresh` | Recompute the active comparison |
| `C-x C-=` / `C-x C--` / `C-x C-0` | `text-scale-increase` / `-decrease` / `-reset` | Bigger / smaller / default text everywhere (then `=` `-` `0` alone keep adjusting); remembered |
| `C-h b` | `help` | Every key binding and command |
| `C-h m` | `describe-mode` | The current buffer's keys |
| `C-h k` | `describe-key` | Press a key to see what it runs |

### `M-x` only

| Command | Action |
| --- | --- |
| `open` | Open a repository (directory browser) |
| `checkout` | Choose the branch under review (app-level; no real checkout) |
| `compare` | Compare the review branch against a base (`base...review`) |
| `show` | Review a commit by searching or typing its sha (commit picker) |
| `note` | (diff, commit review) Note on the lines at the cursor — a fix for later |
| `export` | Write the notes on the commits buffer's commits to one Markdown file |
| `clear` | Clear this comparison's review, flag and ignore marks |
| `diffmode` | (diff) Toggle word-diff ↔ whole-line highlighting |
| `changed` | Project tree and finder: only the changed files ↔ all files (`c` in the tree) |
| `hunk` | (project) Show/hide the diff of the change at the cursor or selection |
| `hunks` | (project) Show/hide the diff of every change, in every file |
| `flag` | (project) Flag the current selection |
| `diff`, `project` | Switch to that buffer |
| `toggle-tree` | (project) Hide or show the file tree (`C-x t t`) |

### Diff buffer

| Key | Action |
| --- | --- |
| `j` / `k` | Move cursor down / up |
| `gg` / `G` | Jump to top / bottom |
| `]f` / `[f` | Next / previous **file** |
| `]h` / `[h` | Next / previous **hunk** |
| `]s` / `[s` | Next / previous **section** |
| `Tab` | Fold / unfold the section, file, or hunk under the cursor (or a commit's message) |
| `Enter` | Open the file under the cursor, at that line, as a buffer |
| `o` | The same, in the other window |
| `C-o` | Show it in the other window, staying in the diff |
| `v` / `V` | Start/clear a visual line selection (extend with `j`/`k`) |
| `r` | Mark the file / hunk / selection **reviewed** (`✓`) |
| `u` | Unmark (asks first when that deletes a note) |
| `f` | **Flag** (`⚑`) the file / hunk / selection (flagging it again keeps its note) |
| `i` | **Ignore** (`⊘`) the file / hunk / selection |
| `C-e` / `C-r` | Scroll one line down / up |
| `q` | Leave a commit or branch comparison for the commits buffer |
| `Esc` / `C-g` | Cancel a visual selection |

Glyphs: `A`/`M`/`D`/`R` file status, `+adds −dels` counts, a green `●` for staged changes
(working-tree diff only — committed history has no staging state), `✓` reviewed, `⚑`
flagged. Edited lines highlight only the characters that changed.

`Enter` opens the file at the revision the diff came from: the target branch (or the
reviewed commit) for added/modified content, the merge base (or that commit's first
parent) for a deletion. The file's header names that revision whenever it isn't the
working tree.

### Branch pickers

`M-x checkout` (**Branch to review**) lists every local and remote-tracking branch — rows
badged `reviewing`, `default`, `checkout`, `local`/`remote`, plus the short oid — and
selection starts on the branch already under review. `origin/HEAD` is never listed (it's
an alias for a branch that is).

`M-x compare` (**Compare against**) collects just the base, defaulting to the current one —
until you pick another, the review branch's upstream, else the repo's default branch (from
`refs/remotes/*/HEAD`, else `master`, else `main`). The pick stays the base for the session,
across `M-x checkout` too, so the commits buffer lists
what the branch introduced over that same base. The branch under review is dimmed and
unselectable — it can't be its own base. Errors (an unknown ref, two branches with no
common ancestor) show inline without closing the picker.

Neither picker fetches, so remote-tracking branches are as fresh as your last `git fetch`.

### Commits buffer

`C-x g` (`M-x log`) shows the commits the review branch introduced — `git log
base..branch` — the way magit's status does: a `Head:` line (plus `Review:` when the
branch under review isn't the checkout, `Base:` naming what it is held against, and
`Changes:` when the working tree is dirty), then **Unmerged into master** (or whatever
the base is) — short oid, ref decorations (local branches, remote-tracking branches,
tags; the branch under review boxed), subject, author and age. Commits on the base's
upstream are left out too, so a stale local `master` can't leak mainline work in.

Until `M-x compare` picks a base, a branch is held against the one it tracks: the list
is its **Unpushed to origin/feature** commits — what an agent just committed — with
`Upstream:` in place of `Base:`, and empty once everything is pushed. A branch that
tracks nothing is held against the default branch. When the branch under review *is* its
base (reviewing `master` itself), the list is its unpushed commits too and, with no
upstream or nothing unpushed, its whole history under **Recent commits**.

| Key | Action |
| --- | --- |
| `j` / `k` | Move down / up |
| `gg` / `G` | Jump to the newest / oldest loaded commit |
| `Enter` | Review that commit against its first parent, in the diff buffer |
| `o` | The same, in the other window (the log stays beside it) |
| `b` | Review the whole listed range as one diff (`base...branch`) |

`q` in the diff buffer brings you back, on the same row. Each row shows its review:
`✓` when every change is reviewed (or ignored), `done/total` while partial, `⚑ n` flags and
`✎ n` notes. History pages in as you approach the end, and reloads whenever the buffer is
shown, on `C-x x g`, and when the review branch or its base changes.

`M-x show` keeps the old commit picker for what the list can't do: filter by subject or
author over the branch's **whole** history, and resolve a typed sha against the whole
object database — a commit on another
branch entirely, reviewed with no branch context.

### Notes

While reviewing a commit, `M-x note` opens a small Markdown editor (vim keys) for the lines
under the cursor — or the visual selection, or the note row you're on. A note is a fix
left for later, so it rides on a flag: on lines already flagged it edits that flag's
note; otherwise saving flags the lines with it. `C-c C-c` (or `C-RET`, or vim's `:wq` /
`:x`) saves and closes, `C-c C-k` (or `:q!`) discards the edit, `:w` saves and keeps
editing, and `:q` refuses to drop unsaved changes. An empty note clears
it (the flag stays; `u` removes both, after asking `(y or n)` in the minibuffer). Notes
show as rows under their hunk.

Every commit's notes are written, as you make them, to
`.review-me/notes/commits/<full-oid>.md`, indexed in `.review-me/notes/README.md`:

- YAML front matter (commit, parent, subject, author, date, note count) and a short
  preamble for the reader,
- the commit message,
- each file's notes in diff order, titled by line range, each followed by the commit's
  own diff over those lines — so a reader working at a later HEAD can find the code even
  after it moved.

`M-x export` writes every note on the commits the commits buffer lists, oldest commit first, to
`.review-me/notes/branches/<branch>.md` — one file to hand to an LLM. The files are
generated from the tag store and never read back: edit notes in the app.

### Project buffer

**Tree (left)** lists the whole revision, or — `c` / `M-x changed` — **only the files the
comparison on screen changed**: the commit's files while reviewing a commit, every file the
branch touched in a branch comparison (`b` in the commits buffer), the uncommitted ones in
the working-tree diff. The choice sticks as you move between comparisons, so it keeps
following what's under review; the fuzzy finder (`C-x C-f`) follows it too. Changed files
carry their status letter and a `✓` (fully reviewed) or `⚑` (flagged), and a deletion
opens from the old side, the only revision that still has it.

A folder that holds nothing but one other folder shares its row with it, so a Java package
reads `java/com/example/library` instead of four nested rows. Drag the tree's edge (or
`C-x {` / `C-x }`) to resize it — the width is remembered — and `M-x toggle-tree` gives
the viewer the whole window (`C-x t t` too) until `C-x o` or `C-x t t` brings the tree back. A file opened from the tree
opens as a buffer of its own; the ones before it stay open (`C-x b`).

| Key | Action |
| --- | --- |
| `j` / `k` | Move down / up |
| `gg` / `G` | Jump to top / bottom |
| `l` / `RET` | Expand a directory (lazy-loads) or open a file |
| `o` | Open the file in the other window |
| `h` | Collapse the directory, or jump to its parent |
| `TAB` | Toggle the folder under the cursor |
| `c` | Only the changed files ↔ all files |
| `r` | Mark the file **reviewed** (every hunk of it) |
| `f` | **Flag** the file |
| `i` | **Ignore** the file |
| `u` | Unmark the file (asks first when that deletes a note) |
| `C-x o` | To the viewer |
| `C-x {` / `C-x }` | Narrower / wider tree (then `{` `}` alone keep adjusting) |
| `C-x t t` | Hide the tree (again: show it) |
| `q` | Back to the diff |

**Viewer (right)** — read-only CodeMirror with vim motions and per-file syntax highlighting.
When the open file is part of the comparison on screen, its changes are marked the way an
editor's git signs are: a green bar beside added lines, a blue one beside modified lines,
and a red notch between the lines where something was removed (the header adds the
file's `+adds −dels`). `]c` / `[c` jump from change to change — the mode line says which
one you're on, `change 2/5` — and `]f` / `[f` go on to the next or previous changed file,
in the changed-files tree's order, the way they walk files in the diff buffer. `M-x hunk` opens the diff of the change under the cursor or the
visual selection right there — the removed lines appear in red above what replaced them,
changed words highlighted — and `M-x hunk` again closes it; `M-x hunks` does the same for every
change in every file, and `M-x hunk` then hides just the one you're on. While the tree lists
only the changed files (`c`), the removed lines are always shown in place; `M-x hunk` and
`M-x hunks` then add the word highlighting.

A strip at the viewer's right edge, beside the scrollbar, maps the whole file: each change
in its gutter sign's colour, flags in amber, the part on screen as a band and the cursor as
a line, so a change out of sight still shows. Click a mark to go to that change, or
anywhere else on the strip to go to that part of the file.

Rest the cursor on a symbol and its other occurrences in the file light up. In Java they
come from the cross-reference index, so a field and a local of the same name stay apart;
in other files the word is matched by name, leaving out keywords, comments and strings.

`C-s` searches the file the way Swiper does: the minibuffer lists the lines that match as
you type, numbered, and the file follows the selected one, with every match on screen lit.
Words separated by a space must all match, in order; words after a `!` must not match; it
ignores case until you type a capital. A word is a regexp written as in Emacs, so `(` and
`|` match themselves. `C-s` / `C-r` (or `C-n` / `C-p`) move through the matches, `RET`
stays there (`M-,` comes back), and `C-g` puts you back where you were. `C-s` on an empty
search brings back the last one, and `M-n` searches for the symbol at the cursor.

| Key | Action |
| --- | --- |
| `j`/`k`, `gg`/`G`, `w`/`b`, `/search` | Standard vim motions |
| `C-s` | **Swiper**: search the file as you type (`M-x swiper` too) |
| `M-.` / `M-?` | Go to definition / find references |
| `C-x 4 .` | Go to definition in the other window |
| `M-g g` | Go to line |
| `]c` / `[c` | Next / previous **change** in the file (a count works: `3]c`) |
| `]f` / `[f` | Next / previous **changed file**, at its first change |
| `Ctrl`/`Cmd` + click | Jump to definition of the symbol clicked |
| `r` | Mark this file **reviewed** (every hunk of it) |
| `!` | **Flag** the cursor's line, or the visual selection (`V` + `j`); `M-x flag` too |
| `u` | Unmark the visual selection, else the whole file (asks first when that deletes a note) |
| `C-x o` | To the tree (or the next window) |
| `q` | Back to the diff (a window split off beside it closes) |

### Cross-references

Definitions and usages resolve via a tree-sitter index (currently **Java**) that warms in
the background on open/refresh. Navigation follows the emacs-xref keys: **`M-.`** go to
definition, **`M-,`** back, **`M-?`** find references.

Resolution walks scopes for locals and parameters, resolves types through a file's
`package`/`import`s, and types a call's receiver to find the member on the right class —
following supertypes and splitting overloads by argument count. A call with no receiver
is found in the enclosing classes, then through `import static` (single or `.*`). So
`M-.` **jumps straight to the declaration**; a picker appears only where resolution
genuinely can't decide (`var`, generic element types, or a class that extends one in a
jar).

`M-?` applies the same resolution in reverse: occurrences proven to be a *different*
same-named symbol are dropped, and ones that can't be proven either way are kept in a
separate **unconfirmed** section rather than hidden — in a review tool, a missed caller
is worse than a spurious one.

### Going back and forth

`M-,` goes back to where you were, and `C-M-,` forward again — like a browser, across
everything: a definition, a reference picked, a Ctrl+click, a file from the finder or the
tree, `RET` in the diff, a test ↔ code jump, `M-g g`, a buffer switch (`C-x b`, `C-x g`). A
place is a line in a file, a row of the diff, or a commit in the log; small moves (`]c`,
`j`) aren't recorded. Going back to a file that another window shows goes to that window:
after `C-x 4 .`, `M-,` returns to the test beside the code. A new comparison starts a fresh
history.

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
  `tags` (scoped persistence + anchoring), `coverage` (review progress over a diff),
  `notes` (the Markdown export), `review_dir` (the `.review-me/` folder and its local
  exclusion), `tree` (ignore-aware listing), `fuzzy` (nucleo matcher), `queries` + `xref`
  (tree-sitter symbol index).
- **Frontend (`src/`)** — `AppShell` keeps all three buffers mounted; a single command registry
  (`components/useCommands.ts`) feeds `M-x`, and one keymap table (`lib/keymap.ts`) drives
  every key, `M-x`'s key column, and the `C-h b` help buffer; state is
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

Logic is unit-tested in Rust against temporary git fixtures.

---

## Known limitations

- Cross-references currently cover **Java** only, and resolve by name + kind (no full
  semantic/type resolution).
- The project viewer is **read-only** — this is a review tool, not an editor.
- Branch comparison never fetches, so remote-tracking branches are only as fresh as your
  last `git fetch`. Comparison is always merge-base (`base...target`); there's no
  two-dot/direct-diff mode.
- Merge commits are reviewed against their first parent, so changes brought in from the
  other side of the merge show as that merge's work — there's no combined-diff view.
- Commit marks and notes are keyed to the commit's oid, so rebasing or amending a commit
  leaves its review behind on the old oid.
- Running the app needs a display (it's a desktop window); `npm run build` smoke-builds the
  frontend without one.
