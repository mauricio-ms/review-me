use super::*;
use crate::tags::{AnchorKind, AnchorSide};
use crate::test_support::TestRepo;
use std::fs;

fn fixture() -> TestRepo {
    let fixture = TestRepo::new();
    let text = (1..=20).map(|n| format!("line {n}\n")).collect::<String>();
    fixture.write("a.txt", &text);
    fixture.commit("base");
    fixture.write(
        "a.txt",
        text.replace("line 2\n", "reviewed change\n")
            .replace("line 18\n", "unreviewed change\n"),
    );
    tags::add_reviewed(
        fixture.path(),
        &ReviewScope::Worktree,
        "a.txt",
        1,
        5,
        AnchorKind::Hunk,
        AnchorSide::New,
    )
    .unwrap();
    fixture
}

fn stage(fixture: &TestRepo, path: &str) {
    let mut index = fixture.repo.index().unwrap();
    index.add_path(Path::new(path)).unwrap();
    index.write().unwrap();
}

fn advance_head(fixture: &TestRepo) {
    let parent = fixture.repo.head().unwrap().peel_to_commit().unwrap();
    let signature = git2::Signature::now("Other", "other@example.invalid").unwrap();
    fixture
        .repo
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            "external commit",
            &parent.tree().unwrap(),
            &[&parent],
        )
        .unwrap();
}

#[test]
fn refusing_existing_staging_leaves_index_worktree_and_marks_unchanged() {
    let fixture = fixture();
    fixture.write("other.txt", "already staged\n");
    stage(&fixture, "other.txt");
    let index = fixture.staged();
    let head = fixture.head();
    let worktree = fs::read(fixture.path().join("a.txt")).unwrap();
    let marks = fs::read(fixture.path().join(".review-me/tags.json")).unwrap();
    assert!(prepare(&fixture.repo, false).is_err());
    assert_eq!(fixture.staged(), index);
    assert_eq!(fixture.head(), head);
    assert_eq!(fs::read(fixture.path().join("a.txt")).unwrap(), worktree);
    assert_eq!(
        fs::read(fixture.path().join(".review-me/tags.json")).unwrap(),
        marks
    );
}

#[test]
fn confirmed_unstaging_preserves_files_and_commits_only_reviewed_content() {
    let fixture = fixture();
    fixture.write("other.txt", "keep this staged file\n");
    stage(&fixture, "other.txt");
    let prepared = prepare(&fixture.repo, true).unwrap();
    assert_eq!(prepared.staged_paths, vec!["a.txt"]);
    commit(&fixture.repo, "reviewed only", &prepared.reviewed_tag_ids).unwrap();
    let tree = fixture.repo.head().unwrap().peel_to_tree().unwrap();
    assert!(tree.get_path(Path::new("other.txt")).is_err());
    let entry = tree.get_path(Path::new("a.txt")).unwrap();
    let blob = fixture.repo.find_blob(entry.id()).unwrap();
    let content = std::str::from_utf8(blob.content()).unwrap();
    assert!(content.contains("reviewed change"));
    assert!(!content.contains("unreviewed change"));
    assert_eq!(
        fs::read_to_string(fixture.path().join("other.txt")).unwrap(),
        "keep this staged file\n"
    );
    assert!(fs::read_to_string(fixture.path().join("a.txt"))
        .unwrap()
        .contains("unreviewed change"));
}

#[test]
fn failed_tag_loading_cannot_discard_existing_staging_even_when_unstaging_is_confirmed() {
    let fixture = fixture();
    fixture.write("other.txt", "keep\n");
    stage(&fixture, "other.txt");
    let before = fixture.staged();
    fixture.write(".review-me/tags.json", "{broken");
    assert!(prepare(&fixture.repo, true).is_err());
    assert_eq!(fixture.staged(), before);
}

#[test]
fn an_index_lock_causes_preparation_to_fail_without_changing_the_repository() {
    let fixture = fixture();
    let head = fixture.head();
    let index = fixture.staged();
    let lock = fixture.repo.path().join("index.lock");
    fs::write(&lock, "another process owns this lock").unwrap();
    assert!(prepare(&fixture.repo, false).is_err());
    assert_eq!(fixture.head(), head);
    assert_eq!(fixture.staged(), index);
    assert_eq!(
        fs::read_to_string(lock).unwrap(),
        "another process owns this lock"
    );
}

#[test]
fn missing_git_identity_preserves_staged_content_for_retry() {
    let fixture = fixture();
    let prepared = prepare(&fixture.repo, false).unwrap();
    let head = fixture.head();
    let index = fixture.staged();
    let mut config = fixture.repo.config().unwrap();
    config.set_str("user.name", "").unwrap();
    config.set_str("user.email", "").unwrap();
    assert!(commit(&fixture.repo, "message", &prepared.reviewed_tag_ids)
        .unwrap_err()
        .to_string()
        .contains("user.name"));
    assert_eq!(fixture.head(), head);
    assert_eq!(fixture.staged(), index);
    assert_eq!(
        tags::load(fixture.path(), &ReviewScope::Worktree)
            .unwrap()
            .reviewed
            .len(),
        1
    );
    config.set_str("user.name", "Test").unwrap();
    config
        .set_str("user.email", "test@example.invalid")
        .unwrap();
    commit(&fixture.repo, "message", &prepared.reviewed_tag_ids).unwrap();
}

