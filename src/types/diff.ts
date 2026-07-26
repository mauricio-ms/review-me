export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export type DiffLineKind = "context" | "added" | "removed";

/**
 * How a branch comparison picks the old side. `mergeBase` is `git diff base...target`.
 */
export type DiffStrategy = "mergeBase";

/**
 * What the diff buffer should show. `worktree` is the default magit-status view
 * (working tree vs. HEAD); `branches` reviews committed history between two refs and
 * never touches the checkout, index, or working tree. Refs are canonical
 * (`refs/heads/x`, `refs/remotes/origin/x`).
 */
export type DiffSpec =
  | { kind: "worktree" }
  | {
      kind: "branches";
      baseRef: string;
      targetRef: string;
      strategy: DiffStrategy;
    };

export const WORKTREE_SPEC: DiffSpec = { kind: "worktree" };

/** Resolved metadata for the comparison a `DiffSummary` describes. */
export type Comparison =
  | { kind: "worktree"; head: string; branch: string }
  | {
      kind: "branches";
      /** Canonical refs — the durable identity of the comparison. */
      baseRef: string;
      targetRef: string;
      /** Shorthand names for display. */
      baseName: string;
      targetName: string;
      /** Resolved oids — the exact snapshot on screen. */
      baseOid: string;
      targetOid: string;
      mergeBase: string;
    };

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
  /**
   * Present in the index (has staged changes). `null` in branch mode, where both
   * sides are committed history and staging is meaningless.
   */
  staged: boolean | null;
  hunks: Hunk[];
  addedLines: number;
  removedLines: number;
  binary: boolean;
}

export interface DiffSummary {
  repoRoot: string;
  comparison: Comparison;
  files: ChangedFile[];
}

/** Abbreviated oid for headers and modelines. */
export function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

/** `master...feature`, or the branch label in worktree mode. */
export function comparisonLabel(comparison: Comparison): string {
  return comparison.kind === "worktree"
    ? comparison.branch
    : `${comparison.baseName}...${comparison.targetName}`;
}

/**
 * Whether two specs describe the same comparison. Used to decide when to reset diff
 * folds and the cursor.
 */
export function sameSpec(a: DiffSpec, b: DiffSpec): boolean {
  if (a.kind === "worktree" || b.kind === "worktree") return a.kind === b.kind;
  return (
    a.baseRef === b.baseRef &&
    a.targetRef === b.targetRef &&
    a.strategy === b.strategy
  );
}
