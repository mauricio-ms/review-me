import { useMinibufferStore } from "../state/minibuffer";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import type { ChangedFile } from "../types/diff";
import {
  scopeForSpec,
  type AnchorKind,
  type AnchorSide,
  type FlagTag,
  type ReviewScope,
  type TagStore,
} from "../types/tags";
import {
  addFlagTag,
  addIgnoredTag,
  addReviewedTag,
  clearTags,
  setFlagNote,
  unmarkRange,
} from "./tauri";
import { fileReviewState, hunkTarget } from "./coverage";
import { hasNote } from "./notes";
import type { NoteEdit } from "../state/notes";

/**
 * The repo and the comparison every mark below belongs to. Reading both together
 * keeps a mark from ever landing in a scope other than the one on screen.
 */
type Target = { repo: string; scope: ReviewScope; epoch: number };

function target(): Target | null {
  const { repoPath, comparison, comparisonEpoch } = useRepoStore.getState();
  return repoPath ? { repo: repoPath, scope: scopeForSpec(comparison), epoch: comparisonEpoch } : null;
}

function isCurrent(t: Target): boolean {
  const now = useRepoStore.getState();
  return now.repoPath === t.repo && now.comparisonEpoch === t.epoch;
}

function apply(t: Target, store: TagStore) {
  if (isCurrent(t)) useTagsStore.getState().setStore(store);
}

export async function reviewLines(
  file: string,
  lo: number,
  hi: number,
  kind: AnchorKind,
  side: AnchorSide,
): Promise<void> {
  const t = target();
  if (!t) return;
  apply(t, await addReviewedTag(t.repo, t.scope, file, lo, hi, kind, side));
}

/**
 * Mark each unit of a file: a binary file as a single file-scope unit, otherwise every
 * reviewable hunk on its own side (new for edits, old for pure deletions).
 */
async function markEachUnit(file: ChangedFile, add: typeof addReviewedTag): Promise<void> {
  const t = target();
  if (!t) return;
  let store: TagStore | null = null;
  if (file.binary) {
    store = await add(t.repo, t.scope, file.path, 0, 0, "file", "file");
  } else {
    for (const hunk of file.hunks) {
      if (!isCurrent(t)) return;
      const target = hunkTarget(hunk);
      if (!target) continue;
      store = await add(t.repo, t.scope, file.path, target.lo, target.hi, "hunk", target.side);
    }
  }
  if (store) apply(t, store);
}

/** Mark a whole file reviewed, unit by unit. */
export function reviewWholeFile(file: ChangedFile): Promise<void> {
  return markEachUnit(file, addReviewedTag);
}

/** Ignore a whole file, unit by unit — so it leaves the review however its hunks lie. */
export function ignoreWholeFile(file: ChangedFile): Promise<void> {
  return markEachUnit(file, addIgnoredTag);
}

/**
 * Ignore every generated file (`ChangedFile.generated`) still open in the review — the
 * lockfiles and bundles a change drags along — leaving flagged and finished ones be.
 * How many it ignored.
 */
export async function ignoreGeneratedFiles(): Promise<number> {
  const t = target();
  if (!t) return 0;
  const files = useRepoStore.getState().diff?.files ?? [];
  let count = 0;
  for (const file of files) {
    if (!isCurrent(t)) break;
    if (!file.generated) continue;
    const { reviewed, flags, ignored } = useTagsStore.getState();
    if (fileReviewState(reviewed, flags, ignored, file) !== "open") continue;
    await ignoreWholeFile(file);
    count += 1;
  }
  return count;
}

/** Ask a `y` / `n` question in the minibuffer. */
function yOrN(prompt: string): Promise<boolean> {
  return new Promise((resolve) =>
    useMinibufferStore.getState().open({ kind: "confirm", prompt, onAnswer: resolve }),
  );
}

/**
 * Whether an unmark that takes `notes` with it may go ahead: at once when it takes
 * none, else only on a `y` — a note is writing nothing can bring back.
 */
function mayDeleteNotes(notes: FlagTag[], where: string): Promise<boolean> {
  if (notes.length === 0) return Promise.resolve(true);
  const what = notes.length === 1 ? "the note" : `${notes.length} notes`;
  return yOrN(`Unmark and delete ${what} on ${where}?`);
}

/**
 * Take every mark on `side` that touches the lines (`unmark_range`'s rule) — on a
 * whole-file side the file's, on the commit side the commit's — asking first when that
 * deletes a note.
 */
