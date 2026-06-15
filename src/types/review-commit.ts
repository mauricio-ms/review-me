import type { TagStore } from "./tags";

export interface ReviewedCommitPreflight {
  stagedPaths: string[];
  reviewedHunkCount: number;
  reviewedPaths: string[];
  unsupportedReviewedCount: number;
}

export interface PreparedReviewedCommit {
  stagedPaths: string[];
  reviewedTagIds: string[];
  hunkCount: number;
  unsupportedReviewedCount: number;
}

export interface ReviewedCommitResult {
  commit: string;
  tagStore: TagStore;
}
