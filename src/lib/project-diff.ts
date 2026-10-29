import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import type { ChangedFile, DiffLine, DiffSummary } from "../types/diff";
import { sameSource, type ProjectSource } from "../types/repo";
import { currentFile } from "./buffers";
import { changedFileOrder } from "./changed-tree";
import { ambientSource, openFileFromDiff } from "./project";
import { projectCursor, projectSelectionRange, setProjectCursor } from "./project-view";
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

/** Blocks per changed file: the viewer and the mode line both ask, for every move. */
const blockCache = new WeakMap<ChangedFile, ChangeBlock[]>();

/** Split a changed file's hunks into change blocks, in file order. */
export function changeBlocks(file: ChangedFile): ChangeBlock[] {
  const cached = blockCache.get(file);
  if (cached) return cached;
  const blocks = splitBlocks(file);
  blockCache.set(file, blocks);
  return blocks;
}

function splitBlocks(file: ChangedFile): ChangeBlock[] {
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
 * A file buffer's change in the applied comparison — only when the buffer reads the
 * revision that comparison's new side is (a file read at the merge base or a parent
 * shows old content the markers don't describe). Deletions and binary files have no
 * new-side lines to mark.
 */
export function changeForFile(
  diff: DiffSummary | null,
  source: ProjectSource,
  path: string | null,
): ChangedFile | null {
  if (!diff || !path) return null;
  if (!sameSource(source, ambientSource(diff.comparison).source)) return null;
  const file = diff.files.find((f) => f.path === path);
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

/** The line a block starts on: its first new line, or the line after what it removed. */
export function blockStart(block: ChangeBlock): number {
  return block.modified[0] ?? block.added[0] ?? block.removedAt;
}

/** The block at `line` (its index), if the line is on one. */
export function changeAtLine(blocks: ChangeBlock[], line: number): number {
  return blocks.findIndex((block) => {
    const [lo, hi] = blockSpan(block);
    return line >= lo && line <= hi;
  });
}

/** The file in the selected window and its change in the comparison, or why there's none. */
function currentChange(): { change: ChangedFile } | { why: string } {
  const file = currentFile();
  const change = file
    ? changeForFile(useRepoStore.getState().diff, file.source, file.path)
    : null;
  if (change) return { change };
  return { why: file ? "This file has no changes in the comparison on screen" : "No file here" };
}

/**
 * `] c` / `[ c` (vimdiff's): the start of the next or previous change in the file, `count`
 * changes on. At the last, the echo area points on to the next changed file.
 */
export function gotoChange(step: 1 | -1, count = 1): void {
  const ui = useUIStore.getState();
  const found = currentChange();
  if ("why" in found) {
    ui.showFlash(found.why);
    return;
  }
  const line = projectCursor()?.line ?? 0;
  const starts = [...new Set(changeBlocks(found.change).map(blockStart))].sort((a, b) => a - b);
  const ahead = step > 0 ? starts.filter((s) => s > line) : starts.filter((s) => s < line).reverse();
  if (ahead.length === 0) {
    ui.showFlash(
      step > 0
        ? "No more changes below — ] f for the next changed file"
        : "No more changes above — [ f for the previous changed file",
    );
    return;
  }
  setProjectCursor(ahead[Math.min(count, ahead.length) - 1], 0, true);
}

/**
 * `] f` / `[ f` in a file: the next or previous file the comparison changed — in the
 * changed-files tree's order — opened at its first change, as `] f` walks files in the
 * diff buffer. From a file the comparison didn't change, the first (or last) one.
 */
export function gotoChangedFile(step: 1 | -1, count = 1): void {
  const ui = useUIStore.getState();
  const diff = useRepoStore.getState().diff;
  const files = changedFileOrder(diff?.files ?? []).filter((f) => !f.binary);
  if (files.length === 0) {
    ui.showFlash("The comparison on screen changes no files");
    return;
  }
  const path = currentFile()?.path;
  const at = files.findIndex((f) => f.path === path);
  if (at >= 0 && (at + step < 0 || at + step >= files.length)) {
    ui.showFlash(step > 0 ? "No more changed files" : "No earlier changed files");
    return;
  }
  const next = at < 0 ? (step > 0 ? count - 1 : files.length - count) : at + step * count;
  const target = files[Math.min(Math.max(next, 0), files.length - 1)];
  const deleted = target.status === "deleted";
  const first = deleted ? undefined : changeBlocks(target)[0];
  openFileFromDiff(target.path, deleted ? "old" : "new", first ? blockStart(first) : 1);
  ui.showFlash(`${target.path} — changed file ${files.indexOf(target) + 1}/${files.length}`);
}

/**
 * `M-x hunk` — show or hide the diff of the change(s) at the viewer's cursor or visual
 * selection. Flashes why when there is nothing there to show.
 */
export function toggleChangesAtCursor(): void {
  const ui = useUIStore.getState();
  const file = currentFile();
  const change = file
    ? changeForFile(useRepoStore.getState().diff, file.source, file.path)
    : null;
  const range = projectSelectionRange();
  if (!change || !range) {
    ui.showFlash(
      file ? "this file has no changes in the comparison on screen" : "no file here",
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
