use std::path::PathBuf;

use crate::branches::{self, BranchInfo};
use crate::diff::{self, DiffSpec, DiffSummary};
use crate::error::AppResult;
use crate::fs_browse::{self, DirectoryListing, FileSystemListing};
use crate::fuzzy::{self, FileMatch};
use crate::repo::{self, RepoInfo};
use crate::repo_library::{self, RememberedRepo};
use crate::revision::{self, ProjectSource};
use crate::review_commit::{
    self, PreparedReviewedCommit, ReviewedCommitPreflight, ReviewedCommitResult,
};
use crate::tags::{self, AnchorKind, AnchorSide, ReviewScope, TagStore};
use crate::tree::{self, TreeListing};
use crate::xref::{self, IndexStats, SymbolRef, XrefResult};

/// Resolve and validate the repo at `repo`, returning its canonical working-dir root.
fn repo_root(repo: String) -> AppResult<PathBuf> {
    repo::root(&repo::open(&PathBuf::from(repo))?)
}

/// Open (discover) the git repo at `path`, remember it in the recent list, and
/// return its summary info.
#[tauri::command]
pub fn open_repo(app: tauri::AppHandle, path: String) -> AppResult<RepoInfo> {
    let repository = repo::open(&PathBuf::from(path))?;
    let info = repo::info(&repository)?;
    if let Err(e) = repo_library::remember(&app, &PathBuf::from(&info.root)) {
        eprintln!("failed to remember repo: {e}");
    }
    Ok(info)
}

/// The diff `spec` describes for the repo rooted at `repo`: working-tree-vs-HEAD by
/// default, or a merge-base branch comparison.
#[tauri::command]
pub fn compute_diff(repo: String, spec: DiffSpec) -> AppResult<DiffSummary> {
    let repository = repo::open(&PathBuf::from(repo))?;
    diff::compute(&repository, &spec)
}

/// Local and remote-tracking branches for the comparison picker.
#[tauri::command]
pub fn list_branches(repo: String) -> AppResult<Vec<BranchInfo>> {
    let repository = repo::open(&PathBuf::from(repo))?;
    branches::list(&repository)
}

#[tauri::command]
pub fn list_recent_repos(app: tauri::AppHandle) -> AppResult<Vec<RememberedRepo>> {
    repo_library::list(&app)
}

#[tauri::command]
pub fn forget_repo(app: tauri::AppHandle, path: String) -> AppResult<Vec<RememberedRepo>> {
    repo_library::forget(&app, &PathBuf::from(path))
}

#[tauri::command]
pub fn list_file_system_entries(path: Option<String>) -> AppResult<FileSystemListing> {
    fs_browse::list_file_system_entries(path)
}

#[tauri::command]
pub fn create_directory(path: String, name: String) -> AppResult<DirectoryListing> {
    fs_browse::create_directory(path, name)
}

/// Read a repo-relative file's text content from `source` — the working tree, or the
/// commit a branch comparison is showing.
#[tauri::command]
pub fn read_file(repo: String, source: ProjectSource, path: String) -> AppResult<String> {
    let repository = repo::open(&PathBuf::from(repo))?;
    let root = repo::root(&repository)?;
    revision::read_file(&repository, &source, &root, &path)
}

/// Tags belonging to `scope` (the active comparison), re-anchored against it.
#[tauri::command]
pub fn load_tags(repo: String, scope: ReviewScope) -> AppResult<TagStore> {
    tags::load(&repo_root(repo)?, &scope)
}

#[tauri::command]
pub fn add_reviewed_tag(
    repo: String,
    scope: ReviewScope,
    file: String,
    start_line: u32,
    end_line: u32,
    kind: AnchorKind,
    side: AnchorSide,
) -> AppResult<TagStore> {
    tags::add_reviewed(
        &repo_root(repo)?,
        &scope,
        &file,
        start_line,
        end_line,
        kind,
        side,
    )
}

#[tauri::command]
pub fn add_flag_tag(
    repo: String,
    scope: ReviewScope,
    file: String,
    start_line: u32,
    end_line: u32,
    kind: AnchorKind,
    side: AnchorSide,
    note: Option<String>,
    severity: Option<String>,
) -> AppResult<TagStore> {
    tags::add_flag(
        &repo_root(repo)?,
        &scope,
        &file,
        start_line,
        end_line,
        kind,
        side,
        note,
        severity,
    )
}

#[tauri::command]
pub fn add_ignored_tag(
    repo: String,
    scope: ReviewScope,
    file: String,
    start_line: u32,
    end_line: u32,
    kind: AnchorKind,
    side: AnchorSide,
) -> AppResult<TagStore> {
    tags::add_ignored(
        &repo_root(repo)?,
        &scope,
        &file,
        start_line,
        end_line,
        kind,
        side,
    )
}

