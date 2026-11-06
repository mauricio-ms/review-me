import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore } from "../state/ui";
import { useWindowStore } from "../state/windows";
import type { ChangedFile, Comparison, Hunk } from "../types/diff";
import { sameSource, type ProjectSource } from "../types/repo";
import type { AnchorSide } from "../types/tags";
import { currentFile } from "./buffers";
import { changedFileOrder } from "./changed-tree";
import { fileTarget, firstToReview, hunkTarget } from "./coverage";
import type { DiffTarget } from "./diff-view";
import {
  ambientSource,
  baseSource,
  openFileFromDiff,
  previewFile,
  revealInTree,
  sideChoice,
} from "./project";
import { blockStart, changeBlocks } from "./project-diff";
import { endVisualSelection, projectSelectionRange } from "./project-view";
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
 * or null for a revision that is neither. The new side is asked first: where a
 * comparison has no old side (a root commit) both name one revision, whose lines are
 * the new ones.
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
  await reviewWholeFile(change);
  flash(`Reviewed ${path}${leftHint()}`);
}

/** `i` in the tree: every unit of the file's change, ignored. */
export async function ignoreFile(path: string): Promise<void> {
  const change = changeOrWhy(path);
  if (!change) return;
  await ignoreWholeFile(change);
  flash(`Ignored ${path}${leftHint()}`);
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
 * The comparison's files in the changed-files tree's order (the order `] f` walks),
 * and those with something still to review, each with its first unit still to review.
 */
function filesToReview(): {
  order: ChangedFile[];
  open: { at: number; file: ChangedFile; unit: Hunk | "file" }[];
} {
  const order = changedFileOrder(useRepoStore.getState().diff?.files ?? []);
  const { reviewed, flags, ignored } = useTagsStore.getState();
  const open = order.flatMap((file, at) => {
    const unit = firstToReview(reviewed, flags, ignored, file);
    return unit ? [{ at, file, unit }] : [];
  });
  return { order, open };
}

/** What `r` and `i` add to their echo: how far the review has left to go. */
function leftHint(): string {
  const left = filesToReview().open.length;
  return left === 0 ? " — nothing left to review" : ` — ] u for the next (${left} left)`;
}

/** The line `] u` lands on in a file: where `unit` starts, as `] c` would put it. */
function unitLine(file: ChangedFile, unit: Hunk | "file"): number | undefined {
  if (unit === "file") return undefined;
  if (file.status === "deleted") return hunkTarget(unit)?.lo;
  const block = changeBlocks(file).find((b) => b.id.startsWith(`${unit.id}:`));
  return block ? blockStart(block) : unit.newStart;
}

/**
 * `] u` / `[ u` — the next or previous file with something still to review, `count`
 * on, at its first unit still to review. Files come in the changed-files tree's order,
 * walked from the file at hand (reviewed or not) — in the tree from its cursor, a folder
 * standing just above its first file — and past the last it wraps, since a file skipped
 * earlier is still waiting. The tree's cursor goes there and previews it; in a file,
 * the file opens.
 */
export function gotoFileToReview(step: 1 | -1, count = 1): void {
  const inTree = useWindowStore.getState().treeFocused;
  const from = inTree ? useProjectStore.getState().treeCursor : (currentFile()?.path ?? null);
  const { order, open } = filesToReview();
  if (open.length === 0) {
    flash(
      order.length === 0 ? "The comparison on screen changes no files" : "Nothing left to review",
    );
    return;
  }
  let here = order.findIndex((f) => f.path === from);
  if (here < 0) {
    const under = from ? order.findIndex((f) => f.path.startsWith(`${from}/`)) : -1;
    here = under >= 0 ? under - 0.5 : step > 0 ? -1 : order.length;
  }
  const ahead =
    step > 0 ? open.filter((o) => o.at > here) : open.filter((o) => o.at < here).reverse();
  const behind =
    step > 0 ? open.filter((o) => o.at <= here) : open.filter((o) => o.at >= here).reverse();
  const n = (count - 1) % open.length;
  const { file, unit } = [...ahead, ...behind][n];
  const side = file.status === "deleted" ? "old" : "new";
  const line = unitLine(file, unit);
  if (inTree) {
    revealInTree(file.path);
    void previewFile(file.path, sideChoice(side), line != null ? { line } : undefined);
  } else {
    openFileFromDiff(file.path, side, line);
  }
  const left =
    open.length === 1 ? "the last file to review" : `${open.length} files left to review`;
  const wrapped = n < ahead.length ? "" : step > 0 ? ", on from the top" : ", on from the bottom";
  flash(`${file.path} — ${left}${wrapped}`);
}

/**
 * The lines selected in the selected window's file (else the cursor's), on the side of
 * the comparison they count — or null, having said why. The new side, or the old one
 * for a deleted file: elsewhere the comparison is reviewed on its new side. Taking the
 * selection ends vim's visual mode.
 */
function viewerLines(): { path: string; side: AnchorSide; lo: number; hi: number } | null {
  const file = currentFile();
  const range = projectSelectionRange();
  endVisualSelection();
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

/** `M-x note` in a file: the lines a note would go on — the selection, else the cursor's. */
export function viewerNoteTarget(): DiffTarget | null {
  const at = viewerLines();
  return at && { file: at.path, lo: at.lo, hi: at.hi, kind: "range", side: at.side };
}

// The file at the tree's cursor, registered by `ProjectTree` (its rows say which paths
// are files), so a note can be put on it.
let treeFileSource: (() => string | null) | null = null;

export function setTreeFileSource(next: (() => string | null) | null): void {
  treeFileSource = next;
}

/** A note on the whole of `path`. */
export function wholeFileTarget(path: string): DiffTarget {
  return { file: path, lo: 0, hi: 0, kind: "file", side: "file" };
}

/**
 * `M-x note-file`, and `M-x note` in the tree: the whole file — the tree's at its
 * cursor while the tree has the keyboard, else the selected window's — or null, having
 * said why. It has to be a revision the comparison reads, like any mark.
 */
export function projectFileNoteTarget(): DiffTarget | null {
  const inTree = useWindowStore.getState().treeFocused;
  const file = inTree ? null : currentFile();
  const path = inTree ? (treeFileSource?.() ?? null) : (file?.path ?? null);
  const source = file ? file.source : useProjectStore.getState().source;
  if (!path) {
    flash(inTree ? "Not on a file" : "No file here");
    return null;
  }
  if (!sideRead(useRepoStore.getState().diff?.comparison, source)) {
    flash(`Marks go on the revision under review, not ${file?.sourceLabel ?? "this one"}`);
    return null;
  }
  return wholeFileTarget(path);
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
