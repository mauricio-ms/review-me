import { create } from "zustand";

import {
  sameSource,
  WORKTREE_SOURCE,
  type ProjectSource,
  type TreeEntry,
} from "../types/repo";

const EMPTY_ENTRIES: TreeEntry[] = [];

/**
 * What the tree and the finder list: the whole revision, or only the files the
 * comparison on screen changed — a commit's, a branch's, or the uncommitted ones.
 */
export type ProjectFilter = "all" | "changed";

type ProjectState = {
  /** Lazily-loaded directory listings, keyed by repo-relative dir path ("" = root). */
  dirs: Record<string, TreeEntry[]>;
  /** Repo-relative dir paths currently expanded in the tree. */
  expanded: Set<string>;
  /** The file open in the viewer (repo-relative), or null. */
  openPath: string | null;
  content: string | null;
  loadingFile: boolean;
  /**
   * The revision the tree, viewer, finder, and xref index all read from. Every
   * project read goes through it, so the buffer is never a mix of snapshots.
   */
  source: ProjectSource;
  /** How to name `source` in the modeline (e.g. "feature@e780b4a"); null = worktree. */
  sourceLabel: string | null;
  /**
   * A standing preference, not a property of the revision: it survives source changes
   * (and closing the repo), so "changed" keeps following whatever is under review.
   */
  filter: ProjectFilter;

  setDir: (path: string, entries: TreeEntry[]) => void;
  setExpanded: (path: string, open: boolean) => void;
  setOpenFile: (path: string, content: string) => void;
  setLoadingFile: (loading: boolean) => void;
  /**
   * Point the buffer at a different revision. Cached listings and the open file
   * belong to the old one, so they're dropped; re-pointing at the same revision is
   * a no-op that keeps the reviewer's place.
   */
  setSource: (source: ProjectSource, label: string | null) => void;
  toggleFilter: () => void;
  reset: () => void;
};

export const useProjectStore = create<ProjectState>((set) => ({
  dirs: {},
  expanded: new Set(),
  openPath: null,
  content: null,
  loadingFile: false,
  source: WORKTREE_SOURCE,
  sourceLabel: null,
  filter: "all",

  setDir: (path, entries) =>
    set((s) => ({ dirs: { ...s.dirs, [path]: entries } })),
  setExpanded: (path, open) =>
    set((s) => {
      const next = new Set(s.expanded);
      if (open) next.add(path);
      else next.delete(path);
      return { expanded: next };
    }),
  setOpenFile: (path, content) =>
    set({ openPath: path, content, loadingFile: false }),
  setLoadingFile: (loading) => set({ loadingFile: loading }),
  setSource: (source, label) =>
    set((s) =>
      sameSource(s.source, source) && s.sourceLabel === label
        ? {}
        : {
            source,
            sourceLabel: label,
            dirs: {},
            expanded: new Set<string>(),
            openPath: null,
            content: null,
            loadingFile: false,
          },
    ),
  toggleFilter: () =>
    set((s) => ({ filter: s.filter === "all" ? "changed" : "all" })),
  reset: () =>
    set({
      dirs: {},
      expanded: new Set(),
      openPath: null,
      content: null,
      loadingFile: false,
      source: WORKTREE_SOURCE,
      sourceLabel: null,
    }),
}));

export { EMPTY_ENTRIES };
