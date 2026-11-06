import { create } from "zustand";

import type { CommitInfo, CommitReview, Coverage, LogRange } from "../types/repo";

// Module-level stable empties — never return fresh []/{} from selectors (avoids the
// Zustand infinite-rerender trap).
const EMPTY_COMMITS: CommitInfo[] = [];
const EMPTY_REVIEWS: Record<string, CommitReview> = {};

type LogState = {
  /** Invalidates pending replies on reload, range change, or repository reset. */
  epoch: number;
  /**
   * The ref whose history is listed: the review branch's canonical ref, or `HEAD`
   * when there is no branch to review. Null until the log is first loaded.
   */
  ref: string | null;
  /** The base `ref`'s commits are listed over (`reviewBase`); null for none. */
  base: string | null;
  /**
   * The part of `ref`'s history that is listed, as the backend resolved it from
   * `ref` + `base`. Null until the first page arrives.
   */
  range: LogRange | null;
  /** Loaded history, newest first — paged in as the cursor nears the end. */
  commits: CommitInfo[];
  /** The whole history is loaded; there is no further page. */
  complete: boolean;
  loading: boolean;
  error: string | null;
  /** Review progress by oid, for commits with a mark. Absent means untouched. */
  reviews: Record<string, CommitReview>;
  /** Change counts for the entire range, independently of row pagination. */
  coverage: Coverage | null;
  coverageLoading: boolean;
  coverageError: string | null;

  begin: (ref: string, base: string | null, reload?: boolean) => void;
  setPage: (
    ref: string,
    base: string | null,
    range: LogRange,
    commits: CommitInfo[],
    complete: boolean,
  ) => void;
  appendPage: (commits: CommitInfo[], complete: boolean) => void;
  setReviews: (oids: string[], reviews: CommitReview[]) => void;
  beginCoverage: () => void;
  setCoverage: (coverage: Coverage) => void;
  failCoverage: (message: string) => void;
  fail: (message: string) => void;
  reset: () => void;
};

export const useLogStore = create<LogState>((set) => ({
  epoch: 0,
  ref: null,
  base: null,
  range: null,
  commits: EMPTY_COMMITS,
  complete: false,
  loading: false,
  error: null,
  reviews: EMPTY_REVIEWS,
  coverage: null,
  coverageLoading: false,
  coverageError: null,

  begin: (ref, base, reload = false) =>
    set((s) =>
      // A different branch, or the same one over a different base, is a different
      // list: nothing on screen carries over.
      s.ref === ref && s.base === base
        ? {
            loading: true,
            error: null,
            ...(reload
              ? { epoch: s.epoch + 1, coverage: null, coverageLoading: false, coverageError: null }
              : {}),
          }
        : {
            epoch: s.epoch + 1,
            ref,
            base,
            range: null,
            loading: true,
            error: null,
            commits: EMPTY_COMMITS,
            complete: false,
            reviews: EMPTY_REVIEWS,
            coverage: null,
            coverageLoading: false,
            coverageError: null,
          },
    ),
  setPage: (ref, base, range, commits, complete) =>
    set({ ref, base, range, commits, complete, loading: false, error: null }),
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
  beginCoverage: () => set({ coverageLoading: true, coverageError: null }),
  setCoverage: (coverage) => set({ coverage, coverageLoading: false, coverageError: null }),
  failCoverage: (message) => set({ coverage: null, coverageLoading: false, coverageError: message }),
  fail: (message) => set({ loading: false, error: message }),
  reset: () =>
    set((s) => ({
      epoch: s.epoch + 1,
      ref: null,
      base: null,
      range: null,
      commits: EMPTY_COMMITS,
      complete: false,
      loading: false,
      error: null,
      reviews: EMPTY_REVIEWS,
      coverage: null,
      coverageLoading: false,
      coverageError: null,
    })),
}));
