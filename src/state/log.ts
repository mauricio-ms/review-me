import { create } from "zustand";

import type { CommitInfo, CommitReview } from "../types/repo";

// Module-level stable empties — never return fresh []/{} from selectors (avoids the
// Zustand infinite-rerender trap).
const EMPTY_COMMITS: CommitInfo[] = [];
const EMPTY_REVIEWS: Record<string, CommitReview> = {};

type LogState = {
  /**
   * The ref whose history is listed: the review branch's canonical ref, or `HEAD`
   * when there is no branch to review. Null until the log is first loaded.
   */
  ref: string | null;
  /** Loaded history, newest first — paged in as the cursor nears the end. */
  commits: CommitInfo[];
  /** The whole history is loaded; there is no further page. */
  complete: boolean;
  loading: boolean;
  error: string | null;
  /** Review progress by oid, for commits with a mark. Absent means untouched. */
  reviews: Record<string, CommitReview>;

  begin: (ref: string) => void;
  setPage: (ref: string, commits: CommitInfo[], complete: boolean) => void;
  appendPage: (commits: CommitInfo[], complete: boolean) => void;
  setReviews: (oids: string[], reviews: CommitReview[]) => void;
  fail: (message: string) => void;
  reset: () => void;
};

export const useLogStore = create<LogState>((set) => ({
  ref: null,
  commits: EMPTY_COMMITS,
  complete: false,
  loading: false,
  error: null,
  reviews: EMPTY_REVIEWS,

  begin: (ref) =>
    set((s) =>
      // A different branch's history shares nothing with the one on screen.
      s.ref === ref
        ? { loading: true, error: null }
        : {
            ref,
            loading: true,
            error: null,
            commits: EMPTY_COMMITS,
            complete: false,
            reviews: EMPTY_REVIEWS,
          },
    ),
  setPage: (ref, commits, complete) =>
    set({ ref, commits, complete, loading: false, error: null }),
  appendPage: (commits, complete) =>
    set((s) => ({
      commits: [...s.commits, ...commits],
      complete,
      loading: false,
      error: null,
    })),
  // `oids` were all asked about: any that came back without a review lost their last
  // mark, so they are dropped rather than left showing stale progress.
  setReviews: (oids, reviews) =>
    set((s) => {
      const next = { ...s.reviews };
      for (const oid of oids) delete next[oid];
      for (const review of reviews) next[review.oid] = review;
      return { reviews: next };
    }),
  fail: (message) => set({ loading: false, error: message }),
  reset: () =>
    set({
      ref: null,
      commits: EMPTY_COMMITS,
      complete: false,
      loading: false,
      error: null,
      reviews: EMPTY_REVIEWS,
    }),
}));
