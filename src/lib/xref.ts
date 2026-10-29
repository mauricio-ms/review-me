import { useRepoStore } from "../state/repo";
import { useXrefStore } from "../state/xref";
import type { ProjectSource } from "../types/repo";
import type { Occurrences, XrefResult } from "../types/xref";
import { currentFile } from "./buffers";
import { recordJump } from "./jumps";
import { visitFile, type SourceChoice } from "./project";
import { projectCursor } from "./project-view";
import { findDefinition, findReferences, symbolAt, symbolOccurrences } from "./tauri";

/**
 * Cross-references resolve in the revision of the file they start from — the one in the
 * selected window — and land in files of that same revision.
 */
function ctx() {
  const repo = useRepoStore.getState().repoPath;
  const file = currentFile();
  if (!repo || !file) return null;
  const choice: SourceChoice = { source: file.source, label: file.sourceLabel };
  return { repo, source: file.source, path: file.path, choice };
}

/**
 * Open a result in the project viewer at its line, remembering where we came from.
 *
 * Recording here rather than in `gotoDefinitionAt` keeps the stack honest when the
 * disambiguation panel opens: the panel is modal and doesn't move the cursor, so the
 * position captured when the reviewer finally picks is still the origin — and
 * dismissing the panel without picking records nothing at all.
 */
export function navigateTo(result: XrefResult, choice: SourceChoice, other = false): void {
  recordJump();
  visitFile(result.file, choice, { line: result.line, col: result.col }, { other });
}


/**
 * Resolve and jump to the definition of the symbol at an explicit viewer position
 * (1-based line, 0-based col) — in this window, or the other one (`C-x 4 .`, where the
 * file you came from stays in view). Shared by `M-.` and the Ctrl/Cmd+click handler.
 */
export async function gotoDefinitionAt(line: number, col: number, other = false): Promise<void> {
  const c = ctx();
  if (!c) return;
  const symbol = await symbolAt(c.repo, c.source, c.path, line, col);
  if (!symbol) return;
  const defs = await findDefinition(c.repo, c.source, symbol);
  if (defs.length === 0) {
    useXrefStore.getState().show(`no definition for ${symbol.name}`, [], c.choice);
  } else if (defs.length === 1) {
    navigateTo(defs[0], c.choice, other);
  } else {
    // The backend couldn't decide — otherwise it would have returned exactly one.
    useXrefStore
      .getState()
      .show(`${defs.length} candidates for ${symbol.name}`, defs, c.choice, other);
  }
}

/** Go to definition of the symbol under the cursor — in the other window with `other`. */
export async function gotoDefinition(other = false): Promise<void> {
  const cursor = projectCursor();
  if (cursor) await gotoDefinitionAt(cursor.line, cursor.col, other);
}

/** Find references to the symbol under the viewer cursor. */
export async function findUsages(): Promise<void> {
  const c = ctx();
  const cursor = projectCursor();
  if (!c || !cursor) return;
  const symbol = await symbolAt(c.repo, c.source, c.path, cursor.line, cursor.col);
  if (!symbol) return;
  const refs = await findReferences(c.repo, c.source, symbol);
  const proven = refs.filter((r) => r.confirmed).length;
  const title =
    proven === refs.length
      ? `references: ${symbol.name} (${refs.length})`
      : `references: ${symbol.name} (${proven} confirmed, ${refs.length - proven} unconfirmed)`;
  useXrefStore.getState().show(title, refs, c.choice);
}

/**
 * How a viewer of `path` at `source` asks the index where the symbol at its cursor
 * occurs. Null for a file the index doesn't read — it parses Java only — whose viewer
 * matches by name without asking.
 */
export function occurrenceLookup(
  source: ProjectSource,
  path: string,
): ((line: number, col: number) => Promise<Occurrences | null>) | null {
  if (!path.endsWith(".java")) return null;
  return (line, col) => {
    const repo = useRepoStore.getState().repoPath;
    return repo ? symbolOccurrences(repo, source, path, line, col) : Promise.resolve(null);
  };
}
