import { create } from "zustand";

import type { ReviewSection } from "../lib/coverage";
import type { DiffSummary } from "../types/diff";
import type { RepoInfo } from "../types/repo";

export type DiffStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string };

type RepoState = {
  repo: RepoInfo | null;
  repoPath: string | null;
  diff: DiffSummary | null;
  status: DiffStatus;
  /** Repo-relative paths of files whose diff is expanded in the diff buffer. */
  expandedFiles: Set<string>;
  /** Ids of hunks whose lines are collapsed (hunks are expanded by default). */
  collapsedHunks: Set<string>;
  /** Review sections whose contents are folded (sections are expanded by default). */
  collapsedSections: Set<ReviewSection>;

  setRepo: (repo: RepoInfo, path: string) => void;
  setDiff: (diff: DiffSummary) => void;
  setStatus: (status: DiffStatus) => void;
  toggleFile: (path: string) => void;
  toggleHunk: (id: string) => void;
  toggleSection: (id: ReviewSection) => void;
  setExpanded: (paths: Set<string>) => void;
  closeRepo: () => void;
};

export const useRepoStore = create<RepoState>((set) => ({
  repo: null,
  repoPath: null,
  diff: null,
  status: { kind: "idle" },
  expandedFiles: new Set(),
  collapsedHunks: new Set(),
  collapsedSections: new Set(),

  setRepo: (repo, path) => set({ repo, repoPath: path }),
  setDiff: (diff) => set({ diff, status: { kind: "idle" } }),
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
  closeRepo: () =>
    set({
      repo: null,
      repoPath: null,
      diff: null,
      status: { kind: "idle" },
      expandedFiles: new Set(),
      collapsedHunks: new Set(),
      collapsedSections: new Set(),
    }),
}));
