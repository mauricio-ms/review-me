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

/** The folders above a repo-relative path, outermost first: `a/b/c.ts` → `a`, `a/b`. */
export function foldersAbove(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

type ProjectState = {
  /** Lazily-loaded directory listings, keyed by repo-relative dir path ("" = root). */
  dirs: Record<string, TreeEntry[]>;
  /**
   * The folders open in the tree, by repo-relative path: one set for both views (all
   * files, changed), so switching between them keeps what's open. It outlives a change of
   * revision too — a folder that revision lacks just isn't listed.
   */
  expanded: Set<string>;
  /**
   * The path the tree's cursor is on. Kept as a path, so the cursor stays on its row as
   * folders open and listings arrive; while that row isn't shown, the cursor sits on the
   * nearest folder that is.
   */
  treeCursor: string | null;
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
  /** `M-x toggle-tree`: the viewer alone. */
  treeHidden: boolean;

  setDir: (path: string, entries: TreeEntry[]) => void;
  /**
   * Open folders — each with every folder above it, so either view finds the whole way
   * down open, however it groups folder chains.
   */
  openFolders: (paths: string[]) => void;
  closeFolder: (path: string) => void;
  setTreeCursor: (path: string | null) => void;
  /**
   * Point the tree at a different revision. Cached listings belong to the old one, so
   * they're dropped (the open folders and the cursor stay); re-pointing at the same
   * revision is a no-op.
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
  treeCursor: null,
  source: WORKTREE_SOURCE,
  sourceLabel: null,
  filter: "all",
  inlineDiff: false,
  inlineFlipped: new Set(),
  treeWidth: savedTreeWidth(),
  treeHidden: false,

  setDir: (path, entries) =>
    set((s) => ({ dirs: { ...s.dirs, [path]: entries } })),
  openFolders: (paths) =>
    set((s) => {
      const wanted = paths.flatMap((path) => [...foldersAbove(path), path]);
      if (wanted.every((path) => s.expanded.has(path))) return {};
      return { expanded: new Set([...s.expanded, ...wanted]) };
    }),
  closeFolder: (path) =>
    set((s) => {
      if (!s.expanded.has(path)) return {};
      const next = new Set(s.expanded);
      next.delete(path);
      return { expanded: next };
    }),
  setTreeCursor: (path) => set({ treeCursor: path }),
  setSource: (source, label) =>
    set((s) =>
      sameSource(s.source, source) && s.sourceLabel === label
        ? {}
        : { source, sourceLabel: label, dirs: {} },
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
  setTreeHidden: (hidden) => set({ treeHidden: hidden }),
  reset: () =>
    set({
      dirs: {},
      expanded: new Set(),
      treeCursor: null,
      source: WORKTREE_SOURCE,
      sourceLabel: null,
      inlineFlipped: new Set(),
    }),
}));

export { EMPTY_ENTRIES };
