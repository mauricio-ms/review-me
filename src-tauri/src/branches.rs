use git2::{BranchType, Oid, Repository};
use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Fallback default-base candidates, in order, when the repo has no
/// `refs/remotes/<remote>/HEAD` to read a default branch from.
const DEFAULT_CANDIDATES: [&str; 2] = ["master", "main"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BranchKind {
    Local,
    Remote,
}

/// One selectable ref in the branch-comparison picker. `name` is the canonical ref
/// (`refs/heads/x`, `refs/remotes/origin/x`) — requests and persisted review scopes
/// use it so a local `x` and a remote `origin/x` are never confused. `display` is the
/// shorthand shown to the reviewer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub display: String,
    pub short_oid: String,
    pub kind: BranchKind,
    /// The branch HEAD currently points at.
    pub is_current: bool,
    /// The repo's inferred default branch (remote HEAD, else `master`, else `main`).
    pub is_default: bool,
}

/// A branch comparison resolved against the object database: both tips plus their
/// merge base. `base_oid`/`target_oid` are the snapshot currently displayed; the ref
/// names are the durable identity used by review scopes.
#[derive(Debug, Clone)]
pub struct ResolvedBranches {
    pub base_ref: String,
    pub base_name: String,
    pub base_oid: Oid,
    pub target_ref: String,
    pub target_name: String,
    pub target_oid: Oid,
    pub merge_base: Oid,
}

/// Every local and remote-tracking branch, locals first then remotes, each group
/// sorted by display name. Symbolic aliases (`origin/HEAD`) are skipped — they point
/// at a branch that is already listed.
pub fn list(repo: &Repository) -> AppResult<Vec<BranchInfo>> {
    let default_ref = default_branch_ref(repo);
    let mut out = Vec::new();

    for kind in [BranchType::Local, BranchType::Remote] {
        for entry in repo.branches(Some(kind))? {
            let (branch, _) = entry?;
            let reference = branch.get();
            // A symbolic ref (origin/HEAD) is an alias, not a branch of its own.
            if reference.symbolic_target().is_some() {
                continue;
            }
            let Some(name) = reference.name() else {
                continue;
            };
            let Some(oid) = reference.target() else {
                continue;
            };
            let display = branch.name()?.unwrap_or(name).to_string();
            out.push(BranchInfo {
                is_current: kind == BranchType::Local && branch.is_head(),
                is_default: default_ref.as_deref() == Some(name),
                name: name.to_string(),
                display,
                short_oid: short_oid(&oid),
                kind: match kind {
                    BranchType::Local => BranchKind::Local,
                    BranchType::Remote => BranchKind::Remote,
                },
            });
        }
    }

    out.sort_by(|a, b| {
        let rank = |b: &BranchInfo| if b.kind == BranchKind::Local { 0 } else { 1 };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.display.cmp(&b.display))
    });
    Ok(out)
}

/// The canonical ref of the repo's default branch: whatever `refs/remotes/*/HEAD`
/// points at (preferring the matching local branch), else `master`, else `main`.
/// `None` when none of those exist.
pub fn default_branch_ref(repo: &Repository) -> Option<String> {
    if let Some(remote_head) = remote_head_ref(repo) {
        // Prefer the local branch of the same shorthand — that's what a reviewer
        // means by "master", and it's the ref they can compare against offline.
        if let Some(shorthand) = remote_head.rsplit('/').next() {
            let local = format!("refs/heads/{shorthand}");
            if repo.find_reference(&local).is_ok() {
                return Some(local);
            }
        }
        return Some(remote_head);
    }
    DEFAULT_CANDIDATES
        .iter()
        .map(|name| format!("refs/heads/{name}"))
        .find(|candidate| repo.find_reference(candidate).is_ok())
}

/// The canonical ref `refs/remotes/<remote>/HEAD` resolves to, checking `origin`
/// first and then any other remote.
fn remote_head_ref(repo: &Repository) -> Option<String> {
    let remotes = repo.remotes().ok()?;
    let names: Vec<String> = remotes.iter().flatten().map(str::to_string).collect();
    let ordered = std::iter::once("origin".to_string())
        .chain(names.iter().filter(|n| *n != "origin").cloned());
    for remote in ordered {
        let head = format!("refs/remotes/{remote}/HEAD");
        if let Ok(reference) = repo.find_reference(&head) {
            if let Some(target) = reference.symbolic_target() {
                return Some(target.to_string());
            }
        }
    }
    None
}

/// Resolve a base/target ref pair to their tips and merge base. Errors when either
/// ref is unknown, when they name the same ref, or when the two commits share no
/// history (nothing meaningful to review).
pub fn resolve(repo: &Repository, base_ref: &str, target_ref: &str) -> AppResult<ResolvedBranches> {
    if base_ref == target_ref {
        return Err(AppError::Repo(
            "base and target must be different branches".into(),
        ));
    }
    let (base_oid, base_name) = resolve_ref(repo, base_ref)?;
    let (target_oid, target_name) = resolve_ref(repo, target_ref)?;
    let merge_base = repo.merge_base(base_oid, target_oid).map_err(|_| {
        AppError::Repo(format!(
            "{base_name} and {target_name} have no common ancestor"
        ))
    })?;
    Ok(ResolvedBranches {
        base_ref: base_ref.to_string(),
        base_name,
        base_oid,
        target_ref: target_ref.to_string(),
        target_name,
        target_oid,
        merge_base,
    })
}

