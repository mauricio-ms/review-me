use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppResult;
use crate::repo;

/// The folder review-me keeps inside every reviewed repo: the tag store and the
/// generated notes. It is review-me's own state, never part of the project, so git is
/// told to ignore it *locally* — through `.git/info/exclude`, never the project's
/// `.gitignore`, which would itself be a change to the project.
pub const NAME: &str = ".review-me";

/// The pattern written to `info/exclude`: anchored to the repo root, directory only.
const EXCLUDE_PATTERN: &str = "/.review-me/";

pub fn path(root: &Path) -> PathBuf {
    root.join(NAME)
}

/// Whether a repo-relative path lives under `.review-me/`.
pub fn contains(rel: &str) -> bool {
    rel == NAME || rel.starts_with(".review-me/")
}

/// Create `.review-me/` if needed and make sure git ignores it. Called before every
/// write, so a repo reviewed before the exclusion existed picks it up on its next mark.
/// Failing to exclude never fails the write: the review state matters more than a
/// clean `git status`.
pub fn ensure(root: &Path) -> AppResult<PathBuf> {
    let dir = path(root);
    fs::create_dir_all(&dir)?;
    if let Err(e) = exclude_locally(root) {
        eprintln!("could not add {NAME} to .git/info/exclude: {e}");
    }
    Ok(dir)
}

fn exclude_locally(root: &Path) -> AppResult<()> {
    let repo = repo::open(root)?;
    let file = common_dir(repo.path()).join("info").join("exclude");
    let existing = fs::read_to_string(&file).unwrap_or_default();
    if existing.lines().any(already_excludes) {
        return Ok(());
    }
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    let separator = if existing.is_empty() || existing.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    fs::write(
        &file,
        format!("{existing}{separator}# review-me's local review state\n{EXCLUDE_PATTERN}\n"),
    )?;
    Ok(())
}

/// `info/exclude` belongs to the *common* git dir, so a linked worktree shares its main
/// checkout's exclusions instead of writing a file git never reads. A linked
/// worktree's git dir names the common dir in its `commondir` file (git2 doesn't expose
/// `git_repository_commondir`).
fn common_dir(git_dir: &Path) -> PathBuf {
    match fs::read_to_string(git_dir.join("commondir")) {
        Ok(rel) => git_dir.join(rel.trim()),
        Err(_) => git_dir.to_path_buf(),
    }
}

/// Any spelling of the pattern a person might already have added by hand.
fn already_excludes(line: &str) -> bool {
    matches!(
        line.trim(),
        ".review-me" | ".review-me/" | "/.review-me" | "/.review-me/"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init(dir: &Path) {
        let out = std::process::Command::new("git")
            .args(["init", "-q", "-b", "master"])
            .current_dir(dir)
            .output()
            .expect("git");
        assert!(out.status.success());
    }

    fn exclude_file(root: &Path) -> String {
        fs::read_to_string(root.join(".git/info/exclude")).unwrap_or_default()
    }

    #[test]
    fn ensure_creates_the_dir_and_excludes_it_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init(root);

        let created = ensure(root).unwrap();
        assert!(created.is_dir());
        ensure(root).unwrap();
        let exclude = exclude_file(root);
        assert_eq!(exclude.matches(EXCLUDE_PATTERN).count(), 1, "{exclude}");

        // git itself now ignores the folder's contents.
        fs::write(created.join("tags.json"), "{}").unwrap();
        let out = std::process::Command::new("git")
            .args(["status", "--porcelain", "--untracked-files=all"])
            .current_dir(root)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "");
    }

    #[test]
    fn keeps_existing_exclusions_and_respects_a_hand_written_one() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init(root);
        let file = root.join(".git/info/exclude");
        fs::create_dir_all(file.parent().unwrap()).unwrap();

        fs::write(&file, "*.log").unwrap();
        ensure(root).unwrap();
        assert_eq!(
            exclude_file(root),
            format!("*.log\n# review-me's local review state\n{EXCLUDE_PATTERN}\n")
        );

        fs::write(&file, ".review-me\n").unwrap();
        ensure(root).unwrap();
        assert_eq!(exclude_file(root), ".review-me\n");
    }

    #[test]
    fn a_linked_worktree_excludes_through_the_main_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main");
        fs::create_dir_all(&main).unwrap();
        init(&main);
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&main)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .expect("git");
            assert!(out.status.success(), "git {args:?} failed");
        };
        git(&["commit", "-q", "--allow-empty", "-m", "init"]);
        let linked = dir.path().join("linked");
        git(&["worktree", "add", "-q", linked.to_str().unwrap()]);

        ensure(&linked).unwrap();
        assert!(exclude_file(&main).contains(EXCLUDE_PATTERN));
    }

    #[test]
    fn a_plain_directory_still_gets_its_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert!(ensure(dir.path()).unwrap().is_dir());
    }

    #[test]
    fn recognises_paths_inside_the_folder() {
        assert!(contains(".review-me/tags.json"));
        assert!(contains(".review-me"));
        assert!(!contains(".review-meta/x"));
        assert!(!contains("src/.review-me/x"));
    }
}
