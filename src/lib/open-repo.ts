import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore } from "../state/ui";
import { WORKTREE_SPEC, type DiffSpec } from "../types/diff";
import { scopeForSpec } from "../types/tags";
import { buildSymbolIndex, computeDiff, loadTags, openRepo } from "./tauri";

/**
 * Guards against an older comparison request landing after a newer one. Every
 * `applyComparison` call claims a ticket; only the newest may write to the stores.
 */
let requestSeq = 0;

/**
 * Compute `spec` and load its tags, then commit both to the stores at once. Nothing
 * is applied unless the whole load succeeds, so a failed comparison leaves the
 * previous one on screen (with the error in the diff status). Throws so callers —
 * the branch picker in particular — can surface the failure without closing.
 */
export async function applyComparison(spec: DiffSpec): Promise<void> {
  const repoStore = useRepoStore.getState();
  const path = repoStore.repoPath;
  if (!path) return;
  const ticket = ++requestSeq;
  repoStore.setStatus({ kind: "loading" });
  try {
    const diff = await computeDiff(path, spec);
    const tags = await loadTags(path, scopeForSpec(spec));
    if (ticket !== requestSeq) return; // a newer selection already won
    useRepoStore.getState().applyComparison(spec, diff);
    useTagsStore.getState().setStore(tags);
    void buildSymbolIndex(path).catch(() => {});
  } catch (e) {
    if (ticket === requestSeq) {
      useRepoStore.getState().setStatus({ kind: "error", message: String(e) });
    }
    throw e;
  }
}

/**
 * Open a repository by path: load its info, apply the working-tree comparison (a
 * fresh open always starts there), switch to the diff buffer, and focus it. Throws
 * on failure (callers surface the error).
 */
export async function openRepoByPath(path: string): Promise<void> {
  const repoStore = useRepoStore.getState();
  const ui = useUIStore.getState();
  repoStore.setStatus({ kind: "loading" });
  const info = await openRepo(path);
  repoStore.setRepo(info, info.root);
  await applyComparison(WORKTREE_SPEC);
  ui.setActiveBuffer("diff");
  ui.requestFocus();
}

/** Recompute the comparison currently applied and reload its tags (`refresh`). */
export async function refreshDiff(): Promise<void> {
  const { repoPath, comparison } = useRepoStore.getState();
  if (!repoPath) return;
  // applyComparison already records the failure in the diff status.
  await applyComparison(comparison).catch(() => {});
}
