//! Bounded, read-only content for transient navigation previews.
use std::io::Read;
use std::path::{Component, Path};

use git2::Repository;

use crate::error::{AppError, AppResult};
use crate::revision::{self, ProjectSource};

pub const MAX_BYTES: usize = 2 * 1024 * 1024;

pub fn read(repo: &Repository, source: &ProjectSource, root: &Path, path: &str) -> AppResult<String> {
    let rel = Path::new(path);
    if path.is_empty() || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(AppError::Repo("preview path must be repository-relative".into()));
    }
    let bytes = match revision::tree(repo, source)? {
        Some(tree) => {
            let entry = tree.get_path(rel)?;
            if !matches!(entry.filemode(), 0o100644 | 0o100755) {
                return Err(AppError::Repo("preview requires a regular file".into()));
            }
            let blob = repo.find_blob(entry.id())?;
            if blob.size() > MAX_BYTES {
                return Err(AppError::Repo("file is over the 2 MiB preview limit".into()));
            }
            blob.content().to_vec()
        }
        None => {
            let full = root.join(rel);
            let metadata = std::fs::symlink_metadata(&full)?;
            if !metadata.is_file() {
                return Err(AppError::Repo("preview requires a regular file".into()));
            }
            let canonical = full.canonicalize()?;
            if !canonical.starts_with(root) {
                return Err(AppError::Repo("path escapes the repository".into()));
            }
            if metadata.len() > MAX_BYTES as u64 {
                return Err(AppError::Repo("file is over the 2 MiB preview limit".into()));
            }
            let mut bytes = Vec::new();
            std::fs::File::open(canonical)?.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes)?;
            if bytes.len() > MAX_BYTES {
                return Err(AppError::Repo("file is over the 2 MiB preview limit".into()));
            }
            bytes
        }
    };
    if bytes.contains(&0) {
        return Err(AppError::Repo("binary files have no text preview".into()));
    }
    String::from_utf8(bytes).map_err(|_| AppError::Repo("file is not valid UTF-8".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestRepo;

    fn command(fixture: &TestRepo, source: ProjectSource, path: &str) -> AppResult<String> {
        tauri::async_runtime::block_on(crate::commands::read_preview(fixture.arg(), source, path.into()))
    }

    #[test]
    fn command_reads_the_requested_revision_without_writing() {
        let f = TestRepo::new();
        f.write("src/file.txt", "committed 😀\ncontext\n");
        let oid = f.commit("initial");
        let index = f.staged();
        f.write("src/file.txt", "working tree");
        assert_eq!(command(&f, ProjectSource::Commit { oid: oid.clone() }, "src/file.txt").unwrap(), "committed 😀\ncontext\n");
        assert_eq!(command(&f, ProjectSource::Worktree, "src/file.txt").unwrap(), "working tree");
        assert_eq!(f.head().to_string(), oid);
        assert_eq!(f.staged(), index);
        assert_eq!(std::fs::read_to_string(f.path().join("src/file.txt")).unwrap(), "working tree");
        assert!(!f.path().join(".review-me").exists());
    }

    #[test]
    fn limits_encodings_and_missing_paths_apply_to_both_sources() {
        let f = TestRepo::new();
        f.write("exact.txt", vec![b'x'; MAX_BYTES]);
        f.write("large.txt", vec![b'x'; MAX_BYTES + 1]);
        f.write("binary.txt", b"a\0b");
        f.write("invalid.txt", [0xff]);
        f.write("empty.txt", "");
        let oid = f.commit("files");
        for source in [ProjectSource::Worktree, ProjectSource::Commit { oid }] {
            assert_eq!(command(&f, source.clone(), "exact.txt").unwrap().len(), MAX_BYTES);
            assert_eq!(command(&f, source.clone(), "empty.txt").unwrap(), "");
            for (path, message) in [("large.txt", "2 MiB"), ("binary.txt", "binary"), ("invalid.txt", "UTF-8")] {
                assert!(command(&f, source.clone(), path).unwrap_err().to_string().contains(message));
            }
            for path in ["missing.txt", "../outside", "/etc/passwd", ""] {
                assert!(command(&f, source.clone(), path).is_err(), "{path}");
            }
        }
        assert!(command(&f, ProjectSource::Commit { oid: "invalid".into() }, "empty.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_directories_and_parent_directory_escapes() {
        use std::os::unix::fs::symlink;
        let f = TestRepo::new();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "outside").unwrap();
        f.write("inside.txt", "inside");
        symlink(f.path().join("inside.txt"), f.path().join("link")).unwrap();
        symlink(outside.path(), f.path().join("escape")).unwrap();
        let oid = f.commit("links");
        for source in [ProjectSource::Worktree, ProjectSource::Commit { oid }] {
            assert!(command(&f, source.clone(), "link").is_err());
            assert!(command(&f, source, "escape/secret.txt").is_err());
        }
        std::fs::create_dir(f.path().join("dir")).unwrap();
        assert!(command(&f, ProjectSource::Worktree, "dir").is_err());
        assert_eq!(std::fs::read_to_string(outside.path().join("secret.txt")).unwrap(), "outside");
    }
}
