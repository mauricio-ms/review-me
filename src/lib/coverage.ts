import type { ChangedFile, Hunk } from "../types/diff";
import type {
  Anchor,
  AnchorSide,
  FlagTag,
  IgnoredTag,
  ReviewedTag,
} from "../types/tags";

export type LineRange = { lo: number; hi: number };

/** The line side + span a reviewable hunk is tagged against. */
export type ReviewTarget = { side: AnchorSide; lo: number; hi: number };

type HunkSummary = {
  newRange: LineRange | null;
  oldRange: LineRange | null;
  pureDeletion: boolean;
};

const HUNK_SUMMARIES = new WeakMap<Hunk, HunkSummary>();

/** Diff payloads are immutable, so derive all line-range facts once per hunk. */
function hunkSummary(hunk: Hunk): HunkSummary {
  const cached = HUNK_SUMMARIES.get(hunk);
  if (cached) return cached;
  let newLo = Infinity;
  let newHi = -Infinity;
  let oldLo = Infinity;
  let oldHi = -Infinity;
  let added = 0;
  let removed = 0;
  for (const line of hunk.lines) {
    if (line.newLine != null) {
      newLo = Math.min(newLo, line.newLine);
      newHi = Math.max(newHi, line.newLine);
    }
    if (line.kind === "removed") {
      removed += 1;
      if (line.oldLine != null) {
        oldLo = Math.min(oldLo, line.oldLine);
        oldHi = Math.max(oldHi, line.oldLine);
      }
    } else if (line.kind === "added") {
      added += 1;
    }
  }
  const summary = {
    newRange: newLo === Infinity ? null : { lo: newLo, hi: newHi },
    oldRange: oldLo === Infinity ? null : { lo: oldLo, hi: oldHi },
    pureDeletion: added === 0 && removed > 0,
  };
  HUNK_SUMMARIES.set(hunk, summary);
  return summary;
}

/** The new-side line span a hunk occupies (context + added), or null when it has none. */
export function hunkNewRange(hunk: Hunk): LineRange | null {
  return hunkSummary(hunk).newRange;
}

/** The old-side (HEAD) span of a hunk's removed lines, or null when nothing is removed. */
export function hunkOldRange(hunk: Hunk): LineRange | null {
  return hunkSummary(hunk).oldRange;
}

/** The new-side span covering all of a file's hunks, or null if none. */
export function fileNewRange(file: ChangedFile): LineRange | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const hunk of file.hunks) {
    const r = hunkNewRange(hunk);
    if (r) {
      lo = Math.min(lo, r.lo);
      hi = Math.max(hi, r.hi);
    }
  }
  if (lo === Infinity) return null;
  return { lo, hi };
}

/** The old-side span covering all of a file's removed lines, or null if none. */
export function fileOldRange(file: ChangedFile): LineRange | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const hunk of file.hunks) {
    const r = hunkOldRange(hunk);
    if (r) {
      lo = Math.min(lo, r.lo);
      hi = Math.max(hi, r.hi);
    }
  }
  if (lo === Infinity) return null;
  return { lo, hi };
}

/** A hunk that removes lines without adding any — reviewed on the old (HEAD) side. */
export function isPureDeletionHunk(hunk: Hunk): boolean {
  return hunkSummary(hunk).pureDeletion;
}

/**
 * The side + line span a hunk is reviewed against: the new side for added/modified
 * hunks, the old side for pure deletions. Null for a hunk with no reviewable lines.
 */
export function hunkTarget(hunk: Hunk): ReviewTarget | null {
  if (isPureDeletionHunk(hunk)) {
    const r = hunkOldRange(hunk);
    return r ? { side: "old", lo: r.lo, hi: r.hi } : null;
  }
  const r = hunkNewRange(hunk);
  return r ? { side: "new", lo: r.lo, hi: r.hi } : null;
}

/**
 * The side + line span a whole file is flagged or ignored against: the file itself
 * when binary, else the new-side span of its hunks, else (only removals) the old-side
 * one. Null for a text file with no lines to point at.
 */
export function fileTarget(file: ChangedFile): ReviewTarget | null {
  if (file.binary) return { side: "file", lo: 0, hi: 0 };
  const nr = fileNewRange(file);
  if (nr) return { side: "new", ...nr };
  const or = fileOldRange(file);
  return or ? { side: "old", ...or } : null;
}

type Tagged = { anchor: Anchor };

/** Treat a missing side (tags written before deletion/binary support) as new-side. */
function sideOf(anchor: Anchor): AnchorSide {
  return anchor.side ?? "new";
}

function coversSide(
  tags: Tagged[],
  file: string,
  lo: number,
  hi: number,
  side: AnchorSide,
): boolean {
  return tags.some(
    (t) =>
      !t.anchor.stale &&
      sideOf(t.anchor) === side &&
      t.anchor.file === file &&
      t.anchor.startLine <= lo &&
      t.anchor.endLine >= hi,
  );
}

function overlapsSide(
  tags: Tagged[],
  file: string,
  lo: number,
  hi: number,
  side: AnchorSide,
): boolean {
  return tags.some(
    (t) =>
      !t.anchor.stale &&
      sideOf(t.anchor) === side &&
      t.anchor.file === file &&
      t.anchor.startLine <= hi &&
      t.anchor.endLine >= lo,
  );
}

