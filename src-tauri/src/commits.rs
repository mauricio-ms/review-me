use std::collections::HashMap;

use git2::{BranchType, Commit, Oid, Repository, Sort};
use serde::Serialize;

use crate::branches::short_oid;
use crate::error::{AppError, AppResult};

/// One selectable commit in the commit picker. `oid` is the full 40-char id — specs
/// and review scopes carry it, never the abbreviation, so a shorthand can never split
/// one commit's review in two.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub oid: String,
    pub short_oid: String,
    /// First line of the message.
    pub summary: String,
    pub author_name: String,
    /// Author time, seconds since the epoch.
    pub timestamp: i64,
    pub parent_count: u32,
    /// More than one parent — reviewed against the first.
    pub is_merge: bool,
    /// The commit `HEAD` points at.
    pub is_head: bool,
    /// The branches, remote-tracking branches and tags pointing at this commit —
    /// magit's decorations. Filled by `list` only; empty from `resolve`, which names a
    /// single commit and has no use for them.
    pub refs: Vec<Decoration>,
}

/// A ref pointing at a listed commit, by display name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decoration {
    /// Shorthand: `master`, `origin/master`, `v1.2`.
    pub name: String,
    pub kind: DecorationKind,
}

/// Declaration order is display order: local branches, then remote-tracking, then tags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DecorationKind {
    Local,
    Remote,
    Tag,
}

/// A commit resolved against the object database: the commit under review plus the
/// parent its diff is taken against. `parent_oid` is `None` for a root commit, whose
/// old side is empty rather than unreadable.
#[derive(Debug, Clone)]
pub struct ResolvedCommit {
    pub oid: Oid,
    pub parent_oid: Option<Oid>,
    pub info: CommitInfo,
}

/// `ref_name`'s history, newest first: `limit` commits after skipping the newest
/// `skip`, so a long history can be paged in as the reviewer scrolls. Any committish
/// works, so a remote-tracking ref or a bare `HEAD` lists just as well as a branch.
pub fn list(
    repo: &Repository,
    ref_name: &str,
    skip: usize,
    limit: usize,
) -> AppResult<Vec<CommitInfo>> {
    let tip = resolve(repo, ref_name)?.oid;
    let head_oid = head_oid(repo);
    let decorations = decorations(repo);

    let mut walk = repo.revwalk()?;
    // Reverse-chronological like `git log`, but topological too: commits made within
    // the same second (scripted work, rebases) still list children before parents.
    walk.set_sorting(Sort::TIME | Sort::TOPOLOGICAL)?;
    walk.push(tip)?;

    let mut out = Vec::new();
    for oid in walk.skip(skip) {
        if out.len() >= limit {
            break;
        }
        let commit = repo.find_commit(oid?)?;
        let mut commit_info = info(&commit, head_oid);
        if let Some(names) = decorations.get(&commit.id()) {
            commit_info.refs = names.clone();
        }
        out.push(commit_info);
    }
    Ok(out)
}

/// Every commit some ref points at, mapped to those refs: local branches first, then
/// remote-tracking branches, then tags, each alphabetically. A remote's symbolic `HEAD`
/// (`origin/HEAD`) only repeats the branch it points at, so it is left out.
fn decorations(repo: &Repository) -> HashMap<Oid, Vec<Decoration>> {
    let mut found: Vec<(DecorationKind, String, Oid)> = Vec::new();
    for (kind, branch_type) in [
        (DecorationKind::Local, BranchType::Local),
        (DecorationKind::Remote, BranchType::Remote),
    ] {
        let Ok(branches) = repo.branches(Some(branch_type)) else {
            continue;
        };
        for (branch, _) in branches.flatten() {
            let reference = branch.get();
            if reference.symbolic_target().is_some() {
                continue;
            }
            let (Some(name), Ok(commit)) = (reference.shorthand(), reference.peel_to_commit())
            else {
                continue;
            };
            found.push((kind, name.to_string(), commit.id()));
        }
    }
    if let Ok(tags) = repo.references_glob("refs/tags/*") {
        for reference in tags.flatten() {
            let (Some(name), Ok(commit)) = (reference.shorthand(), reference.peel_to_commit())
            else {
                continue; // a tag of a tree or blob decorates no commit
            };
            found.push((DecorationKind::Tag, name.to_string(), commit.id()));
        }
    }
    found.sort();
    let mut out: HashMap<Oid, Vec<Decoration>> = HashMap::new();
    for (kind, name, oid) in found {
        out.entry(oid).or_default().push(Decoration { name, kind });
    }
    out
}

