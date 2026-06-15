import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import type { ChangedFile } from "../types/diff";
import type { AnchorKind, AnchorSide, TagStore } from "../types/tags";
import {
  addFlagTag,
  addIgnoredTag,
  addReviewedTag,
  clearTags,
  unmarkRange,
} from "./tauri";
import { hunkTarget } from "./coverage";

function repoPath(): string | null {
  return useRepoStore.getState().repoPath;
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
  const repo = repoPath();
  if (!repo) return;
  apply(await addReviewedTag(repo, file, lo, hi, kind, side));
}

/**
 * Mark a whole file reviewed: a binary file as a single file-scope unit, otherwise
 * every reviewable hunk on its own side (new for edits, old for pure deletions).
 */
export async function reviewWholeFile(file: ChangedFile): Promise<void> {
  const repo = repoPath();
  if (!repo) return;
  let store: TagStore | null = null;
  if (file.binary) {
    store = await addReviewedTag(repo, file.path, 0, 0, "file", "file");
  } else {
    for (const hunk of file.hunks) {
      const t = hunkTarget(hunk);
      if (!t) continue;
      store = await addReviewedTag(repo, file.path, t.lo, t.hi, "hunk", t.side);
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
  const repo = repoPath();
  if (!repo) return;
  apply(await unmarkRange(repo, file, lo, hi, side));
}

export async function addFlag(
  file: string,
  lo: number,
  hi: number,
  kind: AnchorKind,
  side: AnchorSide,
): Promise<void> {
  const repo = repoPath();
  if (!repo) return;
  apply(await addFlagTag(repo, file, lo, hi, kind, side));
}

export async function addIgnore(
  file: string,
  lo: number,
  hi: number,
  kind: AnchorKind,
  side: AnchorSide,
): Promise<void> {
  const repo = repoPath();
  if (!repo) return;
  apply(await addIgnoredTag(repo, file, lo, hi, kind, side));
}

/** Drop every reviewed, flag, and ignore tag in the repo. */
export async function clearAllTags(): Promise<void> {
  const repo = repoPath();
  if (!repo) return;
  apply(await clearTags(repo));
}
