use super::*;
use crate::test_support::TestRepo;
use std::fs;

fn reviewed(fixture: &TestRepo, scope: &ReviewScope) -> TagStore {
    add_reviewed(
        fixture.path(),
        scope,
        "a.txt",
        1,
        1,
        AnchorKind::Range,
        AnchorSide::New,
    )
    .unwrap()
}

#[test]
fn absent_and_blank_storage_load_an_empty_review() {
    let fixture = TestRepo::new();
    assert!(load(fixture.path(), &ReviewScope::Worktree)
        .unwrap()
        .reviewed
        .is_empty());
    review_dir::ensure(fixture.path()).unwrap();
    fs::write(tags_path(fixture.path()), " \n\t").unwrap();
    assert!(load(fixture.path(), &ReviewScope::Worktree)
        .unwrap()
        .flags
        .is_empty());
}

#[test]
fn corrupt_or_truncated_storage_is_reported_and_never_overwritten_by_mutations() {
    let fixture = TestRepo::new();
    review_dir::ensure(fixture.path()).unwrap();
    let path = tags_path(fixture.path());
    for bytes in [
        "{",
        "not JSON",
        "{\"version\":1,\"flags\":[",
        "{\"version\":1,\"reviewed\":42}",
    ] {
        fs::write(&path, bytes).unwrap();
        assert!(load(fixture.path(), &ReviewScope::Worktree).is_err());
        assert!(clear_scope(fixture.path(), &ReviewScope::Worktree).is_err());
        assert!(add_reviewed(
            fixture.path(),
            &ReviewScope::Worktree,
            "a.txt",
            1,
            1,
            AnchorKind::Range,
            AnchorSide::New
        )
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), bytes);
    }
}

#[test]
fn storage_failures_return_errors_instead_of_an_empty_successful_review() {
    let fixture = TestRepo::new();
    review_dir::ensure(fixture.path()).unwrap();
    fs::create_dir(tags_path(fixture.path())).unwrap();
    assert!(load(fixture.path(), &ReviewScope::Worktree).is_err());
    assert!(add_flag(
        fixture.path(),
        &ReviewScope::Worktree,
        "a.txt",
        1,
        1,
        AnchorKind::Range,
        AnchorSide::New,
        Some("keep".into()),
        None
    )
    .is_err());
    assert!(tags_path(fixture.path()).is_dir());
}

#[cfg(unix)]
#[test]
fn read_only_storage_rejects_a_save_without_losing_the_previous_review() {
    let fixture = TestRepo::new();
    fixture.write("a.txt", "one\n");
    let mut store = reviewed(&fixture, &ReviewScope::Worktree);
    let path = tags_path(fixture.path());
    let before = fs::read(&path).unwrap();
    let original = fs::metadata(&path).unwrap().permissions();
    let mut read_only = original.clone();
    read_only.set_readonly(true);
    fs::set_permissions(&path, read_only).unwrap();
    // A privileged test runner can bypass mode bits. Probe with identical bytes so
    // this case remains explicit and cannot overwrite the fixture's review.
    if fs::write(&path, &before).is_ok() {
        fs::set_permissions(&path, original).unwrap();
        eprintln!("permission check unavailable: process can write read-only files");
        return;
    }
    store.reviewed.clear();
    let result = write(fixture.path(), &store);
    fs::set_permissions(&path, original).unwrap();
    assert!(result.is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(
        load(fixture.path(), &ReviewScope::Worktree)
            .unwrap()
            .reviewed
            .len(),
        1
    );
}

#[test]
fn removing_a_foreign_flag_id_cannot_modify_another_comparison() {
    let fixture = TestRepo::new();
    fixture.write("a.txt", "one\n");
    let oid = fixture.commit("base");
    let scope = ReviewScope::Commit { oid };
    let store = add_flag(
        fixture.path(),
        &scope,
        "a.txt",
        1,
        1,
        AnchorKind::Range,
        AnchorSide::New,
        Some("Keep this".into()),
        None,
    )
    .unwrap();
    let before = fs::read(tags_path(fixture.path())).unwrap();
    remove(fixture.path(), &ReviewScope::Worktree, &store.flags[0].id).unwrap();
    assert_eq!(fs::read(tags_path(fixture.path())).unwrap(), before);
}

#[test]
fn reviewed_tag_cleanup_is_limited_to_its_comparison() {
    let fixture = TestRepo::new();
    fixture.write("a.txt", "one\n");
    let scope = ReviewScope::Commit {
        oid: fixture.commit("base"),
    };
    let store = reviewed(&fixture, &scope);
    let ids = vec![store.reviewed[0].id.clone()];
    remove_reviewed_by_ids(fixture.path(), &ReviewScope::Worktree, &ids).unwrap();
    assert_eq!(load(fixture.path(), &scope).unwrap().reviewed.len(), 1);
}

#[test]
fn editing_a_note_in_another_scope_fails_without_changing_storage() {
    let fixture = TestRepo::new();
    fixture.write("a.txt", "one\n");
    let scope = ReviewScope::Commit {
        oid: fixture.commit("base"),
    };
    let store = add_flag(
        fixture.path(),
        &scope,
        "a.txt",
        1,
        1,
        AnchorKind::Range,
        AnchorSide::New,
        Some("Keep".into()),
        None,
    )
    .unwrap();
    let before = fs::read(tags_path(fixture.path())).unwrap();
    assert!(set_flag_note(
        fixture.path(),
        &ReviewScope::Worktree,
        &store.flags[0].id,
        Some("Changed".into())
    )
    .is_err());
    assert_eq!(fs::read(tags_path(fixture.path())).unwrap(), before);
}
