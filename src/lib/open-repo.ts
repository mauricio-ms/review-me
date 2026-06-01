import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import { computeDiff, openRepo } from "./tauri";

/**
 * Open a repository by path: load its info, compute the working-tree diff, switch
 * to the diff buffer, and focus it. Throws on failure (callers surface the error).
 */
export async function openRepoByPath(path: string): Promise<void> {
  const repoStore = useRepoStore.getState();
  const ui = useUIStore.getState();
  repoStore.setStatus({ kind: "loading" });
  const info = await openRepo(path);
  repoStore.setRepo(info, info.root);
  const diff = await computeDiff(info.root);
  repoStore.setDiff(diff);
  ui.setActiveBuffer("diff");
  ui.requestFocus();
}

/** Recompute the diff for the already-open repo (the `refresh` command). */
export async function refreshDiff(): Promise<void> {
  const repoStore = useRepoStore.getState();
  const path = repoStore.repoPath;
  if (!path) return;
  repoStore.setStatus({ kind: "loading" });
  try {
    const diff = await computeDiff(path);
    repoStore.setDiff(diff);
  } catch (e) {
    repoStore.setStatus({ kind: "error", message: String(e) });
  }
}
