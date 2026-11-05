//! Replace local JSON state only once its complete contents have been written.
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use crate::error::AppResult;

pub fn write(path: &Path, contents: &[u8]) -> AppResult<()> {
    let permissions = if path.exists() {
        // Respect an existing read-only file; replacement must not bypass it.
        OpenOptions::new().write(true).open(path)?;
        Some(std::fs::metadata(path)?.permissions())
    } else {
        None
    };
    let mut temporary = tempfile::NamedTempFile::new_in(path.parent().unwrap_or(Path::new(".")))?;
    temporary.write_all(contents)?;
    temporary.as_file().sync_all()?;
    if let Some(permissions) = permissions {
        temporary.as_file().set_permissions(permissions)?;
    }
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_complete_json_without_leaving_temporary_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        write(&path, b"{\"old\":true}").unwrap();
        write(&path, b"{\"new\":true}").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"{\"new\":true}");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn a_blocked_destination_is_reported_without_creating_partial_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("keep"), "existing").unwrap();
        assert!(write(&path, b"new").is_err());
        assert_eq!(
            std::fs::read_to_string(path.join("keep")).unwrap(),
            "existing"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
