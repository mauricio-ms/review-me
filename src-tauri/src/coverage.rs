use std::path::Path;

use git2::Repository;
use serde::Serialize;

use crate::diff::{self, ChangedFile, DiffLineKind, DiffSpec, Hunk};
use crate::error::AppResult;
use crate::tags::{self, Anchor, AnchorSide, ReviewScope, ReviewedTag, TagStore};

/// How far a tag store's marks get through a diff, counted in review *units*: a text
/// hunk with something to review, or a whole binary file. Each unit lands in exactly
/// one bucket by the diff buffer's precedence — flagged > ignored > reviewed — so the
/// three counts never overlap. Mirrors `reviewProgress`/`sectionForHunk` in
/// `src/lib/coverage.ts`, which renders the same thing live.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub total: u32,
    pub reviewed: u32,
    pub flagged: u32,
    pub ignored: u32,
}

/// One commit's review at a glance, for its row in the commits buffer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitReview {
    pub oid: String,
    pub coverage: Coverage,
    /// Flag tags in the commit's scope.
    pub flags: u32,
    /// Flags carrying a note — fixes left for later.
    pub notes: u32,
}

/// Review state for whichever of `oids` have a mark in their commit scope. A commit
/// nobody has marked is simply unreviewed and costs nothing; only marked commits get
/// their diff computed. Commits that no longer resolve are left out.
pub fn commit_reviews(
    repo: &Repository,
    root: &Path,
    oids: &[String],
) -> AppResult<Vec<CommitReview>> {
    let marked = tags::marked_scopes(root)?;
    let mut out = Vec::new();
    for oid in oids {
        let scope = ReviewScope::Commit { oid: oid.clone() };
        if !marked.contains(&scope) {
            continue;
        }
        let spec = DiffSpec::Commit {
            oid: oid.clone(),
            branch_ref: None,
        };
        let Ok(summary) = diff::compute(repo, &spec) else {
            continue;
        };
        let store = tags::load(root, &scope)?;
        out.push(CommitReview {
            oid: oid.clone(),
            coverage: summarize(&summary.files, &store),
            flags: store.flags.len() as u32,
            notes: store.flags.iter().filter(|t| has_note(t.note.as_deref())).count() as u32,
        });
    }
    Ok(out)
}

/// A flag note with something in it. Saving an empty note clears it, but a store
/// edited by hand could still hold whitespace.
pub fn has_note(note: Option<&str>) -> bool {
    note.is_some_and(|n| !n.trim().is_empty())
}

/// Bucket every unit of `files` against `store`, which must already be scoped (and
/// re-anchored) to the comparison `files` came from.
pub fn summarize(files: &[ChangedFile], store: &TagStore) -> Coverage {
    let flags = || store.flags.iter().map(|t| &t.anchor);
    let ignored = || store.ignored.iter().map(|t| &t.anchor);
    let mut out = Coverage::default();
    let mut count = |flagged: bool, ignored: bool, reviewed: bool| {
        out.total += 1;
        if flagged {
            out.flagged += 1;
        } else if ignored {
            out.ignored += 1;
        } else if reviewed {
            out.reviewed += 1;
        }
    };
    for file in files {
        if file.binary {
            count(
                file_tagged(flags(), &file.path),
                file_tagged(ignored(), &file.path),
                covers_file(&store.reviewed, &file.path),
            );
            continue;
        }
        for hunk in &file.hunks {
            let Some((side, lo, hi)) = hunk_target(hunk) else {
                continue;
            };
            count(
                overlaps(flags(), side, &file.path, lo, hi),
                overlaps(ignored(), side, &file.path, lo, hi),
                covers(&store.reviewed, side, &file.path, lo, hi),
            );
        }
    }
    out
}

/// The side and line span a hunk is reviewed against: the old side for a pure
/// deletion (its removed lines), the new side otherwise (context + added). `None` for
/// a hunk that changes nothing.
pub fn hunk_target(hunk: &Hunk) -> Option<(AnchorSide, u32, u32)> {
    let mut added = 0u32;
    let mut new_range: Option<(u32, u32)> = None;
    let mut old_range: Option<(u32, u32)> = None;
    let widen = |range: &mut Option<(u32, u32)>, line: u32| {
        *range = Some(match *range {
            Some((lo, hi)) => (lo.min(line), hi.max(line)),
            None => (line, line),
        });
    };
    for line in &hunk.lines {
        if matches!(line.kind, DiffLineKind::Added) {
            added += 1;
        }
        if let Some(n) = line.new_line {
            widen(&mut new_range, n);
        }
        if matches!(line.kind, DiffLineKind::Removed) {
            if let Some(n) = line.old_line {
                widen(&mut old_range, n);
            }
        }
    }
    if added > 0 {
        new_range.map(|(lo, hi)| (AnchorSide::New, lo, hi))
    } else {
        old_range.map(|(lo, hi)| (AnchorSide::Old, lo, hi))
    }
}

