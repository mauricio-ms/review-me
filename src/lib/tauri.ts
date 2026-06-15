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
import type {
  PreparedReviewedCommit,
  ReviewedCommitPreflight,
  ReviewedCommitResult,
} from "../types/review-commit";
import type { AnchorKind, AnchorSide, TagStore } from "../types/tags";
import type { IndexStats, SymbolRef, XrefResult } from "../types/xref";

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
  side: AnchorSide,
): Promise<TagStore> {
  return invoke<TagStore>("add_reviewed_tag", {
    repo,
    file,
    startLine,
    endLine,
    kind,
    side,
  });
}

export function addFlagTag(
  repo: string,
  file: string,
  startLine: number,
  endLine: number,
  kind: AnchorKind,
  side: AnchorSide,
  note?: string | null,
  severity?: string | null,
): Promise<TagStore> {
  return invoke<TagStore>("add_flag_tag", {
    repo,
    file,
    startLine,
    endLine,
    kind,
    side,
    note: note ?? null,
    severity: severity ?? null,
  });
}

export function addIgnoredTag(
  repo: string,
  file: string,
  startLine: number,
  endLine: number,
  kind: AnchorKind,
  side: AnchorSide,
): Promise<TagStore> {
  return invoke<TagStore>("add_ignored_tag", {
    repo,
    file,
    startLine,
    endLine,
    kind,
    side,
  });
}

export function removeTag(repo: string, id: string): Promise<TagStore> {
  return invoke<TagStore>("remove_tag", { repo, id });
}

export function clearTags(repo: string): Promise<TagStore> {
  return invoke<TagStore>("clear_tags", { repo });
}

export function unmarkRange(
  repo: string,
  file: string,
  startLine: number,
  endLine: number,
  side: AnchorSide,
): Promise<TagStore> {
  return invoke<TagStore>("unmark_range", {
    repo,
    file,
    startLine,
    endLine,
    side,
  });
}

export function reviewedCommitPreflight(
  repo: string,
): Promise<ReviewedCommitPreflight> {
  return invoke<ReviewedCommitPreflight>("reviewed_commit_preflight", { repo });
}

export function prepareReviewedCommit(
  repo: string,
  unstageExisting: boolean,
): Promise<PreparedReviewedCommit> {
  return invoke<PreparedReviewedCommit>("prepare_reviewed_commit", {
    repo,
    unstageExisting,
  });
}

export function abortReviewedCommit(repo: string): Promise<void> {
  return invoke<void>("abort_reviewed_commit", { repo });
}

export function commitReviewedChanges(
  repo: string,
  message: string,
  reviewedTagIds: string[],
): Promise<ReviewedCommitResult> {
  return invoke<ReviewedCommitResult>("commit_reviewed_changes", {
    repo,
    message,
    reviewedTagIds,
  });
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

export function buildSymbolIndex(repo: string): Promise<IndexStats> {
  return invoke<IndexStats>("build_symbol_index", { repo });
}

export function symbolAt(
  repo: string,
  path: string,
  line: number,
  col: number,
): Promise<SymbolRef | null> {
  return invoke<SymbolRef | null>("symbol_at", { repo, path, line, col });
}

export function findDefinition(
  repo: string,
  symbol: SymbolRef,
): Promise<XrefResult[]> {
  return invoke<XrefResult[]>("find_definition", { repo, symbol });
}

export function findReferences(
  repo: string,
  symbol: SymbolRef,
): Promise<XrefResult[]> {
  return invoke<XrefResult[]>("find_references", { repo, symbol });
}
