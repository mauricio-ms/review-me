use super::*;
use crate::test_support::TestRepo;
use std::fs;

fn fixture() -> (TestRepo, String, String) {
    let fixture = TestRepo::new();
    fixture.write("a.txt", "before\n");
    let base = fixture.commit("base");
    fixture.write("a.txt", "one\ntwo\nthree\n");
    let tip = fixture.commit("changes");
    (fixture, base, tip)
}

fn scope(oid: &str) -> ReviewScope {
    ReviewScope::Commit { oid: oid.into() }
}

fn note(fixture: &TestRepo, oid: &str, text: &str) -> String {
    add_flag_tag(
        fixture.arg(),
        scope(oid),
        "a.txt".into(),
        1,
        1,
        AnchorKind::Range,
        AnchorSide::New,
        Some(text.into()),
        None,
    )
    .unwrap()
    .flags[0]
        .id
        .clone()
}

fn document(fixture: &TestRepo, oid: &str) -> PathBuf {
    fixture
        .path()
        .join(format!(".review-me/notes/commits/{oid}.md"))
}

#[test]
fn flag_edit_resolve_and_export_use_the_actual_command_composition() {
    let (fixture, _, oid) = fixture();
    let id = note(&fixture, &oid, "Original concern");
    let file = document(&fixture, &oid);
    assert!(fs::read_to_string(&file)
        .unwrap()
        .contains("Original concern"));
    assert!(fixture.path().join(".review-me/notes/README.md").exists());
    set_flag_note(
        fixture.arg(),
        scope(&oid),
        id.clone(),
        Some("Revised concern".into()),
    )
    .unwrap();
    let md = fs::read_to_string(&file).unwrap();
    assert!(md.contains("Revised concern"));
    assert!(!md.contains("Original concern"));
    let export = export_notes(fixture.arg(), "refs/heads/master".into(), None).unwrap();
    assert_eq!((export.commits, export.notes), (1, 1));
    let bundle = fixture.path().join(export.path.unwrap());
    let store = resolve_flags(
        fixture.arg(),
        scope(&oid),
        vec![FlagRef {
            scope: scope(&oid),
            id,
        }],
    )
    .unwrap();
    assert!(store.flags.is_empty());
    assert_eq!(
        store.resolved_flags[0].flag.note.as_deref(),
        Some("Revised concern")
    );
    assert!(!file.exists());
    assert!(!fixture.path().join(".review-me/notes/README.md").exists());
    let export = export_notes(fixture.arg(), "refs/heads/master".into(), None).unwrap();
    assert!(export.path.is_none());
    assert!(!bundle.exists());
}

#[test]
fn removing_or_clearing_the_last_note_updates_generated_documents() {
    let (fixture, _, oid) = fixture();
    let id = note(&fixture, &oid, "Remove this");
    remove_tag(fixture.arg(), scope(&oid), id).unwrap();
    assert!(!document(&fixture, &oid).exists());
    note(&fixture, &oid, "Unmark this");
    unmark_range(
        fixture.arg(),
        scope(&oid),
        "a.txt".into(),
        1,
        1,
        AnchorSide::New,
    )
    .unwrap();
    assert!(!document(&fixture, &oid).exists());
    note(&fixture, &oid, "Clear this");
    clear_tags(fixture.arg(), scope(&oid)).unwrap();
    assert!(!document(&fixture, &oid).exists());
    assert!(!fixture.path().join(".review-me/notes/README.md").exists());
}

#[test]
fn resolving_a_batch_updates_every_commit_and_returns_only_the_requested_scope() {
    let (fixture, base, tip) = fixture();
    let first = note(&fixture, &base, "Base concern");
    let second = note(&fixture, &tip, "Tip concern");
    add_reviewed_tag(
        fixture.arg(),
        ReviewScope::Worktree,
        "a.txt".into(),
        1,
        1,
        AnchorKind::Range,
        AnchorSide::New,
    )
    .unwrap();
    let store = resolve_flags(
        fixture.arg(),
        ReviewScope::Worktree,
        vec![
            FlagRef {
                scope: scope(&base),
                id: first,
            },
            FlagRef {
                scope: scope(&tip),
                id: second,
            },
        ],
    )
    .unwrap();
    assert_eq!(store.reviewed.len(), 1);
    assert!(
        store.resolved_flags.is_empty(),
        "commit archives cannot leak into worktree scope"
    );
    for oid in [&base, &tip] {
        assert!(!document(&fixture, oid).exists());
        assert_eq!(
            load_tags(fixture.arg(), scope(oid))
                .unwrap()
                .resolved_flags
                .len(),
            1
        );
    }
    assert!(flags_for_commits(fixture.arg(), vec![base, tip])
        .unwrap()
        .is_empty());
}

#[test]
fn an_invalid_batch_cannot_partially_change_tags_or_note_documents() {
    let (fixture, _, oid) = fixture();
    let id = note(&fixture, &oid, "Keep this concern");
    let path = fixture.path().join(".review-me/tags.json");
    let tags = fs::read(&path).unwrap();
    let notes = fs::read(document(&fixture, &oid)).unwrap();
    let error = resolve_flags(
        fixture.arg(),
        scope(&oid),
        vec![
            FlagRef {
                scope: scope(&oid),
                id,
            },
            FlagRef {
                scope: scope(&oid),
                id: "missing".into(),
            },
        ],
    )
    .unwrap_err();
    assert!(error.to_string().contains("no longer active"));
    assert_eq!(fs::read(path).unwrap(), tags);
    assert_eq!(fs::read(document(&fixture, &oid)).unwrap(), notes);
}

#[test]
fn a_failed_note_projection_preserves_the_saved_flag_and_export_can_repair_it() {
    let (fixture, _, oid) = fixture();
    crate::review_dir::ensure(fixture.path()).unwrap();
    let blocker = fixture.path().join(".review-me/notes");
    fs::write(&blocker, "blocked export directory").unwrap();
    let id = note(&fixture, &oid, "Must survive export failure");
    let store = load_tags(fixture.arg(), scope(&oid)).unwrap();
    assert_eq!(store.flags[0].id, id);
    assert_eq!(
        store.flags[0].note.as_deref(),
        Some("Must survive export failure")
    );
    fs::remove_file(blocker).unwrap();
    let export = export_notes(fixture.arg(), "refs/heads/master".into(), None).unwrap();
    assert_eq!(export.notes, 1);
    assert!(document(&fixture, &oid).is_file());
}

#[test]
fn worktree_marks_do_not_generate_committed_note_documents() {
    let (fixture, _, _) = fixture();
    add_flag_tag(
        fixture.arg(),
        ReviewScope::Worktree,
        "a.txt".into(),
        1,
        1,
        AnchorKind::Range,
        AnchorSide::New,
        Some("Worktree concern".into()),
        None,
    )
    .unwrap();
    assert!(!fixture.path().join(".review-me/notes").exists());
}

#[test]
fn file_read_commands_respect_the_requested_revision_from_a_nested_repo_path() {
    let (fixture, base, _) = fixture();
    fixture.write("a.txt", "dirty worktree\n");
    fs::create_dir(fixture.path().join("nested")).unwrap();
    let path = fixture.path().join("nested").to_str().unwrap().to_string();
    assert_eq!(
        read_file(
            path.clone(),
            ProjectSource::Commit { oid: base },
            "a.txt".into()
        )
        .unwrap(),
        "before\n"
    );
    assert_eq!(
        read_file(path, ProjectSource::Worktree, "a.txt".into()).unwrap(),
        "dirty worktree\n"
    );
}
