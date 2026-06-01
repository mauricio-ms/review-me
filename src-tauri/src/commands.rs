use std::path::PathBuf;

use crate::diff::{self, DiffSummary};
use crate::error::AppResult;
use crate::fs_browse::{self, DirectoryListing, FileSystemListing};
use crate::repo::{self, RepoInfo};
use crate::repo_library::{self, RememberedRepo};

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
