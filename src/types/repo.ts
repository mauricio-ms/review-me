export interface RepoInfo {
  root: string;
  head: string;
  branch: string;
  /**
   * The review branch to start on: the canonical ref HEAD is on, else the repo's
   * default branch. Null when the repo has no branches at all.
   */
  reviewBranchRef: string | null;
  /**
   * The repo's default branch — the base the review branch's commits are listed
   * against until `:compare` picks another. Null when there is no such branch.
   */
  defaultBranchRef: string | null;
  isDirty: boolean;
}

/**
 * The branch under review — the app's own notion of "checked out", used as the target
 * of a branch comparison and as the history the commit picker offers. Selecting one
 * never touches the real checkout, index or working tree, so a branch nobody has
 * checked out reviews exactly like the current one.
 */
export interface ReviewBranch {
  /** Canonical ref (`refs/heads/x`, `refs/remotes/origin/x`). */
  ref: string;
  /** Shorthand, for display. */
  display: string;
}

/**
 * Display shorthand of a canonical ref: `refs/heads/x` → `x`,
 * `refs/remotes/origin/x` → `origin/x`. Mirrors `branches::shorthand` in Rust, for the
 * one case the backend doesn't hand us a `BranchInfo`: seeding the review branch from
 * `RepoInfo.reviewBranchRef`.
 */
export function branchShorthand(ref: string): string {
  for (const prefix of ["refs/heads/", "refs/remotes/"]) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return ref;
}

export interface RememberedRepo {
  path: string;
  name: string;
  lastOpenedAt: number;
}

/**
 * Which snapshot of the repo project mode is reading. `worktree` is the checkout on
 * disk; `commit` is a resolved commit's tree — so opening a file from a
 * `master...feature` diff shows *that branch's* content, not whatever is checked out.
 */
export type ProjectSource =
  | { kind: "worktree" }
  | { kind: "commit"; oid: string };

export const WORKTREE_SOURCE: ProjectSource = { kind: "worktree" };

export function sameSource(a: ProjectSource, b: ProjectSource): boolean {
  if (a.kind === "worktree" || b.kind === "worktree") return a.kind === b.kind;
  return a.oid === b.oid;
}

export type BranchKind = "local" | "remote";

/**
 * One selectable ref in the branch-comparison picker. `name` is the canonical ref
 * (`refs/heads/x`, `refs/remotes/origin/x`) used in requests and persisted review
 * scopes; `display` is the shorthand shown to the reviewer.
 */
export interface BranchInfo {
  name: string;
  display: string;
  shortOid: string;
  kind: BranchKind;
  /** The branch HEAD currently points at. */
  isCurrent: boolean;
  /** The repo's inferred default branch (remote HEAD, else master, else main). */
  isDefault: boolean;
}

/**
 * One selectable commit in the commit picker. `oid` is the full 40-char id — diff
 * specs and review scopes carry it, never `shortOid`, so an abbreviation can never
 * split one commit's review in two.
 */
export interface CommitInfo {
  oid: string;
  shortOid: string;
  /** First line of the message. */
  summary: string;
  authorName: string;
  /** Author time, seconds since the epoch. */
  timestamp: number;
  parentCount: number;
  /** More than one parent — reviewed against the first. */
  isMerge: boolean;
  /** The commit HEAD points at. */
  isHead: boolean;
  /**
   * Branches, remote-tracking branches and tags pointing here — magit's decorations,
   * local branches first. Only filled by `listCommits`.
   */
  refs: Decoration[];
}

/**
 * Which part of the review branch's history the commits buffer lists — the commits it
 * introduced. Mirrors `commits::LogRange`.
 */
export type LogRange =
  /** `base..branch`: what the branch has that its base doesn't. */
  | { kind: "unmerged"; baseRef: string; baseName: string }
  /** The branch is its own base: its commits not yet on its upstream. */
  | { kind: "unpushed"; upstreamRef: string; upstreamName: string }
  /** The whole history: no base to hold it against, or nothing unpushed. */
  | { kind: "all" };

/** The canonical ref a range is held against, or null for the whole history. */
export function rangeBaseRef(range: LogRange): string | null {
  switch (range.kind) {
    case "unmerged":
      return range.baseRef;
    case "unpushed":
      return range.upstreamRef;
    case "all":
      return null;
  }
}

/** One page of the commits buffer and the range it was cut from. */
export interface CommitLog {
  range: LogRange;
  commits: CommitInfo[];
}

/** A ref pointing at a listed commit. */
export interface Decoration {
  /** Shorthand: `master`, `origin/master`, `v1.2`. */
  name: string;
  kind: "local" | "remote" | "tag";
}

/**
 * Review units of one comparison, bucketed by the diff buffer's precedence (flagged >
 * ignored > reviewed), so the three counts never overlap. Mirrors `coverage::Coverage`.
 */
export interface Coverage {
  total: number;
  reviewed: number;
  flagged: number;
  ignored: number;
}

/** One commit's review at a glance, for its row in the commits buffer. */
export interface CommitReview {
  oid: string;
  coverage: Coverage;
  /** Flag tags in the commit's scope. */
  flags: number;
  /** Flags carrying a note — fixes left for later. */
  notes: number;
}

export type FileSystemEntryKind = "directory" | "file";

export interface FileSystemEntry {
  name: string;
  path: string;
  isSymlink: boolean;
  kind: FileSystemEntryKind;
  isRepo: boolean;
}

export interface FileSystemListing {
  path: string;
  parent: string | null;
  isRepo: boolean;
  entries: FileSystemEntry[];
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: { name: string; path: string; isSymlink: boolean }[];
}

export interface FileMatch {
  path: string;
  score: number;
  /** Char indices in `path` that matched the query. */
  indices: number[];
}

export interface TreeEntry {
  name: string;
  /** Repo-relative path. */
  path: string;
  isDir: boolean;
}

export interface TreeListing {
  path: string;
  entries: TreeEntry[];
}