export async function unmarkLines(
  file: string,
  lo: number,
  hi: number,
  side: AnchorSide,
): Promise<void> {
  const t = target();
  if (!t) return;
  const notes = useTagsStore
    .getState()
    .flags.filter(
      (f) =>
        hasNote(f) &&
        f.anchor.file === file &&
        (f.anchor.side ?? "new") === side &&
        (side === "file" ||
          side === "commit" ||
          (f.anchor.startLine <= hi && f.anchor.endLine >= lo)),
    );
  if (!(await mayDeleteNotes(notes, side === "commit" ? "the commit" : file))) return;
  if (!isCurrent(t)) return;
  apply(t, await unmarkRange(t.repo, t.scope, file, lo, hi, side));
}

/**
 * Take every mark off a file — reviewed, flagged and ignored, on either side — asking
 * first when that deletes a note. Says whether there was anything to take, and whether
 * it went.
 */
export async function unmarkWholeFile(file: string): Promise<"unmarked" | "none" | "kept"> {
  const t = target();
  if (!t) return "kept";
  const { reviewed, flags, ignored } = useTagsStore.getState();
  // Per side, the span its marks cover: one `unmark_range` each.
  const spans = new Map<AnchorSide, { lo: number; hi: number }>();
  for (const { anchor } of [...reviewed, ...flags, ...ignored]) {
    if (anchor.file !== file) continue;
    const side = anchor.side ?? "new";
    const span = spans.get(side);
    spans.set(side, {
      lo: Math.min(span?.lo ?? Infinity, anchor.startLine),
      hi: Math.max(span?.hi ?? -Infinity, anchor.endLine),
    });
  }
  if (spans.size === 0) return "none";
  const notes = flags.filter((f) => f.anchor.file === file && hasNote(f));
  if (!(await mayDeleteNotes(notes, file))) return "kept";
  if (!isCurrent(t)) return "kept";
  let store: TagStore | null = null;
  for (const [side, { lo, hi }] of spans) {
    if (!isCurrent(t)) return "kept";
    store = await unmarkRange(t.repo, t.scope, file, lo, hi, side);
  }
  if (store) apply(t, store);
  return isCurrent(t) ? "unmarked" : "kept";
}

/**
 * Flag lines. Flagging lines that already carry a flag re-anchors it and keeps its
 * note: `add_flag` replaces a flag on the same lines, and the note would go with it.
 */
export async function addFlag(
  file: string,
  lo: number,
  hi: number,
  kind: AnchorKind,
  side: AnchorSide,
): Promise<void> {
  const t = target();
  if (!t) return;
  const existing = useTagsStore
    .getState()
    .flags.find(
      (f) =>
        f.anchor.file === file &&
        (f.anchor.side ?? "new") === side &&
        f.anchor.startLine === lo &&
        f.anchor.endLine === hi,
    );
  apply(
    t,
    await addFlagTag(
      t.repo,
      t.scope,
      file,
      lo,
      hi,
      kind,
      side,
      existing?.note ?? null,
      existing?.severity ?? null,
    ),
  );
}

/**
 * Save a note: onto its flag, or — the first time — by flagging the note's lines with
 * it. Saving an empty note clears it from an existing flag (the flag stays; `u`
 * removes it) and creates nothing otherwise. Returns the flag the note is on.
 */
export async function saveNote(edit: NoteEdit, text: string): Promise<string | null> {
  const t = target();
  if (!t) return null;
  const note = text.trim() === "" ? null : text.trimEnd();
  const { file, lo, hi, kind, side } = edit.target;
  if (edit.flagId) {
    apply(t, await setFlagNote(t.repo, t.scope, edit.flagId, note));
    return isCurrent(t) ? edit.flagId : null;
  }
  if (!note) return null;
  const store = await addFlagTag(t.repo, t.scope, file, lo, hi, kind, side, note, null);
  if (!isCurrent(t)) return null;
  apply(t, store);
  const created = store.flags.find(
    (f) =>
      f.anchor.file === file &&
      f.anchor.side === side &&
      f.anchor.startLine === lo &&
      f.anchor.endLine === hi,
  );
  return created?.id ?? null;
}

export async function addIgnore(
  file: string,
  lo: number,
  hi: number,
  kind: AnchorKind,
  side: AnchorSide,
): Promise<void> {
  const t = target();
  if (!t) return;
  apply(t, await addIgnoredTag(t.repo, t.scope, file, lo, hi, kind, side));
}

/** Drop every reviewed, flag, and ignore tag in the active comparison. */
export async function clearActiveComparisonTags(): Promise<void> {
  const t = target();
  if (!t) return;
  apply(t, await clearTags(t.repo, t.scope));
}
