import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import { listRepoDir, readFile } from "./tauri";

function repoPath(): string | null {
  return useRepoStore.getState().repoPath;
}

/** Load (or reload) a directory's children into the tree. */
export async function loadDir(path: string): Promise<void> {
  const repo = repoPath();
  if (!repo) return;
  const listing = await listRepoDir(repo, path);
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
  const repo = repoPath();
  if (!repo) return;
  const ps = useProjectStore.getState();
  ps.setLoadingFile(true);
  try {
    ps.setOpenFile(path, await readFile(repo, path));
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
