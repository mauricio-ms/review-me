use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::error::{AppError, AppResult};

const LIBRARY_FILE: &str = "repo-library.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RememberedRepo {
    pub path: String,
    pub name: String,
    pub last_opened_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoLibrary {
    #[serde(default)]
    repos: Vec<RememberedRepo>,
}

pub fn list(app: &tauri::AppHandle) -> AppResult<Vec<RememberedRepo>> {
    let path = library_path(app)?;
    let mut library = read_library(&path)?;
    sort_repos(&mut library.repos);
    Ok(library.repos)
}

pub fn remember(app: &tauri::AppHandle, repo_path: &Path) -> AppResult<Vec<RememberedRepo>> {
    let path = library_path(app)?;
    remember_in_file(&path, repo_path, now_millis())
}

pub fn forget(app: &tauri::AppHandle, repo_path: &Path) -> AppResult<Vec<RememberedRepo>> {
    let path = library_path(app)?;
    forget_in_file(&path, repo_path)
}

fn forget_in_file(path: &Path, repo_path: &Path) -> AppResult<Vec<RememberedRepo>> {
    let mut library = read_library(&path)?;
    let normalized = normalize(repo_path);
    library
        .repos
        .retain(|repo| normalize(Path::new(&repo.path)) != normalized);
    sort_repos(&mut library.repos);
    write_library(&path, &library)?;
    Ok(library.repos)
}

fn library_path(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Repo(format!("failed to resolve app data directory: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(LIBRARY_FILE))
}

fn remember_in_file(
    library_path: &Path,
    repo_path: &Path,
    last_opened_at: u64,
) -> AppResult<Vec<RememberedRepo>> {
    let mut library = read_library(library_path)?;
    let normalized = normalize(repo_path);
    let name = display_name(repo_path);
    library
        .repos
        .retain(|repo| normalize(Path::new(&repo.path)) != normalized);
    library.repos.push(RememberedRepo {
        path: normalized,
        name,
        last_opened_at,
    });
    sort_repos(&mut library.repos);
    write_library(library_path, &library)?;
    Ok(library.repos)
}

fn read_library(path: &Path) -> AppResult<RepoLibrary> {
    if !path.exists() {
        return Ok(RepoLibrary::default());
    }
    let json = std::fs::read_to_string(path)?;
    if json.trim().is_empty() {
        return Ok(RepoLibrary::default());
    }
    Ok(serde_json::from_str(&json)?)
}

fn write_library(path: &Path, library: &RepoLibrary) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    crate::storage::write(path, &serde_json::to_vec_pretty(library)?)
}

fn normalize(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn display_name(repo_path: &Path) -> String {
    repo_path
        .file_name()
        .or_else(|| repo_path.file_stem())
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("repo")
        .to_string()
}

fn sort_repos(repos: &mut [RememberedRepo]) {
    repos.sort_by(|a, b| {
        b.last_opened_at
            .cmp(&a.last_opened_at)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn remembers_repos_most_recent_first() {
        let dir = tempfile::tempdir().unwrap();
        let library = dir.path().join("repo-library.json");
        remember_in_file(&library, Path::new("/tmp/one"), 10).unwrap();
        let repos = remember_in_file(&library, Path::new("/tmp/two"), 20).unwrap();
        assert_eq!(repos.len(), 2);
        assert_eq!(repos[0].name, "two");
        assert_eq!(repos[1].name, "one");
    }

    #[test]
    fn updates_existing_repo_instead_of_duplicating() {
        let dir = tempfile::tempdir().unwrap();
        let library = dir.path().join("repo-library.json");
        remember_in_file(&library, Path::new("/tmp/one"), 10).unwrap();
        let repos = remember_in_file(&library, Path::new("/tmp/one"), 20).unwrap();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].last_opened_at, 20);
    }

    #[test]
    fn forgetting_an_entry_preserves_the_other_repositories_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.json");
        let one = dir.path().join("one");
        let two = dir.path().join("two");
        remember_in_file(&path, &one, 10).unwrap();
        remember_in_file(&path, &two, 20).unwrap();
        let repos = forget_in_file(&path, &one).unwrap();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].name, "two");
        let before = std::fs::read(&path).unwrap();
        forget_in_file(&path, &one).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(read_library(&path).unwrap().repos.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_and_canonical_paths_identify_the_same_recent_repository() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("project");
        std::fs::create_dir(&repo).unwrap();
        let alias = dir.path().join("alias");
        symlink(&repo, &alias).unwrap();
        let path = dir.path().join("library.json");
        remember_in_file(&path, &repo, 10).unwrap();
        let repos = remember_in_file(&path, &alias, 20).unwrap();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].path, repo.to_str().unwrap());
        assert!(forget_in_file(&path, &alias).unwrap().is_empty());
    }

    #[test]
    fn absent_and_blank_library_storage_are_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.json");
        assert!(read_library(&path).unwrap().repos.is_empty());
        std::fs::write(&path, " \n\t").unwrap();
        assert!(read_library(&path).unwrap().repos.is_empty());
    }

    #[test]
    fn corrupt_libraries_are_reported_and_preserved_by_remember_and_forget() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.json");
        for json in ["{", "not JSON", "{\"repos\":42}"] {
            std::fs::write(&path, json).unwrap();
            assert!(read_library(&path).is_err());
            assert!(remember_in_file(&path, Path::new("project"), 10).is_err());
            assert!(forget_in_file(&path, Path::new("project")).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), json);
        }
    }

    #[test]
    fn storage_failures_are_errors_and_equal_timestamps_sort_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.json");
        remember_in_file(&path, Path::new("zeta"), 10).unwrap();
        let repos = remember_in_file(&path, Path::new("Alpha"), 10).unwrap();
        assert_eq!(repos.iter().map(|repo| repo.name.as_str()).collect::<Vec<_>>(), vec!["Alpha", "zeta"]);
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, "keep").unwrap();
        assert!(remember_in_file(&blocker.join("library.json"), Path::new("project"), 10).is_err());
        assert_eq!(std::fs::read_to_string(blocker).unwrap(), "keep");
    }
}
