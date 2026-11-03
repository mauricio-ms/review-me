import type { AnchorKind, AnchorSide } from "../types/tags";

/**
 * What a mark or a note is on: lines of a file, a whole file (`side: "file"`), or the
 * commit itself (`side: "commit"`, with no file).
 */
export type DiffTarget = {
  file: string;
  lo: number;
  hi: number;
  kind: AnchorKind;
  side: AnchorSide;
};

// Module-level handle on what a note at the diff buffer's cursor is on, so `M-x note`
// can act on it without prop-drilling — the diff-buffer twin of `project-view.ts`.
let source: (() => DiffTarget | null) | null = null;

export function setDiffTargetSource(next: (() => DiffTarget | null) | null): void {
  source = next;
}

/**
 * What a note at the cursor is on: the selected lines, a line's, a hunk's, its file's
 * on a file row, the commit's on its own row — or null on a section header.
 */
export function diffTarget(): DiffTarget | null {
  return source?.() ?? null;
}

// The same, for moving the cursor: history (`M-,`) puts it back on a row.
let mover: ((path: string | null, line: number | null) => void) | null = null;

export function setDiffMover(next: ((path: string | null, line: number | null) => void) | null): void {
  mover = next;
}

/** Put the diff buffer's cursor on `path`'s row for `line` — else its file row. */
export function moveDiffCursor(path: string | null, line: number | null): void {
  mover?.(path, line);
}
