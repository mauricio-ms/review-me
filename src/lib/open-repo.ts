import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore } from "../state/ui";
import { buildSymbolIndex, computeDiff, loadTags, openRepo } from "./tauri";

/**
 * Open a repository by path: load its info, compute the working-tree diff, load
 * saved review/flag tags (re-anchored), switch to the diff buffer, and focus it.
 * Throws on failure (callers surface the error).
 */
export async function openRepoByPath(path: string): Promise<void> {
  const repoStore = useRepoStore.getState();
  const ui = useUIStore.getState();
  repoStore.setStatus({ kind: "loading" });
  const info = await openRepo(path);
  repoStore.setRepo(info, info.root);
  const diff = await computeDiff(info.root);
  repoStore.setDiff(diff);
  try {
    useTagsStore.getState().setStore(await loadTags(info.root));
  } catch {
    useTagsStore.getState().clear();
  }
  // Warm the cross-reference index in the background.
  void buildSymbolIndex(info.root).catch(() => {});
  ui.setActiveBuffer("diff");
  ui.requestFocus();
}

/** Recompute the diff and reload tags for the already-open repo (`refresh`). */
export async function refreshDiff(): Promise<void> {
  const repoStore = useRepoStore.getState();
  const path = repoStore.repoPath;
  if (!path) return;
  repoStore.setStatus({ kind: "loading" });
  try {
    repoStore.setDiff(await computeDiff(path));
    useTagsStore.getState().setStore(await loadTags(path));
    void buildSymbolIndex(path).catch(() => {});
  } catch (e) {
    repoStore.setStatus({ kind: "error", message: String(e) });
  }
}
