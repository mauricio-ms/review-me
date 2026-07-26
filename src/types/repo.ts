export interface RepoInfo {
  root: string;
  head: string;
  branch: string;
  isDirty: boolean;
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
