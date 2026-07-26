import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import { shortOid, type Comparison } from "../types/diff";
import { WORKTREE_SOURCE, type ProjectSource } from "../types/repo";
import { listRepoDir, readFile } from "./tauri";

/** The repo + revision every project read below goes through. */
function ctx(): { repo: string; source: ProjectSource } | null {
  const repo = useRepoStore.getState().repoPath;
  return repo ? { repo, source: useProjectStore.getState().source } : null;
}

type SourceChoice = { source: ProjectSource; label: string | null };

/**
 * The revision project mode should default to for a comparison: the checkout in
 * worktree mode, the branch under review in branch mode. Opening a file from a
 * branch diff must never silently show its working-tree version.
 */
export function ambientSource(comparison: Comparison | undefined): SourceChoice {
  if (comparison?.kind !== "branches") {
    return { source: WORKTREE_SOURCE, label: null };
  }
  return {
    source: { kind: "commit", oid: comparison.targetOid },
    label: `${comparison.targetName}@${shortOid(comparison.targetOid)}`,
  };
}

/**
 * The revision that holds a branch comparison's *old* side — the merge base. Deleted
 * files and old-side navigation only exist there.
 */
export function baseSource(comparison: Comparison | undefined): SourceChoice {
  if (comparison?.kind !== "branches") {
    return { source: WORKTREE_SOURCE, label: null };
  }
  return {
    source: { kind: "commit", oid: comparison.mergeBase },
    label: `${comparison.baseName}@${shortOid(comparison.mergeBase)} (merge-base)`,
  };
}

/** Point the project buffer at a revision (no-op when it's already there). */
export function useProjectSource(choice: SourceChoice): void {
  useProjectStore.getState().setSource(choice.source, choice.label);
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

/** Open a repo-relative file in the project viewer (no buffer switch). */
export async function openProjectFile(path: string): Promise<void> {
  const c = ctx();
  if (!c) return;
  const ps = useProjectStore.getState();
  ps.setLoadingFile(true);
  try {
    ps.setOpenFile(path, await readFile(c.repo, c.source, path));
  } catch (e) {
    ps.setOpenFile(path, `// failed to read ${path}\n// ${String(e)}`);
  }
}

/** Open a file and bring the project buffer to the front (used by the finder). */
export async function openFileInProject(path: string): Promise<void> {
  await openProjectFile(path);
  const ui = useUIStore.getState();
  ui.setActiveBuffer("project");
  ui.requestFocus();
}

/**
 * Open a file from the diff buffer, first pointing project mode at the revision that
 * actually contains it: the target branch normally, the merge base for content that
 * only exists on the old side (a deletion).
 */
export async function openFileFromDiff(
  path: string,
  side: "new" | "old",
): Promise<void> {
  const comparison = useRepoStore.getState().diff?.comparison;
  useProjectSource(
    side === "old" ? baseSource(comparison) : ambientSource(comparison),
  );
  await openFileInProject(path);
}

/** Leave project mode and return to the diff buffer (its state is preserved). */
export function backToDiff(): void {
  const ui = useUIStore.getState();
  ui.setActiveBuffer("diff");
  ui.requestFocus();
}
