import { create } from "zustand";

import type { RememberedRepo } from "../types/repo";

/**
 * The remembered repositories, most recent first, as the backend last answered. The
 * start screen and `C-x p p` both read this one copy, so forgetting a repo in the
 * picker takes it off the start screen behind it at once.
 */
type RecentState = {
  /** Null until first read. */
  repos: RememberedRepo[] | null;
  setRepos: (repos: RememberedRepo[]) => void;
};

export const useRecentStore = create<RecentState>((set) => ({
  repos: null,
  setRepos: (repos) => set({ repos }),
}));
