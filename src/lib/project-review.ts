import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import type { ChangedFile, Comparison } from "../types/diff";
import { sameSource, type ProjectSource } from "../types/repo";
import type { AnchorSide } from "../types/tags";
import { currentFile } from "./buffers";
import { fileTarget, hunkTarget } from "./coverage";
import { ambientSource, baseSource } from "./project";
import { projectSelectionRange } from "./project-view";
import {
  addFlag,
  ignoreWholeFile,
  reviewWholeFile,
  unmarkLines,
  unmarkWholeFile,
} from "./review-actions";

/**
 * Reviewing in project mode: a file at a time, from the tree or from the file itself,
 * while a flag (and `u` on a selection) still points at lines. The marks go into the
 * comparison on screen, the same marks the diff buffer makes.
 */

const flash = (message: string) => useUIStore.getState().showFlash(message);

/** The comparison's change to `path`, if it changed it. */
function changeTo(path: string): ChangedFile | null {
  return useRepoStore.getState().diff?.files.find((f) => f.path === path) ?? null;
}

/**
 * Which side of `comparison` a buffer at `source` reads — what its line numbers count —
 * or null for a revision that is neither. The new side is asked first: in the
 * working-tree diff both sides read the checkout, and its lines are the new ones.
 */
export function sideRead(
  comparison: Comparison | undefined,
  source: ProjectSource,
): "new" | "old" | null {
  if (sameSource(source, ambientSource(comparison).source)) return "new";
  if (sameSource(source, baseSource(comparison).source)) return "old";
  return null;
}

/** The changed file at `path`, or why there's nothing to mark there. */
function changeOrWhy(path: string): ChangedFile | null {
  const change = changeTo(path);
  if (!change) flash(`${path} isn't changed in the comparison on screen`);
  return change;
}

/** `r` in the tree or a file: every unit of the file's change, reviewed. */
export async function reviewFile(path: string): Promise<void> {
  const change = changeOrWhy(path);
  if (!change) return;
  if (!change.binary && !change.hunks.some((h) => hunkTarget(h) != null)) {
    flash(`Nothing in ${path} to review`);
    return;
  }
  await reviewWholeFile(change);
  flash(`Reviewed ${path}`);
}

/** `i` in the tree: every unit of the file's change, ignored. */
export async function ignoreFile(path: string): Promise<void> {
  const change = changeOrWhy(path);
  if (!change) return;
  if (!change.binary && !change.hunks.some((h) => hunkTarget(h) != null)) {
    flash(`Nothing in ${path} to ignore`);
    return;
  }
  await ignoreWholeFile(change);
  flash(`Ignored ${path}`);
}

/** `f` in the tree: the file flagged, as the diff buffer's `f` on its file row does. */
export async function flagFile(path: string): Promise<void> {
  const change = changeOrWhy(path);
  if (!change) return;
  const t = fileTarget(change);
  if (!t) {
    flash(`Nothing in ${path} to flag`);
    return;
  }
  await addFlag(path, t.lo, t.hi, "file", t.side);
  flash(`Flagged ${path}`);
}

/**
 * `u` in the tree, or in a file with nothing selected: every mark off the file —
 * changed or not, since a flag can sit on code the change didn't touch.
 */
export async function unmarkFile(path: string): Promise<void> {
  const result = await unmarkWholeFile(path);
  if (result === "none") flash(`No marks on ${path}`);
  else if (result === "unmarked") flash(`Unmarked ${path}`);
}

/**
 * The lines selected in the selected window's file (else the cursor's), on the side of
 * the comparison they count — or null, having said why. The new side, or the old one
 * for a deleted file: elsewhere the comparison is reviewed on its new side.
 */
function viewerLines(): { path: string; side: AnchorSide; lo: number; hi: number } | null {
  const file = currentFile();
  const range = projectSelectionRange();
  if (!file || !range) {
    flash("No file here");
    return null;
  }
  const side = sideRead(useRepoStore.getState().diff?.comparison, file.source);
  if (side === "new" || (side === "old" && changeTo(file.path)?.status === "deleted")) {
    return { path: file.path, side, ...range };
  }
  flash(
    `Marks go on the revision under review, not ${file.sourceLabel ?? "this one"}`,
  );
  return null;
}

/** `r` in a file: the whole file reviewed. */
export async function reviewHere(): Promise<void> {
  const file = currentFile();
  if (file) await reviewFile(file.path);
  else flash("No file here");
}

/** `!` and `M-x flag` in a file: the selected lines, else the cursor's, flagged. */
export async function flagHere(): Promise<void> {
  const at = viewerLines();
  if (at) await addFlag(at.path, at.lo, at.hi, "range", at.side);
}

/** `u` in a file: the selected lines' marks, else the whole file's. */
export async function unmarkHere(selection: boolean): Promise<void> {
  if (selection) {
    const at = viewerLines();
    if (at) await unmarkLines(at.path, at.lo, at.hi, at.side);
    return;
  }
  const file = currentFile();
  if (file) await unmarkFile(file.path);
  else flash("No file here");
}
