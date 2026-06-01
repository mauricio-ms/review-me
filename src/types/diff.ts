export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export type DiffLineKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: DiffLineKind;
  /** 1-based; null for added lines. */
  oldLine: number | null;
  /** 1-based; null for removed lines. */
  newLine: number | null;
  content: string;
}

export interface Hunk {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface ChangedFile {
  path: string;
  /** Set only for renames (the previous path). */
  oldPath: string | null;
  status: ChangeStatus;
  /** Present in the index (has staged changes). */
  staged: boolean;
  hunks: Hunk[];
  addedLines: number;
  removedLines: number;
  binary: boolean;
}

export interface DiffSummary {
  repoRoot: string;
  head: string;
  branch: string;
  files: ChangedFile[];
}
