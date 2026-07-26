import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import { useXrefStore } from "../state/xref";
import type { XrefResult } from "../types/xref";
import { openProjectFile } from "./project";
import { projectCursor, setProjectCursor } from "./project-view";
import { findDefinition, findReferences, symbolAt } from "./tauri";

/** Cross-references resolve against the revision the project buffer is showing. */
function ctx() {
  const repo = useRepoStore.getState().repoPath;
  const { openPath: path, source } = useProjectStore.getState();
  const cursor = projectCursor();
  if (!repo || !path || !cursor) return null;
  return { repo, source, path, cursor };
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

/**
 * Resolve and jump to the definition of the symbol at an explicit viewer
 * position (1-based line, 0-based col). Shared by the `gd` vim action and the
 * Ctrl/Cmd+click handler.
 */
export async function gotoDefinitionAt(line: number, col: number): Promise<void> {
  const repo = useRepoStore.getState().repoPath;
  const { openPath: path, source } = useProjectStore.getState();
  if (!repo || !path) return;
  const symbol = await symbolAt(repo, source, path, line, col);
  if (!symbol) return;
  const defs = await findDefinition(repo, source, symbol);
  if (defs.length === 0) {
    useXrefStore.getState().show(`no definition for ${symbol.name}`, []);
  } else if (defs.length === 1) {
    await navigateTo(defs[0]);
  } else {
    useXrefStore.getState().show(`definition: ${symbol.name}`, defs);
  }
}

/** Go to definition of the symbol under the viewer cursor. */
export async function gotoDefinition(): Promise<void> {
  const cursor = projectCursor();
  if (cursor) await gotoDefinitionAt(cursor.line, cursor.col);
}

/** Find references to the symbol under the viewer cursor. */
export async function findUsages(): Promise<void> {
  const c = ctx();
  if (!c) return;
  const symbol = await symbolAt(c.repo, c.source, c.path, c.cursor.line, c.cursor.col);
  if (!symbol) return;
  const refs = await findReferences(c.repo, c.source, symbol);
  useXrefStore.getState().show(`references: ${symbol.name} (${refs.length})`, refs);
}