#[test]
fn externally_changed_index_is_rejected_and_never_committed() {
    let fixture = fixture();
    let prepared = prepare(&fixture.repo, false).unwrap();
    fixture.write("unreviewed.txt", "not approved\n");
    stage(&fixture, "unreviewed.txt");
    let index = fixture.staged();
    let head = fixture.head();
    assert!(commit(&fixture.repo, "message", &prepared.reviewed_tag_ids)
        .unwrap_err()
        .to_string()
        .contains("index changed"));
    assert_eq!(fixture.head(), head);
    assert_eq!(fixture.staged(), index);
}

#[test]
fn externally_changed_head_is_rejected_without_overwriting_the_index() {
    let fixture = fixture();
    let prepared = prepare(&fixture.repo, false).unwrap();
    advance_head(&fixture);
    let head = fixture.head();
    let index = fixture.staged();
    assert!(commit(&fixture.repo, "message", &prepared.reviewed_tag_ids)
        .unwrap_err()
        .to_string()
        .contains("HEAD changed"));
    assert_eq!(fixture.head(), head);
    assert_eq!(fixture.staged(), index);
}

#[test]
fn abort_refuses_to_unstage_changes_added_after_preparation() {
    let fixture = fixture();
    prepare(&fixture.repo, false).unwrap();
    fixture.write("external.txt", "keep staged\n");
    stage(&fixture, "external.txt");
    let index = fixture.staged();
    assert!(abort(&fixture.repo)
        .unwrap_err()
        .to_string()
        .contains("index changed"));
    assert_eq!(fixture.staged(), index);
}

#[test]
fn abort_refuses_to_reset_an_index_against_a_different_head() {
    let fixture = fixture();
    prepare(&fixture.repo, false).unwrap();
    advance_head(&fixture);
    let index = fixture.staged();
    assert!(abort(&fixture.repo)
        .unwrap_err()
        .to_string()
        .contains("HEAD changed"));
    assert_eq!(fixture.staged(), index);
}

#[test]
fn abort_without_a_preparation_never_unstages_unrelated_work() {
    let fixture = fixture();
    fixture.write("other.txt", "keep\n");
    stage(&fixture, "other.txt");
    let index = fixture.staged();
    abort(&fixture.repo).unwrap();
    assert_eq!(fixture.staged(), index);
}

#[test]
fn later_worktree_edits_survive_commit_of_the_prepared_snapshot() {
    let fixture = fixture();
    let prepared = prepare(&fixture.repo, false).unwrap();
    fixture.write("a.txt", "newer unsaved-to-index work\n");
    commit(&fixture.repo, "snapshot", &prepared.reviewed_tag_ids).unwrap();
    assert_eq!(
        fs::read_to_string(fixture.path().join("a.txt")).unwrap(),
        "newer unsaved-to-index work\n"
    );
    let tree = fixture.repo.head().unwrap().peel_to_tree().unwrap();
    let blob = fixture
        .repo
        .find_blob(tree.get_path(Path::new("a.txt")).unwrap().id())
        .unwrap();
    assert!(std::str::from_utf8(blob.content())
        .unwrap()
        .contains("reviewed change"));
}

#[test]
fn cleanup_failure_reports_the_created_commit_and_retry_only_finishes_cleanup() {
    let fixture = fixture();
    let prepared = prepare(&fixture.repo, false).unwrap();
    let before = fixture.head();
    let path = fixture.path().join(".review-me/tags.json");
    let original = fs::read(&path).unwrap();
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    let error = commit(
        &fixture.repo,
        "already committed",
        &prepared.reviewed_tag_ids,
    )
    .unwrap_err()
    .to_string();
    let committed = fixture.head();
    assert_ne!(committed, before);
    assert!(
        error.contains(&short_oid(&committed.to_string())),
        "{error}"
    );
    assert!(error.contains("created"), "{error}");
    fs::remove_dir(&path).unwrap();
    fs::write(&path, original).unwrap();
    // A reopened repository simulates retrying after restarting the app.
    let reopened = Repository::open(fixture.path()).unwrap();
    let result = commit(&reopened, "already committed", &prepared.reviewed_tag_ids).unwrap();
    assert_eq!(result.commit, short_oid(&committed.to_string()));
    assert_eq!(fixture.head(), committed);
    assert!(result.tag_store.reviewed.is_empty());
}

#[test]
fn committing_with_no_staged_changes_leaves_head_and_marks_unchanged() {
    let fixture = fixture();
    let head = fixture.head();
    assert!(commit(&fixture.repo, "nothing", &[]).is_err());
    assert_eq!(fixture.head(), head);
    assert_eq!(
        tags::load(fixture.path(), &ReviewScope::Worktree)
            .unwrap()
            .reviewed
            .len(),
        1
    );
}

