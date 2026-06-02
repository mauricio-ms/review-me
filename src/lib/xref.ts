import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import { useXrefStore } from "../state/xref";
import type { XrefResult } from "../types/xref";
import { openProjectFile } from "./project";
import { projectCursor, setProjectCursor } from "./project-view";
import { findDefinition, findReferences, symbolAt } from "./tauri";

function ctx() {
  const repo = useRepoStore.getState().repoPath;
  const path = useProjectStore.getState().openPath;
  const cursor = projectCursor();
  if (!repo || !path || !cursor) return null;
  return { repo, path, cursor };
}

/** Open a result in the project viewer at its line. */
export async function navigateTo(result: XrefResult): Promise<void> {
  const ui = useUIStore.getState();
  await openProjectFile(result.file);
  ui.setActiveBuffer("project");
  // Let the viewer mount/replace its document before moving the cursor.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => setProjectCursor(result.line, result.col)),
  );
}

/** Go to definition of the symbol under the viewer cursor. */
export async function gotoDefinition(): Promise<void> {
  const c = ctx();
  if (!c) return;
  const symbol = await symbolAt(c.repo, c.path, c.cursor.line, c.cursor.col);
  if (!symbol) return;
  const defs = await findDefinition(c.repo, symbol);
  if (defs.length === 0) {
    useXrefStore.getState().show(`no definition for ${symbol.name}`, []);
  } else if (defs.length === 1) {
    await navigateTo(defs[0]);
  } else {
    useXrefStore.getState().show(`definition: ${symbol.name}`, defs);
  }
}

/** Find references to the symbol under the viewer cursor. */
export async function findUsages(): Promise<void> {
  const c = ctx();
  if (!c) return;
  const symbol = await symbolAt(c.repo, c.path, c.cursor.line, c.cursor.col);
  if (!symbol) return;
  const refs = await findReferences(c.repo, symbol);
  useXrefStore.getState().show(`references: ${symbol.name} (${refs.length})`, refs);
}
