export type AnchorKind = "file" | "hunk" | "range";

export interface Anchor {
  file: string;
  /** 1-based inclusive line range in the file's current content. */
  startLine: number;
  endLine: number;
  contentHash: string;
  contextBefore: string[];
  contextAfter: string[];
  kind: AnchorKind;
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
