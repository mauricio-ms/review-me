import { fileBuffer, newFileBufferId, useFilesStore, type FileBuffer } from "../state/files";
import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import { useWindowStore, type FileBufferId } from "../state/windows";
import { shortOid, type Comparison } from "../types/diff";
import { sameSource, WORKTREE_SOURCE, type ProjectSource } from "../types/repo";
import { findFileBuffer, killFileBuffers, type ShowOptions } from "./buffers";
import { recordJump } from "./jumps";
import { armRepeat } from "./key-dispatch";
import { placeCursor } from "./project-view";
import { display, focusTree, otherWindowFor } from "./windows";
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
 * The revision that holds a comparison's *old* side: the merge base for a branch
 * pair, the first parent for a single commit. Deleted files and old-side navigation
 * only exist there. A root commit has no old side, so it falls back to the commit
 * itself — nothing in its diff can ask for old-side content anyway.
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

/** `M-x toggle-tree`: the windows alone, or the tree back beside them (with the keyboard). */
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
  const listing = await listRepoDir(c.repo, c.source, path);
  useProjectStore.getState().setDir(path, listing.entries);
}

/** Ensure a directory is loaded before expanding it. */
export async function ensureDir(path: string): Promise<void> {
  if (!useProjectStore.getState().dirs[path]) await loadDir(path);
}

export async function toggleDir(path: string): Promise<void> {
  const ps = useProjectStore.getState();
  if (ps.expanded.has(path)) {
    ps.setExpanded(path, false);
  } else {
    await ensureDir(path);
    ps.setExpanded(path, true);
  }
}

/** Read a buffer's file at its revision; a buffer re-pointed meanwhile keeps the newer read. */
async function readInto(buffer: FileBuffer): Promise<void> {
  const repo = useRepoStore.getState().repoPath;
  if (!repo) return;
  let content: string;
  try {
    content = await readFile(repo, buffer.source, buffer.path);
  } catch (e) {
    content = `// failed to read ${buffer.path}\n// ${String(e)}`;
  }
  const now = fileBuffer(buffer.id);
  if (now && sameSource(now.source, buffer.source)) {
    useFilesStore.getState().update(buffer.id, { content });
  }
}

/** The buffer for `path` at a revision — the open one, else a new one being read. */
function bufferFor(path: string, choice: SourceChoice): FileBufferId {
  const open = findFileBuffer(choice.source, path);
  if (open) return open.id;
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
  const win = options.other ? otherWindowFor(id, selected) : selected;
  if (at) placeCursor(win, id, at.line, at.col ?? 0);
  display(id, win, options.select ?? true);
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
  const comparison = useRepoStore.getState().diff?.comparison;
  if (options.select ?? true) recordJump();
  visitFile(
    path,
    side === "old" ? baseSource(comparison) : ambientSource(comparison),
    line != null ? { line } : undefined,
    options,
  );
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
