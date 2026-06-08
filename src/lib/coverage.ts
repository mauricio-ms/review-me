import type { ChangedFile, Hunk } from "../types/diff";
import type { FlagTag, IgnoredTag, ReviewedTag } from "../types/tags";

export type LineRange = { lo: number; hi: number };

/** The new-side line span a hunk occupies, or null for a pure-deletion hunk. */
export function hunkNewRange(hunk: Hunk): LineRange | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const line of hunk.lines) {
    if (line.newLine != null) {
      lo = Math.min(lo, line.newLine);
      hi = Math.max(hi, line.newLine);
    }
  }
  if (lo === Infinity) return null;
  return { lo, hi };
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

function covers(
  tags: { anchor: { file: string; startLine: number; endLine: number; stale: boolean } }[],
  file: string,
  lo: number,
  hi: number,
): boolean {
  return tags.some(
    (t) =>
      !t.anchor.stale &&
      t.anchor.file === file &&
      t.anchor.startLine <= lo &&
      t.anchor.endLine >= hi,
  );
}

function overlaps(
  tags: { anchor: { file: string; startLine: number; endLine: number; stale: boolean } }[],
  file: string,
  lo: number,
  hi: number,
): boolean {
  return tags.some(
    (t) =>
      !t.anchor.stale &&
      t.anchor.file === file &&
      t.anchor.startLine <= hi &&
      t.anchor.endLine >= lo,
  );
}

export function isHunkReviewed(
  reviewed: ReviewedTag[],
  file: string,
  hunk: Hunk,
): boolean {
  const r = hunkNewRange(hunk);
  if (!r) return false;
  return covers(reviewed, file, r.lo, r.hi);
}

export function isFileReviewed(
  reviewed: ReviewedTag[],
  file: ChangedFile,
): boolean {
  if (file.hunks.length === 0) return false;
  return file.hunks.every((h) => {
    const r = hunkNewRange(h);
    // Pure-deletion hunks have no new lines to review; ignore them for coverage.
    return r ? covers(reviewed, file.path, r.lo, r.hi) : true;
  });
}

export function isLineReviewed(
  reviewed: ReviewedTag[],
  file: string,
  newLine: number,
): boolean {
  return covers(reviewed, file, newLine, newLine);
}

export function isLineFlagged(
  flags: FlagTag[],
  file: string,
  newLine: number,
): boolean {
  return covers(flags, file, newLine, newLine);
}

export function isHunkFlagged(flags: FlagTag[], file: string, hunk: Hunk): boolean {
  const r = hunkNewRange(hunk);
  if (!r) return false;
  return overlaps(flags, file, r.lo, r.hi);
}

export function isLineIgnored(
  ignored: IgnoredTag[],
  file: string,
  newLine: number,
): boolean {
  return covers(ignored, file, newLine, newLine);
}

export function isHunkIgnored(
  ignored: IgnoredTag[],
  file: string,
  hunk: Hunk,
): boolean {
  const r = hunkNewRange(hunk);
  if (!r) return false;
  return overlaps(ignored, file, r.lo, r.hi);
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

/** Section for a hunkless/binary file, which can only be flagged/ignored at file scope. */
export function sectionForFile(
  flags: FlagTag[],
  ignored: IgnoredTag[],
  file: string,
): ReviewSection {
  if (flags.some((t) => t.anchor.file === file)) return "flagged";
  if (ignored.some((t) => t.anchor.file === file)) return "ignored";
  return "toReview";
}

/** reviewed hunk count / total reviewable hunk count, across all files. */
export function reviewProgress(
  files: ChangedFile[],
  reviewed: ReviewedTag[],
): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      if (!hunkNewRange(hunk)) continue;
      total += 1;
      if (isHunkReviewed(reviewed, file.path, hunk)) done += 1;
    }
  }
  return { done, total };
}
