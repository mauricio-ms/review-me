export type AnchorKind = "file" | "hunk" | "range";

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
