import { invoke } from "@tauri-apps/api/core";

import type { DiffSummary } from "../types/diff";
import type {
  DirectoryListing,
  FileSystemListing,
  RememberedRepo,
  RepoInfo,
} from "../types/repo";

export function openRepo(path: string): Promise<RepoInfo> {
  return invoke<RepoInfo>("open_repo", { path });
}

export function computeDiff(repo: string): Promise<DiffSummary> {
  return invoke<DiffSummary>("compute_diff", { repo });
}

export function listRecentRepos(): Promise<RememberedRepo[]> {
  return invoke<RememberedRepo[]>("list_recent_repos");
}

export function forgetRepo(path: string): Promise<RememberedRepo[]> {
  return invoke<RememberedRepo[]>("forget_repo", { path });
}

export function listFileSystemEntries(
  path?: string | null,
): Promise<FileSystemListing> {
  return invoke<FileSystemListing>("list_file_system_entries", {
    path: path ?? null,
  });
}

export function createDirectory(
  path: string,
  name: string,
): Promise<DirectoryListing> {
  return invoke<DirectoryListing>("create_directory", { path, name });
}
