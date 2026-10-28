import { useJumpStore } from "../state/jumps";
import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import { shortOid, type Comparison } from "../types/diff";
import { sameSource, WORKTREE_SOURCE, type ProjectSource } from "../types/repo";
import { recordJump } from "./jumps";
import { listRepoDir, readFile } from "./tauri";

/** The repo + revision every project read below goes through. */
function ctx(): { repo: string; source: ProjectSource } | null {
  const repo = useRepoStore.getState().repoPath;
  return repo ? { repo, source: useProjectStore.getState().source } : null;
}

type SourceChoice = { source: ProjectSource; label: string | null };

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

/** Point the project buffer at a revision (no-op when it's already there). */
export function useProjectSource(choice: SourceChoice): void {
  const store = useProjectStore.getState();
  // Jump entries name a file and a line in the revision they were recorded in;
  // nothing they point at survives a change of source.
  if (!sameSource(store.source, choice.source)) useJumpStore.getState().clear();
  store.setSource(choice.source, choice.label);
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

/**
 * Open a file and bring the project buffer to the front with the viewer focused, as
 * Emacs's find-file lands you in the file (used by the finder and the diff buffer).
 */
export async function openFileInProject(path: string): Promise<void> {
  recordJump();
  await openProjectFile(path);
  useProjectStore.getState().setPane("viewer");
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