#[test]
fn failure_to_persist_preparation_restores_the_original_staged_snapshot() {
    let fixture = fixture();
    fixture.write("other.txt", "already staged\n");
    stage(&fixture, "other.txt");
    let original = fixture.staged();
    let head = fixture.head();
    let error = prepare_with(&fixture.repo, true, |_, _| {
        Err(std::io::Error::other("injected storage failure").into())
    })
    .unwrap_err();
    assert!(error.to_string().contains("injected storage failure"));
    assert_eq!(fixture.staged(), original);
    assert_eq!(fixture.head(), head);
    assert!(!preparation_path(&fixture.repo).exists());
}

#[test]
fn rollback_never_replaces_newer_staging_from_another_process() {
    let fixture = fixture();
    let error = prepare_with(&fixture.repo, false, |_, _| {
        fixture.write("external.txt", "new staging\n");
        stage(&fixture, "external.txt");
        Err(std::io::Error::other("storage failure").into())
    })
    .unwrap_err();
    assert!(error
        .to_string()
        .contains("index changed during preparation"));
    assert!(fixture
        .repo
        .index()
        .unwrap()
        .get_path(Path::new("external.txt"), 0)
        .is_some());
    assert!(!fixture.repo.path().join("index.lock").exists());
}

#[test]
fn switching_branches_at_the_same_commit_invalidates_the_preparation() {
    let fixture = fixture();
    let prepared = prepare(&fixture.repo, false).unwrap();
    let head = fixture.repo.head().unwrap().peel_to_commit().unwrap();
    fixture.repo.branch("other", &head, false).unwrap();
    fixture.repo.set_head("refs/heads/other").unwrap();
    let index = fixture.staged();
    assert!(
        commit(&fixture.repo, "wrong branch", &prepared.reviewed_tag_ids)
            .unwrap_err()
            .to_string()
            .contains("HEAD changed")
    );
    assert_eq!(fixture.staged(), index);
    assert_eq!(fixture.head(), head.id());
}

#[test]
fn a_changed_reviewed_tag_selection_is_rejected_before_committing() {
    let fixture = fixture();
    prepare(&fixture.repo, false).unwrap();
    let head = fixture.head();
    assert!(
        commit(&fixture.repo, "wrong selection", &["foreign-id".into()])
            .unwrap_err()
            .to_string()
            .contains("selection changed")
    );
    assert_eq!(fixture.head(), head);
}

#[test]
fn an_unborn_repository_can_commit_and_abort_reviewed_additions() {
    let fixture = TestRepo::new();
    fixture.write("new.txt", "first\n");
    tags::add_reviewed(
        fixture.path(),
        &ReviewScope::Worktree,
        "new.txt",
        1,
        1,
        AnchorKind::Hunk,
        AnchorSide::New,
    )
    .unwrap();
    prepare(&fixture.repo, false).unwrap();
    abort(&fixture.repo).unwrap();
    assert!(fixture.repo.index().unwrap().is_empty());
    assert_eq!(
        fs::read_to_string(fixture.path().join("new.txt")).unwrap(),
        "first\n"
    );
    let prepared = prepare(&fixture.repo, false).unwrap();
    commit(&fixture.repo, "first commit", &prepared.reviewed_tag_ids).unwrap();
    assert_eq!(
        fixture
            .repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .parent_count(),
        0
    );
}

#[test]
fn reopening_the_commit_dialog_recovers_cleanup_without_creating_another_commit() {
    let fixture = fixture();
    let prepared = prepare(&fixture.repo, false).unwrap();
    let path = fixture.path().join(".review-me/tags.json");
    let original = fs::read(&path).unwrap();
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(commit(&fixture.repo, "created already", &prepared.reviewed_tag_ids).is_err());
    let committed = fixture.head();
    fs::remove_dir(&path).unwrap();
    fs::write(&path, original).unwrap();
    let reopened = Repository::open(fixture.path()).unwrap();
    let result = preflight(&reopened).unwrap();
    assert_eq!(result.reviewed_hunk_count, 0);
    assert_eq!(fixture.head(), committed);
    assert!(!preparation_path(&reopened).exists());
    assert!(tags::load(fixture.path(), &ReviewScope::Worktree)
        .unwrap()
        .reviewed
        .is_empty());
}

#[test]
fn a_reviewed_untracked_file_can_be_staged_without_picking_up_other_untracked_files() {
    let fixture = fixture();
    fixture.write("new.txt", "new reviewed content\n");
    fixture.write("unreviewed.txt", "leave untracked\n");
    tags::add_reviewed(
        fixture.path(),
        &ReviewScope::Worktree,
        "new.txt",
        1,
        1,
        AnchorKind::Hunk,
        AnchorSide::New,
    )
    .unwrap();
    let prepared = prepare(&fixture.repo, false).unwrap();
    assert_eq!(prepared.staged_paths, vec!["a.txt", "new.txt"]);
    commit(
        &fixture.repo,
        "include reviewed additions",
        &prepared.reviewed_tag_ids,
    )
    .unwrap();
    let tree = fixture.repo.head().unwrap().peel_to_tree().unwrap();
    assert!(tree.get_path(Path::new("new.txt")).is_ok());
    assert!(tree.get_path(Path::new("unreviewed.txt")).is_err());
}
