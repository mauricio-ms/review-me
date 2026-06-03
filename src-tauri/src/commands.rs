use std::path::PathBuf;

use crate::diff::{self, DiffSummary};
use crate::error::{AppError, AppResult};
use crate::fs_browse::{self, DirectoryListing, FileSystemListing};
use crate::fuzzy::{self, FileMatch};
use crate::repo::{self, RepoInfo};
use crate::repo_library::{self, RememberedRepo};
use crate::tags::{self, AnchorKind, TagStore};
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

/// The working-tree-vs-HEAD diff for the repo rooted at `repo`.
#[tauri::command]
pub fn compute_diff(repo: String) -> AppResult<DiffSummary> {
    let repository = repo::open(&PathBuf::from(repo))?;
    diff::compute(&repository)
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

/// Read a repo-relative file's text content (project mode + tag anchoring).
#[tauri::command]
pub fn read_file(repo: String, path: String) -> AppResult<String> {
    let root = repo_root(repo)?;
    let full = root.join(&path);
    // Keep reads inside the repo root.
    let canonical = full.canonicalize()?;
    if !canonical.starts_with(&root) {
        return Err(AppError::Repo("path escapes the repository".into()));
    }
    Ok(std::fs::read_to_string(canonical)?)
}

#[tauri::command]
pub fn load_tags(repo: String) -> AppResult<TagStore> {
    tags::load(&repo_root(repo)?)
}

#[tauri::command]
pub fn save_tags(repo: String, store: TagStore) -> AppResult<()> {
    tags::save(&repo_root(repo)?, &store)
}

#[tauri::command]
pub fn add_reviewed_tag(
    repo: String,
    file: String,
    start_line: u32,
    end_line: u32,
    kind: AnchorKind,
) -> AppResult<TagStore> {
    tags::add_reviewed(&repo_root(repo)?, &file, start_line, end_line, kind)
}

#[tauri::command]
pub fn add_flag_tag(
    repo: String,
    file: String,
    start_line: u32,
    end_line: u32,
    kind: AnchorKind,
    note: Option<String>,
    severity: Option<String>,
) -> AppResult<TagStore> {
    tags::add_flag(&repo_root(repo)?, &file, start_line, end_line, kind, note, severity)
}

#[tauri::command]
pub fn remove_tag(repo: String, id: String) -> AppResult<TagStore> {
    tags::remove(&repo_root(repo)?, &id)
}

/// Remove every reviewed and flag tag in the repo.
#[tauri::command]
pub fn clear_tags(repo: String) -> AppResult<TagStore> {
    tags::clear_all(&repo_root(repo)?)
}

/// Fuzzy-rank repo files for the file finder.
#[tauri::command]
pub fn fuzzy_files(repo: String, query: String, limit: u32) -> AppResult<Vec<FileMatch>> {
    let repository = repo::open(&PathBuf::from(repo))?;
    fuzzy::fuzzy_files(&repository, &query, limit as usize)
}

/// List the children of a repo-relative directory for project-mode navigation.
#[tauri::command]
pub fn list_repo_dir(repo: String, path: String) -> AppResult<TreeListing> {
    let repository = repo::open(&PathBuf::from(repo))?;
    tree::list_dir(&repository, &path)
}

/// (Re)build the tree-sitter symbol index for cross-references.
#[tauri::command]
pub fn build_symbol_index(repo: String) -> AppResult<IndexStats> {
    let repository = repo::open(&PathBuf::from(repo))?;
    let root = repo::root(&repository)?;
    let files = fuzzy::repo_files(&repository)?;
    xref::build_index(&root, &files)
}

/// Resolve the symbol under a cursor position (1-based line, 0-based col).
#[tauri::command]
pub fn symbol_at(
    repo: String,
    path: String,
    line: u32,
    col: u32,
) -> AppResult<Option<SymbolRef>> {
    xref::symbol_at(&repo_root(repo)?, &path, line, col)
}

#[tauri::command]
pub fn find_definition(repo: String, symbol: SymbolRef) -> AppResult<Vec<XrefResult>> {
    let repository = repo::open(&PathBuf::from(repo))?;
    let root = repo::root(&repository)?;
    let files = fuzzy::repo_files(&repository)?;
    xref::find_definition(&root, &files, &symbol)
}

#[tauri::command]
pub fn find_references(repo: String, symbol: SymbolRef) -> AppResult<Vec<XrefResult>> {
    let repository = repo::open(&PathBuf::from(repo))?;
    let root = repo::root(&repository)?;
    let files = fuzzy::repo_files(&repository)?;
    xref::find_references(&root, &files, &symbol)
}

/// Remove every reviewed tag overlapping `[start_line, end_line]` in `file`.
#[tauri::command]
pub fn unreview_range(
    repo: String,
    file: String,
    start_line: u32,
    end_line: u32,
) -> AppResult<TagStore> {
    tags::unreview_range(&repo_root(repo)?, &file, start_line, end_line)
}