/// `(tip_oid, display_name)` for a canonical ref. Falls back to `revparse` so a
/// shorthand (`master`) or any other committish still resolves.
fn resolve_ref(repo: &Repository, name: &str) -> AppResult<(Oid, String)> {
    if let Ok(reference) = repo.find_reference(name) {
        let commit = reference.peel_to_commit().map_err(|e| {
            AppError::Repo(format!("{name} does not point at a commit: {e}"))
        })?;
        let display = reference.shorthand().unwrap_or(name).to_string();
        return Ok((commit.id(), display));
    }
    let object = repo
        .revparse_single(name)
        .map_err(|_| AppError::Repo(format!("unknown branch or revision: {name}")))?;
    let commit = object
        .peel_to_commit()
        .map_err(|e| AppError::Repo(format!("{name} does not point at a commit: {e}")))?;
    Ok((commit.id(), name.to_string()))
}

pub fn short_oid(oid: &Oid) -> String {
    oid.to_string().chars().take(7).collect()
}

/// The display shorthand of a canonical ref: `refs/heads/x` → `x`,
/// `refs/remotes/origin/x` → `origin/x`. Anything else is already short.
pub fn shorthand(ref_name: &str) -> &str {
    ref_name
        .strip_prefix("refs/heads/")
        .or_else(|| ref_name.strip_prefix("refs/remotes/"))
        .unwrap_or(ref_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .expect("git");
        assert!(out.status.success(), "git {args:?} failed");
    }

    /// A repo on `master` with one commit, plus a `feature` branch one commit ahead.
    fn diverged_repo(root: &Path) {
        git(root, &["init", "-q", "-b", "master"]);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "init"]);
        git(root, &["checkout", "-qb", "feature"]);
        std::fs::write(root.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        git(root, &["commit", "-qam", "feature work"]);
    }

    #[test]
    fn lists_local_branches_with_current_and_default() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        diverged_repo(root);

        let repo = Repository::open(root).unwrap();
        let branches = list(&repo).unwrap();
        let names: Vec<&str> = branches.iter().map(|b| b.display.as_str()).collect();
        assert_eq!(names, vec!["feature", "master"]);

        let feature = branches.iter().find(|b| b.display == "feature").unwrap();
        assert!(feature.is_current);
        assert!(!feature.is_default);
        assert_eq!(feature.kind, BranchKind::Local);

        let master = branches.iter().find(|b| b.display == "master").unwrap();
        assert!(!master.is_current);
        assert!(master.is_default, "master is the inferred default");
        assert_eq!(master.name, "refs/heads/master");
    }

    #[test]
    fn lists_remote_branches_after_locals_and_skips_head_alias() {
        let origin_dir = tempfile::tempdir().unwrap();
        let origin = origin_dir.path();
        diverged_repo(origin);
        git(origin, &["checkout", "-q", "master"]);

        let clone_dir = tempfile::tempdir().unwrap();
        let clone = clone_dir.path().join("clone");
        git(
            clone_dir.path(),
            &["clone", "-q", origin.to_str().unwrap(), "clone"],
        );

        let repo = Repository::open(&clone).unwrap();
        let branches = list(&repo).unwrap();
        assert!(
            !branches.iter().any(|b| b.display.ends_with("/HEAD")),
            "origin/HEAD alias must be hidden, got {:?}",
            branches.iter().map(|b| &b.display).collect::<Vec<_>>()
        );
        assert!(branches.iter().any(|b| b.display == "origin/feature"));
        // Locals sort ahead of remotes.
        let first_remote = branches
            .iter()
            .position(|b| b.kind == BranchKind::Remote)
            .unwrap();
        assert!(branches[..first_remote]
            .iter()
            .all(|b| b.kind == BranchKind::Local));
        // The clone's remote HEAD names master, and the local master wins.
        let default: Vec<&str> = branches
            .iter()
            .filter(|b| b.is_default)
            .map(|b| b.name.as_str())
            .collect();
        assert_eq!(default, vec!["refs/heads/master"]);
    }

    #[test]
    fn resolve_finds_merge_base_and_rejects_same_ref() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        diverged_repo(root);

        let repo = Repository::open(root).unwrap();
        let resolved = resolve(&repo, "refs/heads/master", "refs/heads/feature").unwrap();
        assert_eq!(resolved.base_name, "master");
        assert_eq!(resolved.target_name, "feature");
        // master is an ancestor of feature, so it *is* the merge base.
        assert_eq!(resolved.merge_base, resolved.base_oid);
        assert_ne!(resolved.target_oid, resolved.base_oid);

        assert!(resolve(&repo, "refs/heads/master", "refs/heads/master").is_err());
        assert!(resolve(&repo, "refs/heads/master", "refs/heads/nope").is_err());
    }

    #[test]
    fn resolve_uses_the_true_merge_base_when_both_sides_moved() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        diverged_repo(root);
        // Advance master past the fork point too.
        git(root, &["checkout", "-q", "master"]);
        std::fs::write(root.join("b.txt"), "base only\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "master work"]);

        let repo = Repository::open(root).unwrap();
        let resolved = resolve(&repo, "refs/heads/master", "refs/heads/feature").unwrap();
        assert_ne!(resolved.merge_base, resolved.base_oid);
        assert_ne!(resolved.merge_base, resolved.target_oid);
    }
}
