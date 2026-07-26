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
