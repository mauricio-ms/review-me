import { invoke } from "@tauri-apps/api/core";

import type { DiffSummary } from "../types/diff";
import type {
  DirectoryListing,
  FileMatch,
  FileSystemListing,
  RememberedRepo,
  RepoInfo,
  TreeListing,
} from "../types/repo";
import type { AnchorKind, TagStore } from "../types/tags";

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

export function readFile(repo: string, path: string): Promise<string> {
  return invoke<string>("read_file", { repo, path });
}

export function loadTags(repo: string): Promise<TagStore> {
  return invoke<TagStore>("load_tags", { repo });
}

export function addReviewedTag(
  repo: string,
  file: string,
  startLine: number,
  endLine: number,
  kind: AnchorKind,
): Promise<TagStore> {
  return invoke<TagStore>("add_reviewed_tag", {
    repo,
    file,
    startLine,
    endLine,
    kind,
  });
}

export function addFlagTag(
  repo: string,
  file: string,
  startLine: number,
  endLine: number,
  kind: AnchorKind,
  note?: string | null,
  severity?: string | null,
): Promise<TagStore> {
  return invoke<TagStore>("add_flag_tag", {
    repo,
    file,
    startLine,
    endLine,
    kind,
    note: note ?? null,
    severity: severity ?? null,
  });
}

export function removeTag(repo: string, id: string): Promise<TagStore> {
  return invoke<TagStore>("remove_tag", { repo, id });
}

export function unreviewRange(
  repo: string,
  file: string,
  startLine: number,
  endLine: number,
): Promise<TagStore> {
  return invoke<TagStore>("unreview_range", { repo, file, startLine, endLine });
}

export function fuzzyFiles(
  repo: string,
  query: string,
  limit: number,
): Promise<FileMatch[]> {
  return invoke<FileMatch[]>("fuzzy_files", { repo, query, limit });
}

export function listRepoDir(repo: string, path: string): Promise<TreeListing> {
  return invoke<TreeListing>("list_repo_dir", { repo, path });
}