/// A reviewed tag spans all of `[lo, hi]` on `side` of `file`.
pub fn covers(tags: &[ReviewedTag], side: AnchorSide, file: &str, lo: u32, hi: u32) -> bool {
    tags.iter().any(|tag| {
        let anchor = &tag.anchor;
        !anchor.stale
            && anchor.side == side
            && anchor.file == file
            && anchor.start_line <= lo
            && anchor.end_line >= hi
    })
}

/// Any of `anchors` touches `[lo, hi]` on `side` of `file` — a flag or ignore on part
/// of a unit claims the whole unit.
pub fn overlaps<'a>(
    mut anchors: impl Iterator<Item = &'a Anchor>,
    side: AnchorSide,
    file: &str,
    lo: u32,
    hi: u32,
) -> bool {
    anchors.any(|anchor| {
        !anchor.stale
            && anchor.side == side
            && anchor.file == file
            && anchor.start_line <= hi
            && anchor.end_line >= lo
    })
}

/// A binary file is reviewed when a non-stale file anchor names its path.
pub fn covers_file(tags: &[ReviewedTag], file: &str) -> bool {
    tags.iter().any(|tag| {
        !tag.anchor.stale && tag.anchor.side == AnchorSide::File && tag.anchor.file == file
    })
}

/// File-scope flag/ignore check for binary files: any non-stale anchor on the path.
pub fn file_tagged<'a>(mut anchors: impl Iterator<Item = &'a Anchor>, file: &str) -> bool {
    anchors.any(|anchor| !anchor.stale && anchor.file == file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::{self, DiffSpec};
    use crate::tags::{self, AnchorKind, ReviewScope};
    use git2::Repository;
    use std::fs;
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

    /// A commit with four units: two text hunks in `a.txt` (lines 2 and 18 changed — far
    /// enough apart that their context doesn't merge them), a pure deletion in `b.txt`
    /// (lines 3-4 removed), and a binary file.
    fn commit_with_four_units(root: &Path) -> String {
        git(root, &["init", "-q", "-b", "master"]);
        let lines: Vec<String> = (1..=20).map(|n| format!("a{n}")).collect();
        fs::write(root.join("a.txt"), format!("{}\n", lines.join("\n"))).unwrap();
        fs::write(root.join("b.txt"), "b1\nb2\nb3\nb4\nb5\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "base"]);

        let mut edited = lines.clone();
        edited[1] = "A2".into();
        edited[17] = "A18".into();
        fs::write(root.join("a.txt"), format!("{}\n", edited.join("\n"))).unwrap();
        fs::write(root.join("b.txt"), "b1\nb2\nb5\n").unwrap();
        fs::write(root.join("logo.bin"), b"bin\0ary").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "work"]);

        let repo = Repository::open(root).unwrap();
        let oid = repo.head().unwrap().peel_to_commit().unwrap().id().to_string();
        oid
    }

    fn files(root: &Path, oid: &str) -> Vec<ChangedFile> {
        let repo = Repository::open(root).unwrap();
        let spec = DiffSpec::Commit {
            oid: oid.to_string(),
            branch_ref: None,
        };
        diff::compute(&repo, &spec).unwrap().files
    }

    #[test]
    fn hunk_targets_pick_the_reviewed_side() {
        let dir = tempfile::tempdir().unwrap();
        let oid = commit_with_four_units(dir.path());
        let files = files(dir.path(), &oid);

        let a = files.iter().find(|f| f.path == "a.txt").unwrap();
        let targets: Vec<_> = a.hunks.iter().filter_map(hunk_target).collect();
        assert_eq!(targets.len(), 2);
        assert!(targets.iter().all(|(side, _, _)| *side == AnchorSide::New));

        let b = files.iter().find(|f| f.path == "b.txt").unwrap();
        assert_eq!(hunk_target(&b.hunks[0]), Some((AnchorSide::Old, 3, 4)));
    }

    #[test]
    fn untouched_commit_has_every_unit_left_to_review() {
        let dir = tempfile::tempdir().unwrap();
        let oid = commit_with_four_units(dir.path());
        let files = files(dir.path(), &oid);

        let coverage = summarize(&files, &TagStore::default());
        assert_eq!(
            coverage,
            Coverage {
                total: 4,
                reviewed: 0,
                flagged: 0,
                ignored: 0
            }
        );
    }

    #[test]
    fn buckets_units_by_flag_ignore_review_precedence() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let oid = commit_with_four_units(root);
        let files = files(root, &oid);
        let scope = ReviewScope::Commit { oid: oid.clone() };
        let a = files.iter().find(|f| f.path == "a.txt").unwrap();
        let (_, lo1, hi1) = hunk_target(&a.hunks[0]).unwrap();
        let (_, lo2, hi2) = hunk_target(&a.hunks[1]).unwrap();

        // Hunk 1 reviewed *and* flagged: the flag wins.
        tags::add_reviewed(root, &scope, "a.txt", lo1, hi1, AnchorKind::Hunk, AnchorSide::New)
            .unwrap();
        tags::add_flag(
            root,
            &scope,
            "a.txt",
            lo1,
            lo1,
            AnchorKind::Range,
            AnchorSide::New,
            None,
            None,
        )
        .unwrap();
        // Hunk 2 reviewed.
        tags::add_reviewed(root, &scope, "a.txt", lo2, hi2, AnchorKind::Hunk, AnchorSide::New)
            .unwrap();
        // The deletion ignored on the old side; the binary reviewed as a file.
        tags::add_ignored(root, &scope, "b.txt", 3, 4, AnchorKind::Hunk, AnchorSide::Old)
            .unwrap();
        let store =
            tags::add_reviewed(root, &scope, "logo.bin", 0, 0, AnchorKind::File, AnchorSide::File)
                .unwrap();

        assert_eq!(
            summarize(&files, &store),
            Coverage {
                total: 4,
                reviewed: 2,
                flagged: 1,
                ignored: 1
            }
        );
    }

    #[test]
    fn commit_reviews_cover_only_marked_commits() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let reviewed = commit_with_four_units(root);
        git(root, &["commit", "-q", "--allow-empty", "-m", "untouched"]);
        let repo = Repository::open(root).unwrap();
        let untouched = repo.head().unwrap().peel_to_commit().unwrap().id().to_string();

        let scope = ReviewScope::Commit {
            oid: reviewed.clone(),
        };
        tags::add_ignored(root, &scope, "b.txt", 3, 4, AnchorKind::Hunk, AnchorSide::Old)
            .unwrap();
        tags::add_flag(
            root,
            &scope,
            "a.txt",
            2,
            2,
            AnchorKind::Range,
            AnchorSide::New,
            Some("use the shared client".into()),
            None,
        )
        .unwrap();
        tags::add_flag(
            root,
            &scope,
            "a.txt",
            18,
            18,
            AnchorKind::Range,
            AnchorSide::New,
            Some("   ".into()),
            None,
        )
        .unwrap();
        // A mark in another scope must not make a commit look touched.
        tags::add_reviewed(
            root,
            &ReviewScope::Worktree,
            "a.txt",
            1,
            1,
            AnchorKind::Range,
            AnchorSide::New,
        )
        .unwrap();

        let oids = vec![untouched, reviewed.clone(), "0".repeat(40)];
        let reviews = commit_reviews(&repo, root, &oids).unwrap();
        assert_eq!(reviews.len(), 1, "only the marked commit is summarized");
        let review = &reviews[0];
        assert_eq!(review.oid, reviewed);
        assert_eq!(
            review.coverage,
            Coverage {
                total: 4,
                reviewed: 0,
                flagged: 2,
                ignored: 1
            }
        );
        assert_eq!((review.flags, review.notes), (2, 1), "a blank note is no note");
    }

    #[test]
    fn a_partial_review_does_not_cover_the_hunk() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let oid = commit_with_four_units(root);
        let files = files(root, &oid);
        let scope = ReviewScope::Commit { oid };
        let a = files.iter().find(|f| f.path == "a.txt").unwrap();
        let (_, lo, hi) = hunk_target(&a.hunks[0]).unwrap();
        assert!(hi > lo, "the fixture hunk spans several lines");

        let store =
            tags::add_reviewed(root, &scope, "a.txt", lo, lo, AnchorKind::Range, AnchorSide::New)
                .unwrap();
        assert_eq!(summarize(&files, &store).reviewed, 0);
    }
}
