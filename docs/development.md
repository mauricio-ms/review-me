# Developing review-me

review-me is a [Tauri v2](https://tauri.app) app: a React and TypeScript frontend and a
Rust backend that talk only over Tauri IPC. This page covers building, testing and
releasing it. [`CLAUDE.md`](../CLAUDE.md) is the detailed architecture tour, written for
human and AI contributors alike.

## Prerequisites

- **Node.js** 18+ and npm
- **Rust** 1.78+ and Cargo
- The Tauri system dependencies for your distribution (WebKitGTK 4.1, GTK 3 and their
  development headers); see the
  [Tauri prerequisites guide](https://tauri.app/start/prerequisites/#linux).

## Run from source

```bash
npm ci                 # first time only
npm run tauri dev      # launches the desktop window (needs a display)
```

## Build

```bash
npm run build                            # frontend gate: tsc (strict), then vite build
npm run tauri build -- --bundles deb     # a package in src-tauri/target/release/bundle/
```

### Install a local build

`./install.sh` builds the release binary into `bin/`, installs the icon set into the
hicolor theme and writes an XDG `.desktop` entry, so a build of your checkout shows up in
your application launcher without packaging it. The release build is slow; it only needs
to re-run when the binary changes.

```bash
./install.sh            # build + register the launcher entry
./install.sh --restart  # also (re)start the running app afterwards
```

## Version numbers

The version is `package.json`'s major.minor plus the number of commits
(`scripts/version.sh`), so it goes up by itself with every commit and the same code always
gets the same number; a build with uncommitted changes adds `-dev`. Never bump it by
hand: change `package.json`'s major or minor to start a new series. `vite.config.ts`
stamps the version and the build time into the app (`M-x version`). A build without a
`.git` directory, such as one from a source tarball, can set `REVIEW_ME_VERSION` instead.

## Releasing

Releases are built by GitHub Actions from a tag on `master`:

```bash
./scripts/release.sh                 # checks for a clean master, tags v<version>
git push origin master v<version>    # the command it prints
```

The tag starts `.github/workflows/release.yml`, which runs the full test suite, then
builds the AppImage, `.deb` and `.rpm` on Ubuntu 22.04 (the glibc baseline: the packages
run there and on every newer distribution). It also collects the licenses of every
bundled Rust crate and npm package (`scripts/third-party-notices.mjs`) into
`THIRD-PARTY-NOTICES.txt`, ships that file in each package, and writes `SHA256SUMS`.
Everything is attached to a draft GitHub release with generated notes: review it, add
anything users must know (especially breaking changes), and publish.

The workflow refuses a tag that doesn't match the commit's `scripts/version.sh`, so tag
with the script rather than by hand.

`.github/workflows/ci.yml` runs `npm run build`, `npm run test:frontend` and
`cargo test --locked` on every push to `master` and every pull request.

## App icon

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
- **Frontend (`src/`)** — `AppShell` keeps the diff and log buffers mounted; a single command registry
  (`components/useCommands.ts`) feeds `M-x`, and one keymap table (`lib/keymap.ts`) drives
  every key, `M-x`'s key column, and the `C-h b` help buffer; state is
  Zustand (`src/state/`). The diff buffer is a custom keyboard-navigable list (not
  CodeMirror); only the project viewer uses CodeMirror.

**Stack:** Tauri 2, React 18, TypeScript (strict), Zustand, CodeMirror 6 (+ vim), git2,
nucleo-matcher, tree-sitter. There's no separate linter/formatter; `tsc` in strict mode
(`noUnusedLocals`/`noUnusedParameters`) is the gate.

## Testing

```bash
npm run build                 # frontend gate (tsc strict → vite build)
npm run test:frontend         # type-check tests and run every frontend suite (Chromium)
npm run test:navigation       # one suite: windows, buffers and jump history
npm run test:loading          # one suite: comparison/file loading and async races
cd src-tauri && cargo test    # backend unit tests (tempfile git fixtures)
cd src-tauri && cargo check   # fast backend typecheck
```

Logic is unit-tested in Rust against temporary git fixtures.

Backend regressions cover commit preparation/recovery, tag persistence, command-driven
note exports, filesystem browsing, revision reads and the recent-repository library.
Failed preparation restores the original index when it is still safe to do so;
commit and abort reject a different HEAD, branch or staged tree. Preparation records
live in the worktree's Git directory as `review-me-prepared.json`. If a Git commit
succeeds but clearing its review marks fails, the error identifies that commit.
After repairing storage, retrying or reopening the commit dialog finishes cleanup
without creating another commit. Tag and recent-repository JSON files are replaced
atomically after their complete contents have been written.

Resolver validation against larger local projects is opt-in. From the project root:

```bash
./scripts/make-java-sample.sh
(cd src-tauri && cargo test --lib xref_validate -- --ignored --nocapture)
./scripts/make-frontend-samples.sh
(cd src-tauri && cargo test --lib xref::js::validate::validate -- --ignored --nocapture)
```

Explicit validation requires its fixtures: missing repositories or empty samples
fail rather than passing without exercising the resolver. The two environment-driven
xref audit helpers remain ignored.

Frontend suites use Vite and headless Chromium, with no additional test dependencies.
Set `CHROME_BIN` if Chromium has a different executable name. The shared runner serves
each suite on an ephemeral loopback port and uses real browser time so layout and focus
effects run normally. Each suite has a 30-second deadline and an isolated browser profile.

`test:coverage` checks review classification and progress (it does not measure code
coverage); `test:algorithms` checks word diffs, change blocks and changed-file trees;
`test:keyboard` checks dispatch and Vim integration; `test:yank` checks clipboard yanks,
motions, counts, selections and failures; `test:review` checks review actions,
prompts, notes and focus. The existing `test:jsdoc`, `test:markdown` and `test:resolve`
commands remain available. `test:typecheck` checks both application and test TypeScript.

New suites share `tests/support.ts` and `tests/fixtures.ts`. They use real functions,
stores and components, mocking only Tauri IPC. Unexpected IPC and uncaught browser
errors fail the suite. Async regressions control promise completion explicitly;
UI tests wait for observable state or DOM conditions.
