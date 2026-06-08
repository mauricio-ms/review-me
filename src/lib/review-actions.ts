import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import type { ChangedFile } from "../types/diff";
import type { AnchorKind, TagStore } from "../types/tags";
import {
  addFlagTag,
  addIgnoredTag,
  addReviewedTag,
  clearTags,
  unmarkRange,
} from "./tauri";
import { hunkNewRange } from "./coverage";

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
): Promise<void> {
  const repo = repoPath();
  if (!repo) return;
  apply(await addReviewedTag(repo, file, lo, hi, kind));
}

/** Mark every (non-pure-deletion) hunk of a file reviewed. */
export async function reviewWholeFile(file: ChangedFile): Promise<void> {
  const repo = repoPath();
  if (!repo) return;
  let store: TagStore | null = null;
  for (const hunk of file.hunks) {
    const r = hunkNewRange(hunk);
    if (!r) continue;
    store = await addReviewedTag(repo, file.path, r.lo, r.hi, "hunk");
  }
  if (store) apply(store);
}

export async function unmarkLines(
  file: string,
  lo: number,
  hi: number,
): Promise<void> {
  const repo = repoPath();
  if (!repo) return;
  apply(await unmarkRange(repo, file, lo, hi));
}

export async function addFlag(
  file: string,
  lo: number,
  hi: number,
  kind: AnchorKind,
): Promise<void> {
  const repo = repoPath();
  if (!repo) return;
  apply(await addFlagTag(repo, file, lo, hi, kind));
}

export async function addIgnore(
  file: string,
  lo: number,
  hi: number,
  kind: AnchorKind,
): Promise<void> {
  const repo = repoPath();
  if (!repo) return;
  apply(await addIgnoredTag(repo, file, lo, hi, kind));
}

/** Drop every reviewed, flag, and ignore tag in the repo. */
export async function clearAllTags(): Promise<void> {
  const repo = repoPath();
  if (!repo) return;
  apply(await clearTags(repo));
}
