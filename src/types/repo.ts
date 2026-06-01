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
