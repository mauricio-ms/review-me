import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import type { ChangedFile, DiffLine, DiffSummary } from "../types/diff";
import { sameSource, type ProjectSource } from "../types/repo";
import { ambientSource } from "./project";
import { projectSelectionRange } from "./project-view";
import { refineHunk, type WordSeg } from "./word-diff";

/**
 * One contiguous change inside a hunk, in the project viewer's terms: the new-side
 * lines it wrote and the old lines it took out. Git lists a change's removed lines
 * before its added ones, so a maximal run of non-context lines is exactly one block.
 */
export type ChangeBlock = {
  /** `<hunk id>:<n>` — stable for as long as the diff is. */
  id: string;
  /** New-side lines (1-based) that replaced a removed line. */
  modified: number[];
  /** New-side lines (1-based) with no removed counterpart: wholly new. */
  added: number[];
  /** The old lines this block took out, in order. */
  removed: DiffLine[];
  /** Word segments per removed line (null: the whole line). */
  removedSegs: (WordSeg[] | null)[];
  /** Word segments for each new line, by new-side line number. */
  newSegs: Map<number, WordSeg[]>;
  /** New-side lines with their content as the diff saw it, to check the viewer's. */
  newText: Map<number, string>;
  /**
   * The new-side line the removed lines sat above — the first line the block wrote,
   * else the line that now follows the gap. Past the last line means at the end.
   */
  removedAt: number;
  /** Lines taken out *after* the block's new lines (more removed than added). */
  trailingRemoval: boolean;
};

/** Split a changed file's hunks into change blocks, in file order. */
export function changeBlocks(file: ChangedFile): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  for (const hunk of file.hunks) {
    const segs = refineHunk(hunk.lines);
    const lines = hunk.lines;
    // The last new-side line seen; a hunk that keeps no new lines starts *after*
    // its `newStart` (git's convention for an empty side).
    let prevNew = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
    let n = 0;
    let i = 0;
    while (i < lines.length) {
      if (lines[i].kind === "context") {
        prevNew = lines[i].newLine ?? prevNew;
        i++;
        continue;
      }
      const start = i;
      while (i < lines.length && lines[i].kind === "removed") i++;
      const removedEnd = i;
      while (i < lines.length && lines[i].kind === "added") i++;
      const removed = lines.slice(start, removedEnd);
      const addedLines = lines.slice(removedEnd, i);
      const newNumbers = addedLines.map((l) => l.newLine ?? 0);
      const pairs = Math.min(removed.length, addedLines.length);
      const newSegs = new Map<number, WordSeg[]>();
      const newText = new Map<number, string>();
      addedLines.forEach((line, k) => {
        const seg = segs[removedEnd + k];
        if (seg) newSegs.set(newNumbers[k], seg);
        newText.set(newNumbers[k], line.content);
      });
      blocks.push({
        id: `${hunk.id}:${n++}`,
        modified: newNumbers.slice(0, pairs),
        added: newNumbers.slice(pairs),
        removed,
        removedSegs: segs.slice(start, removedEnd),
        newSegs,
        newText,
        removedAt: newNumbers[0] ?? prevNew + 1,
        trailingRemoval: removed.length > addedLines.length && addedLines.length > 0,
      });
      if (newNumbers.length > 0) prevNew = newNumbers[newNumbers.length - 1];
    }
  }
  return blocks;
}

/**
 * The open file's change in the applied comparison — only while the viewer reads the
 * revision that comparison's new side is (a file opened at the merge base or a
 * parent shows old content the markers don't describe). Deletions and binary files
 * have no new-side lines to mark.
 */
export function changeForOpenFile(
  diff: DiffSummary | null,
  source: ProjectSource,
  openPath: string | null,
): ChangedFile | null {
  if (!diff || !openPath) return null;
  if (!sameSource(source, ambientSource(diff.comparison).source)) return null;
  const file = diff.files.find((f) => f.path === openPath);
  return file && file.status !== "deleted" && !file.binary ? file : null;
}

/** The new-side lines a block covers, for "is the cursor on it" — never empty. */
function blockSpan(block: ChangeBlock): [number, number] {
  const lines = [...block.modified, ...block.added];
  if (lines.length === 0) {
    // A pure removal sits between two lines; either one is "on" it.
    return [block.removedAt - 1, block.removedAt];
  }
  const last = lines[lines.length - 1];
  return [lines[0], block.trailingRemoval ? last + 1 : last];
}

/**
 * `:hunk` — show or hide the diff of the change(s) at the viewer's cursor or visual
 * selection. Flashes why when there is nothing there to show.
 */
export function toggleChangesAtCursor(): void {
  const ui = useUIStore.getState();
  const { source, openPath } = useProjectStore.getState();
  const change = changeForOpenFile(useRepoStore.getState().diff, source, openPath);
  const range = projectSelectionRange();
  if (!change || !range) {
    ui.showFlash(
      openPath ? "this file has no changes in the comparison on screen" : "no file open",
    );
    return;
  }
  const ids = changeBlocks(change)
    .filter((block) => {
      const [lo, hi] = blockSpan(block);
      return lo <= range.hi && hi >= range.lo;
    })
    .map((block) => block.id);
  if (ids.length === 0) {
    ui.showFlash("no change at the cursor");
    return;
  }
  useProjectStore.getState().flipChanges(ids);
}
