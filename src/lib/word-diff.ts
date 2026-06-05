// Intra-line ("word") diff: given a removed line and the added line that
// replaced it, find which segments actually changed so the diff view can
// highlight just those, like git's diff-highlight / delta. Pure frontend —
// the backend still emits line-level diffs only.

import type { DiffLine } from "../types/diff";

export interface WordSeg {
  text: string;
  /** True when this segment differs between the two lines. */
  changed: boolean;
}

// Above this token count per line we skip the O(n*m) LCS and treat the whole
// line as changed — keeps very long / minified lines from stalling the UI.
const MAX_TOKENS = 800;

/** Split into runs of word chars, runs of whitespace, and single other chars. */
function tokenize(s: string): string[] {
  return s.match(/[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/g) ?? [];
}

/** Append text to `out`, merging into the last segment when the flag matches. */
function push(out: WordSeg[], text: string, changed: boolean): void {
  const last = out[out.length - 1];
  if (last && last.changed === changed) last.text += text;
  else out.push({ text, changed });
}

/** Whole-line fallback: everything is "changed". */
function whole(s: string): WordSeg[] {
  return s.length > 0 ? [{ text: s, changed: true }] : [];
}

/**
 * Token-level diff of two lines via LCS. Returns the segment breakdown for each
 * side; common tokens are `changed: false`, the rest `changed: true`.
 */
export function wordDiff(
  removedLine: string,
  addedLine: string,
): { removed: WordSeg[]; added: WordSeg[] } {
  const a = tokenize(removedLine);
  const b = tokenize(addedLine);
  const n = a.length;
  const m = b.length;
  if (n > MAX_TOKENS || m > MAX_TOKENS) {
    return { removed: whole(removedLine), added: whole(addedLine) };
  }

  // dp[i][j] = LCS length of a[i..] and b[j..].
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const removed: WordSeg[] = [];
  const added: WordSeg[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(removed, a[i], false);
      push(added, b[j], false);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(removed, a[i], true);
      i++;
    } else {
      push(added, b[j], true);
      j++;
    }
  }
  while (i < n) push(removed, a[i++], true);
  while (j < m) push(added, b[j++], true);
  return { removed, added };
}

/**
 * Refine a hunk's lines. Returns an array parallel to `lines`: each entry is the
 * word-segment breakdown for that line, or `null` when there's nothing to refine
 * (context lines, and added/removed runs with no opposing side to diff against).
 *
 * A maximal run of removed lines immediately followed by a run of added lines is
 * a "replacement"; the k-th removed line is paired with the k-th added line
 * (git's diff-highlight heuristic). Lines past the paired count have no
 * counterpart, so the whole line is marked changed (it is wholly new/old
 * content) — matching magit, which refines the replacement as one block.
 */
export function refineHunk(lines: DiffLine[]): (WordSeg[] | null)[] {
  const out: (WordSeg[] | null)[] = new Array(lines.length).fill(null);
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "removed") {
      i++;
      continue;
    }
    let r = i;
    while (r < lines.length && lines[r].kind === "removed") r++;
    let a = r;
    while (a < lines.length && lines[a].kind === "added") a++;
    const pairs = Math.min(r - i, a - r);
    for (let k = 0; k < pairs; k++) {
      const { removed, added } = wordDiff(lines[i + k].content, lines[r + k].content);
      out[i + k] = removed;
      out[r + k] = added;
    }
    // Only a genuine replacement (removed run *and* added run) has leftovers; a
    // pure deletion run stays at its base color. The unpaired tail on either
    // side is wholly new/old content, so highlight the entire line.
    if (a > r) {
      for (let k = i + pairs; k < r; k++) out[k] = whole(lines[k].content);
      for (let k = r + pairs; k < a; k++) out[k] = whole(lines[k].content);
    }
    i = a > r ? a : r;
  }
  return out;
}
