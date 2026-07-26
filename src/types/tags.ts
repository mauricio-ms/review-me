import type { DiffSpec } from "./diff";

export type AnchorKind = "file" | "hunk" | "range";

/**
 * Which comparison a tag was made against. Marks are scoped so reviewing
 * `master...feature` never marks the same lines as reviewed in the working-tree diff
 * (or in a different branch pair). Ref names — not oids — are the durable identity:
 * a branch that moves is still the same review.
 */
export type ReviewScope =
  | { kind: "worktree" }
  | { kind: "branches"; baseRef: string; targetRef: string };

export const WORKTREE_SCOPE: ReviewScope = { kind: "worktree" };

/** The review scope a comparison's marks belong to. */
export function scopeForSpec(spec: DiffSpec): ReviewScope {
  return spec.kind === "worktree"
    ? WORKTREE_SCOPE
    : { kind: "branches", baseRef: spec.baseRef, targetRef: spec.targetRef };
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

export const EMPTY_TAG_STORE: TagStore = {
  version: 1,
  reviewed: [],
  flags: [],
  ignored: [],
};