/// Resolve any revision — a full oid, an abbreviation, `HEAD~2`, a ref name — to the
/// commit it names and the parent its diff is taken against.
pub fn resolve(repo: &Repository, rev: &str) -> AppResult<ResolvedCommit> {
    let commit = find_commit(repo, rev)?;
    Ok(ResolvedCommit {
        oid: commit.id(),
        // Merges are reviewed against their first parent; a root commit has none.
        parent_oid: commit.parent_ids().next(),
        info: info(&commit, head_oid(repo)),
    })
}

fn find_commit<'r>(repo: &'r Repository, rev: &str) -> AppResult<Commit<'r>> {
    if let Ok(oid) = Oid::from_str(rev) {
        if let Ok(commit) = repo.find_commit(oid) {
            return Ok(commit);
        }
    }
    repo.revparse_single(rev)
        .map_err(|_| AppError::Repo(format!("unknown revision: {rev}")))?
        .peel_to_commit()
        .map_err(|_| AppError::Repo(format!("{rev} does not name a commit")))
}

fn info(commit: &Commit, head_oid: Option<Oid>) -> CommitInfo {
    let parent_count = commit.parent_count() as u32;
    CommitInfo {
        oid: commit.id().to_string(),
        short_oid: short_oid(&commit.id()),
        summary: commit.summary().unwrap_or("(no message)").to_string(),
        author_name: commit
            .author()
            .name()
            .unwrap_or("(unknown author)")
            .to_string(),
        timestamp: commit.author().when().seconds(),
        parent_count,
        is_merge: parent_count > 1,
        is_head: head_oid == Some(commit.id()),
        refs: Vec::new(),
    }
}