#[tauri::command]
pub fn remove_tag(repo: String, scope: ReviewScope, id: String) -> AppResult<TagStore> {
    tags::remove(&repo_root(repo)?, &scope, &id)
}

/// Remove every reviewed, flag, and ignore tag in the active comparison. Marks made
/// against other comparisons are untouched.
#[tauri::command]
pub fn clear_tags(repo: String, scope: ReviewScope) -> AppResult<TagStore> {
    tags::clear_scope(&repo_root(repo)?, &scope)
}

/// Fuzzy-rank `source`'s files for the file finder.
#[tauri::command]
pub fn fuzzy_files(
    repo: String,
    source: ProjectSource,
    query: String,
    limit: u32,
) -> AppResult<Vec<FileMatch>> {
    let repository = repo::open(&PathBuf::from(repo))?;
    fuzzy::fuzzy_files(&repository, &source, &query, limit as usize)
}

/// List the children of a repo-relative directory for project-mode navigation.
#[tauri::command]
pub fn list_repo_dir(
    repo: String,
    source: ProjectSource,
    path: String,
) -> AppResult<TreeListing> {
    let repository = repo::open(&PathBuf::from(repo))?;
    tree::list_dir(&repository, &source, &path)
}

/// (Re)build the tree-sitter symbol index for cross-references over `source`.
#[tauri::command]
pub fn build_symbol_index(repo: String, source: ProjectSource) -> AppResult<IndexStats> {
    let repository = repo::open(&PathBuf::from(repo))?;
    let root = repo::root(&repository)?;
    let files = fuzzy::repo_files(&repository, &source)?;
    xref::build_index(&repository, &root, &source, &files)
}

/// Resolve the symbol under a cursor position (1-based line, 0-based col).
#[tauri::command]
pub fn symbol_at(
    repo: String,
    source: ProjectSource,
    path: String,
    line: u32,
    col: u32,
) -> AppResult<Option<SymbolRef>> {
    let repository = repo::open(&PathBuf::from(repo))?;
    let root = repo::root(&repository)?;
    xref::symbol_at(&repository, &root, &source, &path, line, col)
}

#[tauri::command]
pub fn find_definition(
    repo: String,
    source: ProjectSource,
    symbol: SymbolRef,
) -> AppResult<Vec<XrefResult>> {
    let repository = repo::open(&PathBuf::from(repo))?;
    let root = repo::root(&repository)?;
    let files = fuzzy::repo_files(&repository, &source)?;
    xref::find_definition(&repository, &root, &source, &files, &symbol)
}

#[tauri::command]
pub fn find_references(
    repo: String,
    source: ProjectSource,
    symbol: SymbolRef,
) -> AppResult<Vec<XrefResult>> {
    let repository = repo::open(&PathBuf::from(repo))?;
    let root = repo::root(&repository)?;
    let files = fuzzy::repo_files(&repository, &source)?;
    xref::find_references(&repository, &root, &source, &files, &symbol)
}

/// Remove every reviewed, flag, and ignore tag overlapping `[start_line, end_line]` in `file`.
#[tauri::command]
pub fn unmark_range(
    repo: String,
    scope: ReviewScope,
    file: String,
    start_line: u32,
    end_line: u32,
    side: AnchorSide,
) -> AppResult<TagStore> {
    tags::unmark_range(&repo_root(repo)?, &scope, &file, start_line, end_line, side)
}

#[tauri::command]
pub fn reviewed_commit_preflight(repo: String) -> AppResult<ReviewedCommitPreflight> {
    let repository = repo::open(&PathBuf::from(repo))?;
    review_commit::preflight(&repository)
}

#[tauri::command]
pub fn prepare_reviewed_commit(
    repo: String,
    unstage_existing: bool,
) -> AppResult<PreparedReviewedCommit> {
    let repository = repo::open(&PathBuf::from(repo))?;
    review_commit::prepare(&repository, unstage_existing)
}

#[tauri::command]
pub fn abort_reviewed_commit(repo: String) -> AppResult<()> {
    let repository = repo::open(&PathBuf::from(repo))?;
    review_commit::abort(&repository)
}

#[tauri::command]
pub fn commit_reviewed_changes(
    repo: String,
    message: String,
    reviewed_tag_ids: Vec<String>,
) -> AppResult<ReviewedCommitResult> {
    let repository = repo::open(&PathBuf::from(repo))?;
    review_commit::commit(&repository, &message, &reviewed_tag_ids)
}