/** A whole-file (binary) anchor on the path. */
function coversFile(tags: Tagged[], file: string): boolean {
  return tags.some(
    (t) => !t.anchor.stale && sideOf(t.anchor) === "file" && t.anchor.file === file,
  );
}

/** File-scope flag/ignore: any non-stale anchor on the path (used for binary files). */
function fileTagged(tags: Tagged[], file: string): boolean {
  return tags.some((t) => !t.anchor.stale && t.anchor.file === file);
}

export function isHunkReviewed(
  reviewed: ReviewedTag[],
  file: string,
  hunk: Hunk,
): boolean {
  const t = hunkTarget(hunk);
  return t ? coversSide(reviewed, file, t.lo, t.hi, t.side) : false;
}

export function isFileReviewed(
  reviewed: ReviewedTag[],
  file: ChangedFile,
): boolean {
  if (file.binary) return coversFile(reviewed, file.path);
  if (file.hunks.length === 0) return false;
  return file.hunks.every((h) => {
    const t = hunkTarget(h);
    // Hunks with no reviewable lines don't count against file coverage.
    return t ? coversSide(reviewed, file.path, t.lo, t.hi, t.side) : true;
  });
}

export function isLineReviewed(
  reviewed: ReviewedTag[],
  file: string,
  line: number,
  side: AnchorSide,
): boolean {
  return coversSide(reviewed, file, line, line, side);
}

export function isLineFlagged(
  flags: FlagTag[],
  file: string,
  line: number,
  side: AnchorSide,
): boolean {
  return coversSide(flags, file, line, line, side);
}

export function isHunkFlagged(flags: FlagTag[], file: string, hunk: Hunk): boolean {
  const t = hunkTarget(hunk);
  return t ? overlapsSide(flags, file, t.lo, t.hi, t.side) : false;
}

export function isLineIgnored(
  ignored: IgnoredTag[],
  file: string,
  line: number,
  side: AnchorSide,
): boolean {
  return coversSide(ignored, file, line, line, side);
}

export function isHunkIgnored(
  ignored: IgnoredTag[],
  file: string,
  hunk: Hunk,
): boolean {
  const t = hunkTarget(hunk);
  return t ? overlapsSide(ignored, file, t.lo, t.hi, t.side) : false;
}

/** The magit-style sections of the diff buffer, in display order. */
export type ReviewSection = "toReview" | "flagged" | "reviewed" | "ignored";

/**
 * Section a single reviewable hunk belongs in. A flag is an active concern so it
 * wins; an explicit ignore then takes a hunk out of the review flow ahead of a
 * reviewed/to-review classification.
 */
export function sectionForHunk(
  reviewed: ReviewedTag[],
  flags: FlagTag[],
  ignored: IgnoredTag[],
  file: string,
  hunk: Hunk,
): ReviewSection {
  if (isHunkFlagged(flags, file, hunk)) return "flagged";
  if (isHunkIgnored(ignored, file, hunk)) return "ignored";
  if (isHunkReviewed(reviewed, file, hunk)) return "reviewed";
  return "toReview";
}

/**
 * Section for a hunkless/binary file, reviewed/flagged/ignored at file scope. Same
 * precedence as a hunk (flagged > ignored > reviewed > to-review).
 */
export function sectionForFile(
  reviewed: ReviewedTag[],
  flags: FlagTag[],
  ignored: IgnoredTag[],
  file: string,
): ReviewSection {
  if (fileTagged(flags, file)) return "flagged";
  if (fileTagged(ignored, file)) return "ignored";
  if (coversFile(reviewed, file)) return "reviewed";
  return "toReview";
}

/**
 * A changed file's review at a glance, for project mode's changed-files tree: flagged
 * when any of its units is, done when every unit is reviewed or ignored. Units are
 * counted as the diff buffer buckets them — reviewable hunks, else the whole file.
 */
export function fileReviewState(
  reviewed: ReviewedTag[],
  flags: FlagTag[],
  ignored: IgnoredTag[],
  file: ChangedFile,
): "flagged" | "done" | "open" {
  const hunks = file.binary ? [] : file.hunks.filter((h) => hunkTarget(h) != null);
  const sections =
    hunks.length === 0
      ? [sectionForFile(reviewed, flags, ignored, file.path)]
      : hunks.map((h) => sectionForHunk(reviewed, flags, ignored, file.path, h));
  if (sections.includes("flagged")) return "flagged";
  return sections.every((s) => s === "reviewed" || s === "ignored") ? "done" : "open";
}

/** reviewed unit count / total reviewable unit count (text hunks + binary files). */
export function reviewProgress(
  files: ChangedFile[],
  reviewed: ReviewedTag[],
): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const file of files) {
    if (file.binary) {
      total += 1;
      if (coversFile(reviewed, file.path)) done += 1;
      continue;
    }
    for (const hunk of file.hunks) {
      const t = hunkTarget(hunk);
      if (!t) continue;
      total += 1;
      if (coversSide(reviewed, file.path, t.lo, t.hi, t.side)) done += 1;
    }
  }
  return { done, total };
}
