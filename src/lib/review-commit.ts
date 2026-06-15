import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import type {
  PreparedReviewedCommit,
  ReviewedCommitPreflight,
  ReviewedCommitResult,
} from "../types/review-commit";
import { refreshDiff } from "./open-repo";
import {
  abortReviewedCommit,
  commitReviewedChanges,
  prepareReviewedCommit,
  reviewedCommitPreflight,
} from "./tauri";

function repoPath(): string {
  const repo = useRepoStore.getState().repoPath;
  if (!repo) throw new Error("no repository open");
  return repo;
}

export function preflightReviewedCommit(): Promise<ReviewedCommitPreflight> {
  return reviewedCommitPreflight(repoPath());
}

export function stageReviewedCommit(
  unstageExisting: boolean,
): Promise<PreparedReviewedCommit> {
  return prepareReviewedCommit(repoPath(), unstageExisting);
}

export async function cancelReviewedCommit(): Promise<void> {
  await abortReviewedCommit(repoPath());
  await refreshDiff();
}

export async function finishReviewedCommit(
  message: string,
  reviewedTagIds: string[],
): Promise<ReviewedCommitResult> {
  const result = await commitReviewedChanges(repoPath(), message, reviewedTagIds);
  useTagsStore.getState().setStore(result.tagStore);
  await refreshDiff();
  return result;
}
