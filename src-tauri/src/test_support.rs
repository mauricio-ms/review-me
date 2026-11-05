//! Isolated Git fixtures shared by backend integration tests.
use std::path::Path;

use git2::{IndexAddOption, Oid, Repository, RepositoryInitOptions, Signature};

pub(crate) fn required_sample(path: &Path, setup: &str) -> Result<Repository, String> {
    Repository::open_ext(
        path,
        git2::RepositoryOpenFlags::NO_SEARCH,
        std::iter::empty::<&str>(),
    )
    .map_err(|error| {
        format!(
            "required sample {} is missing or is not a Git repository: {error}; run {setup}",
            path.display(),
        )
    })
}

pub(crate) struct TestRepo {
    dir: tempfile::TempDir,
    pub repo: Repository,
}

#[test]
fn required_samples_report_missing_or_invalid_repositories() {
    let dir = tempfile::tempdir().unwrap();
    for path in [dir.path().join("missing"), dir.path().to_path_buf()] {
        let error = required_sample(&path, "./scripts/build-fixture.sh")
            .err()
            .unwrap();
        assert!(error.contains("required sample"));
        assert!(error.contains("./scripts/build-fixture.sh"));
    }
    let fixture = TestRepo::new();
    assert!(required_sample(fixture.path(), "setup").is_ok());
}

impl TestRepo {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut options = RepositoryInitOptions::new();
        options.initial_head("master");
        let repo = Repository::init_opts(dir.path(), &options).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Test").unwrap();
        config
            .set_str("user.email", "test@example.invalid")
            .unwrap();
        config.set_bool("core.autocrlf", false).unwrap();
        Self { dir, repo }
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    pub fn arg(&self) -> String {
        self.path().to_str().unwrap().to_string()
    }

    pub fn write(&self, rel: &str, text: impl AsRef<[u8]>) {
        let path = self.path().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    pub fn commit(&self, message: &str) -> String {
        let mut index = self.repo.index().unwrap();
        index.add_all(["*"], IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = self.repo.find_tree(tree_id).unwrap();
        let parent = self
            .repo
            .head()
            .ok()
            .map(|head| head.peel_to_commit().unwrap());
        let parents: Vec<_> = parent.iter().collect();
        let signature = Signature::now("Test", "test@example.invalid").unwrap();
        self.repo
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                message,
                &tree,
                &parents,
            )
            .unwrap()
            .to_string()
    }

    pub fn head(&self) -> Oid {
        self.repo.head().unwrap().target().unwrap()
    }

    pub fn staged(&self) -> Vec<u8> {
        std::fs::read(self.repo.path().join("index")).unwrap()
    }
}
