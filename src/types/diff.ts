export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export type DiffLineKind = "context" | "added" | "removed";

/**
 * How a branch comparison picks the old side. `mergeBase` is `git diff base...target`.
 */
export type DiffStrategy = "mergeBase";

/**
 * What the diff buffer should show. `worktree` is the default magit-status view
 * (working tree vs. HEAD); `branches` reviews committed history between two refs and
 * `commit` reviews a single commit against its first parent. Neither
 * committed-history mode touches the checkout, index, or working tree. Refs are
 * canonical (`refs/heads/x`, `refs/remotes/origin/x`) and commit oids are always the
 * full 40 chars.
 */
export type DiffSpec =
  | { kind: "worktree" }
  | {
      kind: "branches";
      baseRef: string;
      targetRef: string;
      strategy: DiffStrategy;
    }
  | {
      kind: "commit";
      /** Full 40-char oid — the comparison's identity. */
      oid: string;
      /**
       * The branch the commit was picked from. Display context only: it is absent
       * from both the comparison's identity and its review scope, so the same commit
       * reached from two branches is one review.
       */
      branchRef: string | null;
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
    }
  | {
      kind: "commit";
      /** Full oid — the durable identity of the comparison. */
      oid: string;
      shortOid: string;
      summary: string;
      authorName: string;
      /** Author time, seconds since the epoch. */
      timestamp: number;
      /** The first parent, whose tree is the old side; null for a root commit. */
      parentOid: string | null;
      isMerge: boolean;
      /** Shorthand of the branch the commit was picked from, for display. */
      branchName: string | null;
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

/** Longest commit subject shown in a label before it is cut short. */
const SUMMARY_MAX = 48;

/**
 * The identifying label for a comparison: the branch in worktree mode,
 * `master...feature` for a branch pair, `abc1234 subject` for a single commit.
 */
export function comparisonLabel(comparison: Comparison): string {
  switch (comparison.kind) {
    case "worktree":
      return comparison.branch;
    case "branches":
      return `${comparison.baseName}...${comparison.targetName}`;
    case "commit":
      return `${comparison.shortOid} ${truncate(comparison.summary, SUMMARY_MAX)}`;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Whether the comparison is committed history — nothing about it can be staged. */
export function readsCommittedHistory(spec: DiffSpec): boolean {
  return spec.kind !== "worktree";
}

/**
 * Whether two specs describe the same comparison. Used to decide when to reset diff
 * folds and the cursor.
 */
export function sameSpec(a: DiffSpec, b: DiffSpec): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "worktree" || b.kind === "worktree") return true;
  if (a.kind === "branches" || b.kind === "branches") {
    return (
      a.kind === "branches" &&
      b.kind === "branches" &&
      a.baseRef === b.baseRef &&
      a.targetRef === b.targetRef &&
      a.strategy === b.strategy
    );
  }
  // A commit is identified by its oid alone; `branchRef` is display context, so
  // re-picking the same commit from another branch is not a new comparison.
  return a.oid === b.oid;
}