fn head_oid(repo: &Repository) -> Option<Oid> {
    repo.head().ok()?.peel_to_commit().ok().map(|c| c.id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// Commits are dated by call order, so "newest first" is a real assertion rather
    /// than a tie broken by whatever order libgit2 happened to walk.
    fn git_at(dir: &Path, minute: u32, args: &[&str]) {
        let date = format!("2026-01-01T12:{minute:02}:00+00:00");
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "Ada")
            .env("GIT_AUTHOR_EMAIL", "ada@t")
            .env("GIT_COMMITTER_NAME", "Ada")
            .env("GIT_COMMITTER_EMAIL", "ada@t")
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .output()
            .expect("git");
        assert!(out.status.success(), "git {args:?} failed");
    }

    fn git(dir: &Path, args: &[&str]) {
        git_at(dir, 0, args);
    }

    /// `master` with three commits, plus a `feature` branch merged back into it — so
    /// `master`'s tip is a merge commit whose first parent is master's own work.
    fn repo_with_history(root: &Path) {
        git(root, &["init", "-q", "-b", "master"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(root, &["add", "."]);
        git_at(root, 1, &["commit", "-qm", "first"]);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        git_at(root, 2, &["commit", "-qam", "second"]);

        git(root, &["checkout", "-qb", "feature"]);
        std::fs::write(root.join("b.txt"), "on feature\n").unwrap();
        git(root, &["add", "."]);
        git_at(root, 3, &["commit", "-qm", "feature work"]);

        git(root, &["checkout", "-q", "master"]);
        std::fs::write(root.join("c.txt"), "on master\n").unwrap();
        git(root, &["add", "."]);
        git_at(root, 4, &["commit", "-qm", "third"]);
        git_at(
            root,
            5,
            &["merge", "-q", "--no-ff", "-m", "merge feature", "feature"],
        );
    }

    #[test]
    fn lists_history_newest_first_with_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        repo_with_history(root);
        let repo = Repository::open(root).unwrap();

        let commits = list(&repo, "refs/heads/master", 0, 100).unwrap();
        let summaries: Vec<&str> = commits.iter().map(|c| c.summary.as_str()).collect();
        assert_eq!(summaries[0], "merge feature");
        assert!(summaries.contains(&"feature work"), "merged-in commits are reachable");
        assert_eq!(summaries.last(), Some(&"first"));

        let tip = &commits[0];
        assert!(tip.is_merge);
        assert_eq!(tip.parent_count, 2);
        assert!(tip.is_head, "master is checked out");
        assert_eq!(tip.author_name, "Ada");
        assert_eq!(tip.short_oid, tip.oid[..7].to_string());
        assert!(commits[1..].iter().all(|c| !c.is_head));
        assert!(commits.iter().filter(|c| c.is_merge).count() == 1);
    }

    #[test]
    fn list_respects_the_limit_and_the_named_ref() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        repo_with_history(root);
        let repo = Repository::open(root).unwrap();

        assert_eq!(list(&repo, "refs/heads/master", 0, 2).unwrap().len(), 2);

        // feature never saw master's "third" commit.
        let feature = list(&repo, "refs/heads/feature", 0, 100).unwrap();
        let summaries: Vec<&str> = feature.iter().map(|c| c.summary.as_str()).collect();
        assert_eq!(summaries, vec!["feature work", "second", "first"]);

        assert!(list(&repo, "refs/heads/nope", 0, 10).is_err());
    }

    #[test]
    fn pages_through_history_with_skip() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        repo_with_history(root);
        let repo = Repository::open(root).unwrap();

        let all = list(&repo, "refs/heads/master", 0, 100).unwrap();
        let first = list(&repo, "refs/heads/master", 0, 2).unwrap();
        let second = list(&repo, "refs/heads/master", 2, 2).unwrap();
        let rest = list(&repo, "refs/heads/master", 4, 100).unwrap();
        let paged: Vec<&str> = first
            .iter()
            .chain(&second)
            .chain(&rest)
            .map(|c| c.oid.as_str())
            .collect();
        let expected: Vec<&str> = all.iter().map(|c| c.oid.as_str()).collect();
        assert_eq!(paged, expected);
        assert!(list(&repo, "refs/heads/master", 100, 10).unwrap().is_empty());
    }

    #[test]
    fn decorates_commits_with_the_refs_pointing_at_them() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        repo_with_history(root);
        git(root, &["tag", "v1", "HEAD~1"]);
        git(root, &["tag", "-a", "-m", "annotated", "v2", "HEAD"]);
        git(root, &["update-ref", "refs/remotes/origin/master", "HEAD"]);
        git(
            root,
            &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master"],
        );
        let repo = Repository::open(root).unwrap();

        let commits = list(&repo, "HEAD", 0, 100).unwrap();
        let names = |summary: &str| -> Vec<(String, DecorationKind)> {
            let commit = commits.iter().find(|c| c.summary == summary).unwrap();
            commit.refs.iter().map(|r| (r.name.clone(), r.kind)).collect()
        };
        // Local branch, then remote-tracking (without the symbolic origin/HEAD), then
        // tags — an annotated tag peels to its commit.
        assert_eq!(
            names("merge feature"),
            vec![
                ("master".to_string(), DecorationKind::Local),
                ("origin/master".to_string(), DecorationKind::Remote),
                ("v2".to_string(), DecorationKind::Tag),
            ]
        );
        assert_eq!(
            names("feature work"),
            vec![("feature".to_string(), DecorationKind::Local)]
        );
        assert_eq!(names("third"), vec![("v1".to_string(), DecorationKind::Tag)]);
        assert!(names("first").is_empty());

        // `resolve` names one commit and carries no decorations.
        assert!(resolve(&repo, "HEAD").unwrap().info.refs.is_empty());
    }

    #[test]
    fn resolves_abbreviations_and_reports_the_first_parent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        repo_with_history(root);
        let repo = Repository::open(root).unwrap();

        let commits = list(&repo, "refs/heads/master", 0, 100).unwrap();
        let merge = &commits[0];
        let resolved = resolve(&repo, &merge.short_oid).unwrap();
        assert_eq!(resolved.oid.to_string(), merge.oid, "short oid expands");

        // The first parent is master's own "third", not the merged-in branch.
        let parent = repo.find_commit(resolved.parent_oid.unwrap()).unwrap();
        assert_eq!(parent.summary(), Some("third"));

        // A root commit has no parent to diff against.
        let root_commit = resolve(&repo, commits.last().unwrap().oid.as_str()).unwrap();
        assert_eq!(root_commit.info.summary, "first");
        assert!(root_commit.parent_oid.is_none());
    }

    #[test]
    fn rejects_revisions_that_are_not_commits() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        repo_with_history(root);
        let repo = Repository::open(root).unwrap();

        assert!(resolve(&repo, "definitely-not-a-rev").is_err());
        // A blob is a valid object but not a commit.
        let blob = repo.revparse_single("HEAD:a.txt").unwrap().id().to_string();
        assert!(resolve(&repo, &blob).is_err());
    }
}
