import {
  bufferOnScreen,
  fileBuffer,
  newFileBufferId,
  useFilesStore,
  type FileBuffer,
} from "../state/files";
import { foldersAbove, useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import {
  inProjectMode,
  isFileKey,
  onScreen,
  selectedBuffer,
  useWindowStore,
  type BufferKey,
  type FileBufferId,
  type WindowId,
} from "../state/windows";
import { shortOid, type ChangedFile, type Comparison } from "../types/diff";
import { sameSource, WORKTREE_SOURCE, type ProjectSource } from "../types/repo";
import { findFileBuffer, killFileBuffers, type ShowOptions } from "./buffers";
import { recordJump } from "./jumps";
import { armRepeat } from "./key-dispatch";
import { forgetPositions, placeCursor } from "./project-view";
import { display, focusTree, otherWindowFor, showProject, targetWindow } from "./windows";
import { listRepoDir, readFile } from "./tauri";

/** The repo + revision every project read below goes through. */
function ctx(): { repo: string; source: ProjectSource } | null {
  const repo = useRepoStore.getState().repoPath;
  return repo ? { repo, source: useProjectStore.getState().source } : null;
}

/** A revision, and how to name it. */
export type SourceChoice = { source: ProjectSource; label: string | null };

/** The revision the tree and the finder list. */
export function projectChoice(): SourceChoice {
  const { source, sourceLabel } = useProjectStore.getState();
  return { source, label: sourceLabel };
}

/**
 * The revision project mode should default to for a comparison: the checkout in
 * worktree mode, the branch under review in branch mode, the reviewed commit itself
 * in commit mode. Opening a file from a committed-history diff must never silently
 * show its working-tree version.
 */
export function ambientSource(comparison: Comparison | undefined): SourceChoice {
  switch (comparison?.kind) {
    case "branches":
      return {
        source: { kind: "commit", oid: comparison.targetOid },
        label: `${comparison.targetName}@${shortOid(comparison.targetOid)}`,
      };
    case "commit":
      return {
        source: { kind: "commit", oid: comparison.oid },
        label: comparison.branchName
          ? `${comparison.branchName}@${comparison.shortOid}`
          : comparison.shortOid,
      };
    default:
      return { source: WORKTREE_SOURCE, label: null };
  }
}

/**
 * The revision that holds a comparison's *old* side: HEAD for the working tree, the
 * merge base for a branch pair, the first parent for a single commit. Deleted files
 * and old-side navigation only exist there. A root commit (or an unborn branch) has no
 * old side, so it falls back to the new one — nothing in its diff can ask for old-side
 * content anyway.
 */
export function baseSource(comparison: Comparison | undefined): SourceChoice {
  switch (comparison?.kind) {
    case "branches":
      return {
        source: { kind: "commit", oid: comparison.mergeBase },
        label: `${comparison.baseName}@${shortOid(comparison.mergeBase)} (merge-base)`,
      };
    case "commit":
      return comparison.parentOid
        ? {
            source: { kind: "commit", oid: comparison.parentOid },
            label: `${shortOid(comparison.parentOid)} (parent of ${comparison.shortOid})`,
          }
        : ambientSource(comparison);
    case "worktree":
      return comparison.headOid
        ? {
            source: { kind: "commit", oid: comparison.headOid },
            label: `HEAD@${shortOid(comparison.headOid)}`,
          }
        : ambientSource(comparison);
    default:
      return { source: WORKTREE_SOURCE, label: null };
  }
}

/** Point the tree and the finder at a revision (no-op when they're already there). */
export function useProjectSource(choice: SourceChoice): void {
  useProjectStore.getState().setSource(choice.source, choice.label);
}

/** How far one `C-x {` / `C-x }` moves the tree's edge. */
const TREE_STEP_PX = 40;
/** The viewer keeps at least this much when the tree grows by key. */
const VIEWER_MIN_PX = 320;

/**
 * `C-x {` / `C-x }`: narrow or widen the file tree (showing it if hidden), then `{`
 * and `}` alone keep going — Emacs's shrink/enlarge-window-horizontally.
 */
export function resizeTree(step: 1 | -1): void {
  const ps = useProjectStore.getState();
  if (ps.treeHidden) ps.setTreeHidden(false);
  const max = window.innerWidth - VIEWER_MIN_PX;
  const width = Math.min(max, ps.treeWidth + step * TREE_STEP_PX);
  ps.setTreeWidth(width, true);
  useUIStore
    .getState()
    .showFlash(
      `File tree ${useProjectStore.getState().treeWidth}px — use {, } for further adjustment`,
    );
  armRepeat({ "{": () => resizeTree(-1), "}": () => resizeTree(1) });
}

/** `M-x toggle-tree`: the viewer alone, or the tree back beside it (with the keyboard). */
export function toggleTree(): void {
  const ps = useProjectStore.getState();
  if (ps.treeHidden) {
    focusTree();
    return;
  }
  ps.setTreeHidden(true);
  useWindowStore.getState().setTreeFocused(false);
  useUIStore.getState().requestFocus();
}

/** Load (or reload) a directory's children into the tree. */
export async function loadDir(path: string): Promise<void> {
  const c = ctx();
  if (!c) return;
  const epoch = useRepoStore.getState().comparisonEpoch;
  const listing = await listRepoDir(c.repo, c.source, path);
  // Neither a previous repository nor a previous revision belongs in this tree.
  const now = useRepoStore.getState();
  if (
    now.repoPath !== c.repo ||
    now.comparisonEpoch !== epoch ||
    !sameSource(useProjectStore.getState().source, c.source)
  ) return;
  useProjectStore.getState().setDir(path, listing.entries);
}

/** Ensure a directory is loaded before expanding it. */
export async function ensureDir(path: string): Promise<void> {
  if (!useProjectStore.getState().dirs[path]) await loadDir(path);
}

export async function toggleDir(path: string): Promise<void> {
  const ps = useProjectStore.getState();
  if (ps.expanded.has(path)) {
    ps.closeFolder(path);
  } else {
    await ensureDir(path);
    ps.openFolders([path]);
  }
}

/** The file on screen in the selected window — a preview counts. */
function fileOnScreen(): FileBuffer | null {
  const ws = useWindowStore.getState();
  const key = onScreen(ws, ws.selected);
  return key && isFileKey(key) ? (bufferOnScreen(useFilesStore.getState(), key) ?? null) : null;
}

/** `path`'s change in the comparison on screen — what the changed-files view lists. */
function changeAt(path: string | undefined): ChangedFile | undefined {
  return path == null ? undefined : useRepoStore.getState().diff?.files.find((f) => f.path === path);
}

/** Put the tree's cursor on `path`, opening the folders it's in. */
export function revealInTree(path: string): void {
  const ps = useProjectStore.getState();
  ps.openFolders(foldersAbove(path));
  ps.setTreeCursor(path);
}

/**
 * `C-x v c` / `M-x changed`: changed files with inline deleted lines ↔ all files
 * without deleted lines. Both views share open folders and keep the file at the cursor.
 */
export function toggleChangedOnly(): void {
  useProjectStore.getState().toggleFilter();
  const changed = useProjectStore.getState().filter === "changed";
  useUIStore.getState().showFlash(
    changed
      ? "Changed: on — changed files, deleted lines shown"
      : "Changed: off — all files, deleted lines hidden",
  );
  const path = fileOnScreen()?.path;
  if (!path) return;
  if (useProjectStore.getState().filter === "all" || changeAt(path)) revealInTree(path);
}

/**
 * `C-x C-j` (Emacs's dired-jump): the current file in the tree — its folders opened, the
 * cursor on it, the tree with the keyboard. In the diff, that's the file under the
 * cursor, which project mode then previews as the tree's cursor would; elsewhere, the
 * file in the selected window. One the changed-files view doesn't list is found among
 * all files.
 */
export function revealFile(): void {
  const ui = useUIStore.getState();
  const ws = useWindowStore.getState();
  const inDiff = !ws.treeFocused && selectedBuffer(ws) === "diff";
  const change = inDiff ? changeAt(ui.diffCursor?.path) : undefined;
  const path = inDiff ? change?.path : fileOnScreen()?.path;
  if (!path) {
    ui.showFlash("No file here");
    return;
  }
  const ps = useProjectStore.getState();
  if (ps.filter === "changed" && !changeAt(path)) {
    ps.toggleFilter();
    ui.showFlash(`${path.slice(path.lastIndexOf("/") + 1)} isn't changed — showing all files`);
  }
  if (!inProjectMode(ws)) {
    recordJump();
    showProject();
  }
  revealInTree(path);
  focusTree();
  if (change) void previewFile(change.path, sideChoice(change.status === "deleted" ? "old" : "new"));
}

/** A file's text at a revision — or, when it can't be read, a note saying why. */
async function readText(repo: string, source: ProjectSource, path: string): Promise<string> {
  try {
    return await readFile(repo, source, path);
  } catch (e) {
    return `// failed to read ${path}\n// ${String(e)}`;
  }
}

/** Read a buffer's file at its revision; a buffer re-pointed meanwhile keeps the newer read. */
async function readInto(buffer: FileBuffer): Promise<void> {
  const repo = useRepoStore.getState().repoPath;
  if (!repo) return;
  const content = await readText(repo, buffer.source, buffer.path);
  const now = fileBuffer(buffer.id);
  if (now && sameSource(now.source, buffer.source)) {
    useFilesStore.getState().update(buffer.id, { content });
  }
}

/** The file being previewed, when it's `path` at `source`. */
function previewOf(source: ProjectSource, path: string): FileBuffer | undefined {
  const fresh = useFilesStore.getState().preview;
  return fresh && fresh.path === path && sameSource(fresh.source, source) ? fresh : undefined;
}

/**
 * The buffer for `path` at a revision — the open one, else the preview of it (opened
 * now, so the window previewing it keeps its view), else a new one being read.
 */
function bufferFor(path: string, choice: SourceChoice): FileBufferId {
  const open = findFileBuffer(choice.source, path);
  if (open) return open.id;
  const preview = previewOf(choice.source, path);
  if (preview) {
    useFilesStore.getState().adopt(preview.id);
    return preview.id;
  }
  const buffer: FileBuffer = {
    id: newFileBufferId(),
    path,
    source: choice.source,
    sourceLabel: choice.label,
    content: null,
  };
  useFilesStore.getState().add(buffer);
  void readInto(buffer);
  return buffer.id;
}

/**
 * Emacs's find-file: show `path` at a revision in the selected window — or the other
 * one — in the buffer already open for it, else a new one, with the keyboard there. The
 * cursor goes to `at`, or back to where that window left the file.
 */
export function visitFile(
  path: string,
  choice: SourceChoice,
  at?: { line: number; col?: number },
  options: ShowOptions = {},
): void {
  if (!useRepoStore.getState().repoPath) return;
  const id = bufferFor(path, choice);
  const { selected } = useWindowStore.getState();
  const win = options.other ? otherWindowFor(id, selected) : targetWindow();
  // Back from the diff, the window showing it may be another one of the project's.
  const shownIn = display(id, win, options.select ?? true);
  if (at) placeCursor(shownIn, id, at.line, at.col ?? 0);
}

/** Previews asked for; a read that finishes after a newer one was asked is dropped. */
let previewSeq = 0;

/** A preview is for while the tree has the keyboard. */
function treeBrowsing(): boolean {
  const ws = useWindowStore.getState();
  return ws.treeFocused && inProjectMode(ws) && useUIStore.getState().modalDepth === 0;
}

/** Drop the file read for a preview, with every place a window had in it. */
function dropPreviewBuffer(): void {
  const fresh = useFilesStore.getState().preview;
  if (!fresh) return;
  useFilesStore.getState().setPreview(null);
  forgetPositions([fresh.id]);
}

// The file read for a preview goes with the preview — unless opening it adopted it.
useWindowStore.subscribe(() => {
  const fresh = useFilesStore.getState().preview;
  if (fresh && useWindowStore.getState().preview?.key !== fresh.id) dropPreviewBuffer();
});

// The tree's cursor follows the file in the selected window, however it came to be
// shown there — a file opened, a jump, `C-x o` to another window — as treemacs's follow
// mode does; the changed-files view only to a file it lists. While the tree has the
// keyboard its cursor leads instead; what's on screen when it lets go is followed then,
// whatever it is (`display` shows a buffer before `select` takes the keyboard from the
// tree).
let followed: BufferKey | undefined;
useWindowStore.subscribe((ws) => {
  if (ws.treeFocused) {
    followed = undefined;
    return;
  }
  const key = onScreen(ws, ws.selected);
  if (key === followed) return;
  followed = key;
  if (!key || !isFileKey(key)) return;
  const path = bufferOnScreen(useFilesStore.getState(), key)?.path;
  if (path && (useProjectStore.getState().filter === "all" || changeAt(path))) {
    revealInTree(path);
  }
});

/**
 * The tree's cursor resting on a file: show it where opening it would (`targetWindow`)
 * without opening it, the tree keeping the keyboard. A buffer already open for it is
 * shown as it stands; otherwise the file is read into the one preview buffer, which no
 * buffer list sees and the next preview replaces. When the tree lets go, the window goes
 * back to what it showed — unless it's the window that takes the keyboard
 * (`openPreview`), or the file was opened. With `at`, the file shows at that line.
 */
export async function previewFile(
  path: string,
  choice: SourceChoice,
  at?: { line: number },
): Promise<void> {
  const seq = ++previewSeq;
  const { repoPath: repo, comparisonEpoch: epoch } = useRepoStore.getState();
  const source = useProjectStore.getState().source;
  if (!repo || !treeBrowsing()) return;
  let key = (findFileBuffer(choice.source, path) ?? previewOf(choice.source, path))?.id;
  if (!key) {
    const content = await readText(repo, choice.source, path);
    const now = useRepoStore.getState();
    if (
      seq !== previewSeq ||
      !treeBrowsing() ||
      now.repoPath !== repo ||
      now.comparisonEpoch !== epoch ||
      !sameSource(useProjectStore.getState().source, source)
    ) return;
    dropPreviewBuffer();
    const buffer: FileBuffer = {
      id: newFileBufferId(),
      path,
      source: choice.source,
      sourceLabel: choice.label,
      content,
    };
    useFilesStore.getState().setPreview(buffer);
    key = buffer.id;
  }
  const win = targetWindow();
  const ws = useWindowStore.getState();
  const under = ws.shown[win];
  ws.setPreview(under === key ? null : { win, key, under });
  if (at) placeCursor(win, key, at.line);
}

/**
 * Into the window the tree is previewing a file in — a click in the file, `C-x o`,
 * `C-w l`: the file opens there, as `RET` would have opened it, and `M-,` goes back.
 * False when `win` isn't previewing anything.
 */
export function openPreview(win: WindowId): boolean {
  const preview = useWindowStore.getState().preview;
  if (preview?.win !== win) return false;
  recordJump();
  useFilesStore.getState().adopt(preview.key);
  display(preview.key, win);
  return true;
}

/** Open a file from the tree or the finder, at the revision they list (a jump `M-,` undoes). */
export function openFileInProject(path: string, options: ShowOptions = {}): void {
  if (options.select ?? true) recordJump();
  visitFile(path, projectChoice(), undefined, options);
}

/**
 * Open a file from the comparison — the diff buffer, the changed-files view — at the
 * revision that actually contains it: the comparison's new side normally, the old side
 * (merge base, first parent) for content only it has, like a deletion.
 */
export function openFileFromDiff(
  path: string,
  side: "new" | "old",
  line?: number,
  options: ShowOptions = {},
): void {
  if (options.select ?? true) recordJump();
  visitFile(path, sideChoice(side), line != null ? { line } : undefined, options);
}

/** The revision holding one side of the comparison on screen. */
export function sideChoice(side: "new" | "old"): SourceChoice {
  const comparison = useRepoStore.getState().diff?.comparison;
  return side === "old" ? baseSource(comparison) : ambientSource(comparison);
}

/**
 * Keep the open files in step with a newly applied comparison. A buffer at a revision
 * the comparison still reads stays (working-tree ones are re-read: the disk may have
 * changed); one whose revision moved under a refresh — a branch that got commits —
 * follows it; the rest belong to a review that is over and are killed, so no window is
 * left showing a revision nothing on screen is about.
 */
export function reconcileFileBuffers(
  prev: Comparison | undefined,
  next: Comparison,
  sameComparison: boolean,
): void {
  // A preview is of what was on screen before.
  useWindowStore.getState().setPreview(null);
  const now = [ambientSource(next), baseSource(next)];
  const before = prev && sameComparison ? [ambientSource(prev), baseSource(prev)] : null;
  const kill: FileBufferId[] = [];
  for (const buffer of useFilesStore.getState().buffers) {
    let choice = now.find((c) => sameSource(c.source, buffer.source));
    if (!choice && before) {
      const was = before.findIndex((c) => sameSource(c.source, buffer.source));
      if (was >= 0) choice = now[was];
    }
    if (!choice) {
      kill.push(buffer.id);
      continue;
    }
    const moved = !sameSource(choice.source, buffer.source);
    if (moved || choice.label !== buffer.sourceLabel) {
      useFilesStore
        .getState()
        .update(buffer.id, { source: choice.source, sourceLabel: choice.label });
    }
    if (moved || choice.source.kind === "worktree") {
      void readInto({ ...buffer, source: choice.source });
    }
  }
  killFileBuffers(kill);
}
