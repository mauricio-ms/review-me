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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestRepo;
    use std::fs;

    #[test]
    fn lists_directories_first_and_names_case_insensitively() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["Zoo", "alpha", ".hidden"] {
            fs::create_dir(dir.path().join(name)).unwrap();
        }
        for name in ["Z.txt", "b.txt", "A.txt", ".secret"] {
            fs::write(dir.path().join(name), "x").unwrap();
        }
        let result = list_file_system_entries(Some(dir.path().to_str().unwrap().into())).unwrap();
        assert_eq!(result.entries.iter().map(|e| (e.name.as_str(), e.kind)).collect::<Vec<_>>(), vec![
            ("alpha", FileSystemEntryKind::Directory), ("Zoo", FileSystemEntryKind::Directory),
            ("A.txt", FileSystemEntryKind::File), ("b.txt", FileSystemEntryKind::File), ("Z.txt", FileSystemEntryKind::File),
        ]);
        assert!(!result.is_repo);
        assert_eq!(result.parent.as_deref(), dir.path().parent().unwrap().to_str());
    }

    #[test]
    fn recognises_repositories_without_mistaking_their_subdirectories_for_roots() {
        let fixture = TestRepo::new();
        fs::create_dir(fixture.path().join("plain")).unwrap();
        let result = list_file_system_entries(Some(fixture.arg())).unwrap();
        assert!(result.is_repo);
        assert!(!result.entries.iter().find(|e| e.name == "plain").unwrap().is_repo);
    }

    #[test]
    fn rejects_missing_paths_and_files_as_browse_roots() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file");
        fs::write(&file, "x").unwrap();
        assert!(list_file_system_entries(Some(file.to_str().unwrap().into())).unwrap_err().to_string().contains("not a directory"));
        assert!(list_file_system_entries(Some(dir.path().join("missing").to_str().unwrap().into())).is_err());
    }

    #[test]
    fn creates_a_trimmed_child_and_returns_only_directories() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("file.txt"), "unchanged").unwrap();
        let result = create_directory(dir.path().to_str().unwrap().into(), "  new folder  ".into()).unwrap();
        assert!(dir.path().join("new folder").is_dir());
        assert_eq!(result.entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["new folder"]);
        assert_eq!(fs::read_to_string(dir.path().join("file.txt")).unwrap(), "unchanged");
    }

    #[test]
    fn rejects_invalid_child_names_without_creating_anything() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["", "   ", ".", "..", "../escape", "child/name", "child\\name", "/absolute", "bad\0name"] {
            assert!(create_directory(dir.path().to_str().unwrap().into(), name.into()).is_err(), "accepted {name:?}");
        }
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn an_existing_destination_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("existing"), "keep").unwrap();
        assert!(create_directory(dir.path().to_str().unwrap().into(), "existing".into()).is_err());
        assert_eq!(fs::read_to_string(dir.path().join("existing")).unwrap(), "keep");
        fs::create_dir(dir.path().join("folder")).unwrap();
        assert!(create_directory(dir.path().to_str().unwrap().into(), "folder".into()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_labelled_and_broken_links_are_omitted() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("folder")).unwrap();
        fs::write(dir.path().join("file"), "text").unwrap();
        symlink("folder", dir.path().join("dir-link")).unwrap();
        symlink("file", dir.path().join("file-link")).unwrap();
        symlink("missing", dir.path().join("broken")).unwrap();
        let result = list_file_system_entries(Some(dir.path().to_str().unwrap().into())).unwrap();
        let link = result.entries.iter().find(|e| e.name == "dir-link").unwrap();
        assert!(link.is_symlink);
        assert_eq!(link.kind, FileSystemEntryKind::Directory);
        let link = result.entries.iter().find(|e| e.name == "file-link").unwrap();
        assert!(link.is_symlink);
        assert_eq!(link.kind, FileSystemEntryKind::File);
        assert!(!result.entries.iter().any(|e| e.name == "broken"));
    }
}
