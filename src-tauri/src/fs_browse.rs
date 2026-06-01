use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::repo;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_symlink: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirectoryEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileSystemEntryKind {
    Directory,
    File,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSystemEntry {
    pub name: String,
    pub path: String,
    pub is_symlink: bool,
    pub kind: FileSystemEntryKind,
    pub is_repo: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSystemListing {
    pub path: String,
    pub parent: Option<String>,
    pub is_repo: bool,
    pub entries: Vec<FileSystemEntry>,
}

struct Candidate {
    name: String,
    path: PathBuf,
    is_symlink: bool,
    kind: FileSystemEntryKind,
    is_repo: bool,
}

pub fn list_file_system_entries(path: Option<String>) -> AppResult<FileSystemListing> {
    let dir = browse_dir(path)?.canonicalize()?;
    if !dir.is_dir() {
        return Err(AppError::Repo(format!("not a directory: {}", dir.display())));
    }
    let parent = dir.parent().map(|p| p.to_string_lossy().into_owned());
    let is_repo = repo::is_git_repo(&dir);
    let entries = list_children(&dir).into_iter().map(Candidate::into_entry).collect();
    Ok(FileSystemListing {
        path: dir.to_string_lossy().into_owned(),
        parent,
        is_repo,
        entries,
    })
}

pub fn create_directory(path: String, name: String) -> AppResult<DirectoryListing> {
    let dir = PathBuf::from(path).canonicalize()?;
    if !dir.is_dir() {
        return Err(AppError::Repo(format!("not a directory: {}", dir.display())));
    }
    let name = valid_child_name(&name)?;
    std::fs::create_dir(dir.join(name))?;
    directory_listing(dir)
}

fn directory_listing(dir: PathBuf) -> AppResult<DirectoryListing> {
    let dir = dir.canonicalize()?;
    let parent = dir.parent().map(|p| p.to_string_lossy().into_owned());
    let entries = list_children(&dir)
        .into_iter()
        .filter(|c| c.kind == FileSystemEntryKind::Directory)
        .map(|c| DirectoryEntry {
            name: c.name,
            path: c.path.to_string_lossy().into_owned(),
            is_symlink: c.is_symlink,
        })
        .collect();
    Ok(DirectoryListing {
        path: dir.to_string_lossy().into_owned(),
        parent,
        entries,
    })
}

fn browse_dir(path: Option<String>) -> AppResult<PathBuf> {
    match path {
        Some(path) if !path.trim().is_empty() => Ok(PathBuf::from(path)),
        _ => std::env::var("HOME")
            .map(PathBuf::from)
            .or_else(|_| std::env::current_dir())
            .map_err(AppError::from),
    }
}

fn list_children(dir: &Path) -> Vec<Candidate> {
    let mut entries = Vec::new();
    let read_dir = match std::fs::read_dir(dir) {
        Ok(read_dir) => read_dir,
        Err(_) => return entries,
    };
    for entry in read_dir.flatten() {
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let is_symlink = file_type.is_symlink();
        let metadata = if is_symlink {
            entry.path().metadata().ok()
        } else {
            None
        };
        let is_dir = file_type.is_dir()
            || metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let is_file = file_type.is_file()
            || metadata.as_ref().map(|m| m.is_file()).unwrap_or(false);
        let kind = if is_dir {
            FileSystemEntryKind::Directory
        } else if is_file {
            FileSystemEntryKind::File
        } else {
            continue;
        };
        entries.push(Candidate {
            name,
            is_repo: is_dir && repo::is_git_repo(&entry.path()),
            path: entry.path(),
            is_symlink,
            kind,
        });
    }
    entries.sort_by(|a, b| {
        let rank = |c: &Candidate| if c.kind == FileSystemEntryKind::Directory { 0 } else { 1 };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

impl Candidate {
    fn into_entry(self) -> FileSystemEntry {
        FileSystemEntry {
            name: self.name,
            path: self.path.to_string_lossy().into_owned(),
            is_symlink: self.is_symlink,
            kind: self.kind,
            is_repo: self.is_repo,
        }
    }
}

fn valid_child_name(name: &str) -> AppResult<&str> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Repo("directory name is required".into()));
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(AppError::Repo(
            "directory name cannot contain path separators".into(),
        ));
    }
    let mut components = Path::new(trimmed).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Ok(trimmed),
        _ => Err(AppError::Repo("invalid directory name".into())),
    }
}
