import { useNotesStore } from "../state/notes";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import type { FlagTag } from "../types/tags";
import { useUIStore } from "../state/ui";
import { activeBuffer, useWindowStore } from "../state/windows";
import { diffTarget, type DiffTarget } from "./diff-view";
import { logBase, logRef } from "./log";
import { viewerNoteTarget } from "./project-review";
import { exportNotes as exportNotesFor } from "./tauri";

/**
 * Whether review notes can be written here. A note is a fix left for later, attached
 * to lines of one commit and exported for it, so it needs a commit under review.
 */
export function notesAvailable(): boolean {
  return useRepoStore.getState().comparison.kind === "commit";
}

/** A flag note with something in it (the backend clears blank ones on save). */
export function hasNote(flag: FlagTag): boolean {
  return (flag.note ?? "").trim() !== "";
}

/**
 * The flag a note at `target` belongs to: one on exactly those lines, else the first
 * that touches them — so `M-x note` on any line of a flagged hunk edits that flag.
 */
export function flagAt(flags: FlagTag[], target: DiffTarget): FlagTag | null {
  const candidates = flags.filter(
    (f) =>
      !f.anchor.stale &&
      f.anchor.file === target.file &&
      (f.anchor.side ?? "new") === target.side,
  );
  if (target.side === "file") return candidates[0] ?? null;
  return (
    candidates.find(
      (f) => f.anchor.startLine === target.lo && f.anchor.endLine === target.hi,
    ) ??
    candidates.find(
      (f) => f.anchor.startLine <= target.hi && f.anchor.endLine >= target.lo,
    ) ??
    null
  );
}

/** The lines a flag covers, as a target. */
export function flagTarget(flag: FlagTag): DiffTarget {
  return {
    file: flag.anchor.file,
    lo: flag.anchor.startLine,
    hi: flag.anchor.endLine,
    kind: flag.anchor.kind,
    side: flag.anchor.side ?? "new",
  };
}

/** Open the note editor on `flag`'s note (double-clicking a note row). */
export function openNoteFor(flag: FlagTag): void {
  if (!notesAvailable()) return;
  useNotesStore
    .getState()
    .open({ target: flagTarget(flag), flagId: flag.id, saved: flag.note ?? "" });
}

/**
 * Open the note editor for the cursor's lines (`M-x note`) — the diff buffer's, or the
 * selected window's file's, where a visual selection is the lines: on the flag already
 * there, else on the lines themselves — the first save flags them.
 */
export function openNoteEditor(): boolean {
  if (!notesAvailable()) return false;
  const target =
    activeBuffer(useWindowStore.getState()) === "project" ? viewerNoteTarget() : diffTarget();
  if (!target) return false;
  const flag = flagAt(useTagsStore.getState().flags, target);
  useNotesStore.getState().open(
    flag
      ? { target: flagTarget(flag), flagId: flag.id, saved: flag.note ?? "" }
      : { target, flagId: null, saved: "" },
  );
  return true;
}

/**
 * `M-x export`: write every note on the commits the log lists into one Markdown file
 * (each commit's own file is kept current as notes change) and say where it went.
 */
export async function exportNotes(): Promise<void> {
  const repo = useRepoStore.getState().repoPath;
  if (!repo) return;
  const ui = useUIStore.getState();
  try {
    const result = await exportNotesFor(repo, logRef(), logBase());
    ui.showFlash(
      result.path
        ? `${result.notes} note${result.notes === 1 ? "" : "s"} on ${result.commits} commit${
            result.commits === 1 ? "" : "s"
          } → ${result.path}`
        : "no notes on this branch to export",
    );
  } catch (e) {
    ui.showFlash(`export failed: ${String(e)}`);
  }
}
