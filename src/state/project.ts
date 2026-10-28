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

/** The file tree's width: dragged on its edge or `C-x {` / `C-x }`, remembered. */
const TREE_WIDTH_KEY = "review-me.tree-width";
/** Whether the tree is hidden (`M-x toggle-tree`), remembered too. */
const TREE_HIDDEN_KEY = "review-me.tree-hidden";
export const TREE_WIDTH_DEFAULT = 380;
export const TREE_WIDTH_MIN = 180;

function savedTreeWidth(): number {
  try {
    const saved = Number.parseInt(window.localStorage.getItem(TREE_WIDTH_KEY) ?? "", 10);
    return Number.isFinite(saved) && saved >= TREE_WIDTH_MIN ? saved : TREE_WIDTH_DEFAULT;
  } catch {
    return TREE_WIDTH_DEFAULT;
  }
}

function saveTreeWidth(width: number): void {
  try {
    window.localStorage.setItem(TREE_WIDTH_KEY, String(width));
  } catch {
    // Best effort: the width still applies for this session.
  }
}

function savedTreeHidden(): boolean {
  try {
    return window.localStorage.getItem(TREE_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

function saveTreeHidden(hidden: boolean): void {
  try {
    window.localStorage.setItem(TREE_HIDDEN_KEY, hidden ? "1" : "0");
  } catch {
    // Best effort, as with the width.
  }
}

type ProjectState = {
  /** Lazily-loaded directory listings, keyed by repo-relative dir path ("" = root). */
  dirs: Record<string, TreeEntry[]>;
  /** Repo-relative dir paths currently expanded in the tree. */
  expanded: Set<string>;
  /**
   * The revision the tree and the finder list, and files open from them: the
   * comparison's new side (`ambientSource`). A file buffer carries its own revision —
   * a deletion is read at the old side — and xref resolves in that one.
   */
  source: ProjectSource;
  /** How to name `source` in the modeline (e.g. "feature@e780b4a"); null = worktree. */
  sourceLabel: string | null;
  /**
   * A standing preference, not a property of the revision: it survives source changes
   * (and closing the repo), so "changed" keeps following whatever is under review.
   */
  filter: ProjectFilter;
  /**
   * Show every change's removed lines inline, in every file (`M-x hunks`). Like `filter`,
   * a standing preference.
   */
  inlineDiff: boolean;
  /**
   * Change blocks (`lib/project-diff.ts`'s ids) `M-x hunk` flipped away from
   * `inlineDiff`: a block's diff shows when `inlineDiff !== inlineFlipped.has(id)`.
   */
  inlineFlipped: Set<string>;
  /** The file tree's width in px (the layout clamps it to what fits). */
  treeWidth: number;
  /** `M-x toggle-tree`: the windows alone, no tree beside them. */
  treeHidden: boolean;

  setDir: (path: string, entries: TreeEntry[]) => void;
  setExpanded: (path: string, open: boolean) => void;
  /**
   * Point the tree at a different revision. Cached listings belong to the old one, so
   * they're dropped; re-pointing at the same revision is a no-op that keeps the
   * reviewer's place.
   */
  setSource: (source: ProjectSource, label: string | null) => void;
  toggleFilter: () => void;
  /** Flip every change's inline diff, dropping per-change exceptions. */
  toggleInlineDiff: () => void;
  /** Show `ids` if any of them is hidden, else hide them all. */
  flipChanges: (ids: string[]) => void;
  /** Forget per-change exceptions (they name the changes of one comparison). */
  clearFlipped: () => void;
  /** Set the tree's width; `remember` once a drag or a key settles it. */
  setTreeWidth: (width: number, remember?: boolean) => void;
  setTreeHidden: (hidden: boolean) => void;
  reset: () => void;
};

export const useProjectStore = create<ProjectState>((set) => ({
  dirs: {},
  expanded: new Set(),
  source: WORKTREE_SOURCE,
  sourceLabel: null,
  filter: "all",
  inlineDiff: false,
  inlineFlipped: new Set(),
  treeWidth: savedTreeWidth(),
  treeHidden: savedTreeHidden(),

  setDir: (path, entries) =>
    set((s) => ({ dirs: { ...s.dirs, [path]: entries } })),
  setExpanded: (path, open) =>
    set((s) => {
      const next = new Set(s.expanded);
      if (open) next.add(path);
      else next.delete(path);
      return { expanded: next };
    }),
  setSource: (source, label) =>
    set((s) =>
      sameSource(s.source, source) && s.sourceLabel === label
        ? {}
        : {
            source,
            sourceLabel: label,
            dirs: {},
            expanded: new Set<string>(),
          },
    ),
  toggleFilter: () =>
    set((s) => ({ filter: s.filter === "all" ? "changed" : "all" })),
  toggleInlineDiff: () =>
    set((s) => ({ inlineDiff: !s.inlineDiff, inlineFlipped: new Set<string>() })),
  flipChanges: (ids) =>
    set((s) => {
      const shown = (id: string) => s.inlineDiff !== s.inlineFlipped.has(id);
      const show = !ids.every(shown);
      const next = new Set(s.inlineFlipped);
      for (const id of ids) {
        if (show !== s.inlineDiff) next.add(id);
        else next.delete(id);
      }
      return { inlineFlipped: next };
    }),
  clearFlipped: () =>
    set((s) => (s.inlineFlipped.size === 0 ? {} : { inlineFlipped: new Set<string>() })),
  setTreeWidth: (width, remember = false) => {
    const next = Math.max(TREE_WIDTH_MIN, Math.round(width));
    if (remember) saveTreeWidth(next);
    set({ treeWidth: next });
  },
  setTreeHidden: (hidden) => {
    saveTreeHidden(hidden);
    set({ treeHidden: hidden });
  },
  reset: () =>
    set({
      dirs: {},
      expanded: new Set(),
      source: WORKTREE_SOURCE,
      sourceLabel: null,
      inlineFlipped: new Set(),
    }),
}));

export { EMPTY_ENTRIES };
