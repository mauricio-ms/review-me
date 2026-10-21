import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import type { ChangedFile } from "../types/diff";
import {
  scopeForSpec,
  type AnchorKind,
  type AnchorSide,
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
import { hunkTarget } from "./coverage";
import type { NoteEdit } from "../state/notes";

/**
 * The repo and the comparison every mark below belongs to. Reading both together
 * keeps a mark from ever landing in a scope other than the one on screen.
 */
function target(): { repo: string; scope: ReviewScope } | null {
  const { repoPath, comparison } = useRepoStore.getState();
  return repoPath ? { repo: repoPath, scope: scopeForSpec(comparison) } : null;
}

function apply(store: TagStore) {
  useTagsStore.getState().setStore(store);
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
  apply(await addReviewedTag(t.repo, t.scope, file, lo, hi, kind, side));
}

/**
 * Mark a whole file reviewed: a binary file as a single file-scope unit, otherwise
 * every reviewable hunk on its own side (new for edits, old for pure deletions).
 */
export async function reviewWholeFile(file: ChangedFile): Promise<void> {
  const t = target();
  if (!t) return;
  let store: TagStore | null = null;
  if (file.binary) {
    store = await addReviewedTag(t.repo, t.scope, file.path, 0, 0, "file", "file");
  } else {
    for (const hunk of file.hunks) {
      const target = hunkTarget(hunk);
      if (!target) continue;
      store = await addReviewedTag(
        t.repo,
        t.scope,
        file.path,
        target.lo,
        target.hi,
        "hunk",
        target.side,
      );
    }
  }
  if (store) apply(store);
}

export async function unmarkLines(
  file: string,
  lo: number,
  hi: number,
  side: AnchorSide,
): Promise<void> {
  const t = target();
  if (!t) return;
  apply(await unmarkRange(t.repo, t.scope, file, lo, hi, side));
}

export async function addFlag(
  file: string,
  lo: number,
  hi: number,
  kind: AnchorKind,
  side: AnchorSide,
): Promise<void> {
  const t = target();
  if (!t) return;
  apply(await addFlagTag(t.repo, t.scope, file, lo, hi, kind, side));
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
    apply(await setFlagNote(t.repo, t.scope, edit.flagId, note));
    return edit.flagId;
  }
  if (!note) return null;
  const store = await addFlagTag(t.repo, t.scope, file, lo, hi, kind, side, note, null);
  apply(store);
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
  apply(await addIgnoredTag(t.repo, t.scope, file, lo, hi, kind, side));
}

/** Drop every reviewed, flag, and ignore tag in the active comparison. */
export async function clearActiveComparisonTags(): Promise<void> {
  const t = target();
  if (!t) return;
  apply(await clearTags(t.repo, t.scope));
}
