import type { DiffSpec } from "./diff";

export type AnchorKind = "file" | "hunk" | "range";

/**
 * Which comparison a tag was made against. Marks are scoped so reviewing
 * `master...feature` never marks the same lines as reviewed in the working-tree diff
 * (or in a different branch pair, or in a single commit). For a branch pair the ref
 * names — not oids — are the durable identity: a branch that moves is still the same
 * review. A single commit is identified by its full oid, which cannot move at all, and
 * deliberately not by the branch it was picked from.
 */
export type ReviewScope =
  | { kind: "worktree" }
  | { kind: "branches"; baseRef: string; targetRef: string }
  | { kind: "commit"; oid: string };

export const WORKTREE_SCOPE: ReviewScope = { kind: "worktree" };

/** The review scope a comparison's marks belong to. */
export function scopeForSpec(spec: DiffSpec): ReviewScope {
  switch (spec.kind) {
    case "worktree":
      return WORKTREE_SCOPE;
    case "branches":
      return {
        kind: "branches",
        baseRef: spec.baseRef,
        targetRef: spec.targetRef,
      };
    case "commit":
      return { kind: "commit", oid: spec.oid };
  }
}

/**
 * Which side of the diff an anchor's content lives on. `new` anchors to the
 * working-tree file (added/modified hunks); `old` anchors to HEAD content
 * (pure-deletion hunks and deleted text files); `file` anchors a whole binary-file
 * change by blob identity.
 */
export type AnchorSide = "new" | "old" | "file";

export interface Anchor {
  file: string;
  /**
   * 1-based inclusive line range. New-side anchors index the working-tree file,
   * old-side anchors index HEAD content, and file anchors ignore these (0,0).
   */
  startLine: number;
  endLine: number;
  contentHash: string;
  contextBefore: string[];
  contextAfter: string[];
  kind: AnchorKind;
  side: AnchorSide;
  /** The comparison this mark belongs to. */
  scope: ReviewScope;
  /** Set by re-anchoring when the captured content can no longer be found. */
  stale: boolean;
}

export interface ReviewedTag {
  id: string;
  anchor: Anchor;
  createdAt: number;
  note: string | null;
}

export interface FlagTag {
  id: string;
  anchor: Anchor;
  createdAt: number;
  note: string | null;
  severity: string | null;
}

export interface IgnoredTag {
  id: string;
  anchor: Anchor;
  createdAt: number;
  note: string | null;
}

export interface TagStore {
  version: number;
  reviewed: ReviewedTag[];
  flags: FlagTag[];
  ignored: IgnoredTag[];
}

/** What `:export` wrote. Mirrors `notes::NotesExport`. */
export interface NotesExport {
  /** Repo-relative path of the bundle; null when the branch has no notes. */
  path: string | null;
  commits: number;
  notes: number;
}

export const EMPTY_TAG_STORE: TagStore = {
  version: 1,
  reviewed: [],
  flags: [],
  ignored: [],
};
