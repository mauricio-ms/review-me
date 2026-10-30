import { create } from "zustand";

import type { ReviewSection } from "../lib/coverage";
import { sameSpec, WORKTREE_SPEC, type DiffSpec, type DiffSummary } from "../types/diff";
import type { RepoInfo, ReviewBranch } from "../types/repo";

export type DiffStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string };

/** What is folded in the diff buffer: files open, hunks shut, sections shut. */
export type Folds = {
  expandedFiles: Set<string>;
  collapsedHunks: Set<string>;
  collapsedSections: Set<ReviewSection>;
};

type RepoState = {
  repo: RepoInfo | null;
  repoPath: string | null;
  /**
   * The branch under review — what a branch comparison targets and whose history the
   * commit picker lists. App-level only: nothing is ever checked out. Null in a repo
   * with no branches.
   */
  reviewBranch: ReviewBranch | null;
  /**
   * What the review branch is held against: the base its commits are listed over in
   * the commits buffer. Starts as the branch it tracks (else the repo's default
   * branch), and follows the review branch to its own; picking a base in `M-x compare`
   * replaces it for good, so the log and the branch diff always share one base.
   */
  reviewBase: ReviewBranch | null;
  /** Whether `M-x compare` picked `reviewBase`, rather than it following the branch. */
  reviewBaseChosen: boolean;
  diff: DiffSummary | null;
  /** The comparison currently applied — what `diff` was computed from. */
  comparison: DiffSpec;
  /**
   * Bumped whenever the applied comparison's identity changes. Buffers watch it to
   * drop cursor state that means nothing under the new comparison.
   */
  comparisonEpoch: number;
  status: DiffStatus;
  /** Repo-relative paths of files whose diff is expanded in the diff buffer. */
  expandedFiles: Set<string>;
  /** Ids of hunks whose lines are collapsed (hunks are expanded by default). */
  collapsedHunks: Set<string>;
  /** Review sections whose contents are folded (sections are expanded by default). */
  collapsedSections: Set<ReviewSection>;

  setRepo: (repo: RepoInfo, path: string) => void;
  setReviewBranch: (branch: ReviewBranch | null) => void;
  setReviewBase: (base: ReviewBranch | null, chosen: boolean) => void;
  /**
   * Commit a freshly computed comparison. Folds reset only when the comparison's
   * identity changed — a plain refresh keeps the reviewer's place.
   */
  applyComparison: (spec: DiffSpec, diff: DiffSummary) => void;
  setStatus: (status: DiffStatus) => void;
  toggleFile: (path: string) => void;
  toggleHunk: (id: string) => void;
  toggleSection: (id: ReviewSection) => void;
  setExpanded: (paths: Set<string>) => void;
  /** Every fold at once: Swiper opens what a match needs, then puts it back. */
  setFolds: (folds: Folds) => void;
  closeRepo: () => void;
};

export const useRepoStore = create<RepoState>((set) => ({
  repo: null,
  repoPath: null,
  reviewBranch: null,
  reviewBase: null,
  reviewBaseChosen: false,
  diff: null,
  comparison: WORKTREE_SPEC,
  comparisonEpoch: 0,
  status: { kind: "idle" },
  expandedFiles: new Set(),
  collapsedHunks: new Set(),
  collapsedSections: new Set(),

  setReviewBranch: (reviewBranch) => set({ reviewBranch }),
  setReviewBase: (reviewBase, reviewBaseChosen) => set({ reviewBase, reviewBaseChosen }),
  setRepo: (repo, path) =>
    set((s) =>
      s.repoPath === path
        ? { repo, repoPath: path }
        : {
            // A different repo: nothing about the old one's folds or cursor carries
            // over.
            repo,
            repoPath: path,
            comparisonEpoch: s.comparisonEpoch + 1,
            expandedFiles: new Set<string>(),
            collapsedHunks: new Set<string>(),
            collapsedSections: new Set<ReviewSection>(),
          },
    ),
  applyComparison: (spec, diff) =>
    set((s) => {
      const changed = !sameSpec(s.comparison, spec);
      return {
        diff,
        comparison: spec,
        status: { kind: "idle" },
        comparisonEpoch: changed ? s.comparisonEpoch + 1 : s.comparisonEpoch,
        ...(changed
          ? {
              expandedFiles: new Set<string>(),
              collapsedHunks: new Set<string>(),
              collapsedSections: new Set<ReviewSection>(),
            }
          : {}),
      };
    }),
  setStatus: (status) => set({ status }),
  toggleFile: (path) =>
    set((s) => {
      const next = new Set(s.expandedFiles);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expandedFiles: next };
    }),
  toggleHunk: (id) =>
    set((s) => {
      const next = new Set(s.collapsedHunks);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { collapsedHunks: next };
    }),
  toggleSection: (id) =>
    set((s) => {
      const next = new Set(s.collapsedSections);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { collapsedSections: next };
    }),
  setExpanded: (paths) => set({ expandedFiles: paths }),
  setFolds: (folds) => set(folds),
  closeRepo: () =>
    set((s) => ({
      repo: null,
      repoPath: null,
      reviewBranch: null,
      reviewBase: null,
      reviewBaseChosen: false,
      diff: null,
      comparison: WORKTREE_SPEC,
      comparisonEpoch: s.comparisonEpoch + 1,
      status: { kind: "idle" },
      expandedFiles: new Set(),
      collapsedHunks: new Set(),
      collapsedSections: new Set(),
    })),
}));
