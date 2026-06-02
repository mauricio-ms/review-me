import { create } from "zustand";

import type { TreeEntry } from "../types/repo";

const EMPTY_ENTRIES: TreeEntry[] = [];

type ProjectState = {
  /** Lazily-loaded directory listings, keyed by repo-relative dir path ("" = root). */
  dirs: Record<string, TreeEntry[]>;
  /** Repo-relative dir paths currently expanded in the tree. */
  expanded: Set<string>;
  /** The file open in the viewer (repo-relative), or null. */
  openPath: string | null;
  content: string | null;
  loadingFile: boolean;

  setDir: (path: string, entries: TreeEntry[]) => void;
  setExpanded: (path: string, open: boolean) => void;
  setOpenFile: (path: string, content: string) => void;
  setLoadingFile: (loading: boolean) => void;
  reset: () => void;
};

export const useProjectStore = create<ProjectState>((set) => ({
  dirs: {},
  expanded: new Set(),
  openPath: null,
  content: null,
  loadingFile: false,

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
  reset: () =>
    set({
      dirs: {},
      expanded: new Set(),
      openPath: null,
      content: null,
      loadingFile: false,
    }),
}));

export { EMPTY_ENTRIES };
