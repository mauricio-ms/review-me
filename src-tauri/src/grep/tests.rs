use super::*;
use crate::test_support::TestRepo;

fn request(fixture: &TestRepo, query: &str) -> SearchRequest {
    SearchRequest {
        repo: fixture.arg(),
        source: ProjectSource::Worktree,
        query: query.into(),
        only: None,
    }
}

fn run(request: SearchRequest) -> SearchResults {
    search(request, &AtomicBool::new(false)).unwrap()
}

#[test]
fn literal_smart_case_ranges_and_order_are_stable() {
    let f = TestRepo::new();
    f.write("b.txt", "needle\n");
    f.write("a.txt", "😀 NEEDLE needle\r\nliteral a.b and axb\n");
    let result = run(request(&f, "needle"));
    assert_eq!(
        result
            .hits
            .iter()
            .map(|h| (h.path.as_str(), h.line, h.col))
            .collect::<Vec<_>>(),
        vec![("a.txt", 1, 3), ("b.txt", 1, 0)]
    );
    assert_eq!(result.hits[0].snippet, "😀 NEEDLE needle");
    assert_eq!(
        result.hits[0]
            .ranges
            .iter()
            .map(|r| (r.from, r.to))
            .collect::<Vec<_>>(),
        vec![(3, 9), (10, 16)]
    );
    assert!(run(request(&f, "Needle")).hits.is_empty());
    assert_eq!(run(request(&f, "NEEDLE")).hits.len(), 1);
    assert_eq!(run(request(&f, "a.b")).hits[0].ranges.len(), 1);
    f.write("unicode.txt", "Äpfel äpfel\n");
    assert_eq!(run(request(&f, "äpfel")).hits[0].ranges.len(), 2);
}

#[test]
fn worktree_includes_tracked_and_untracked_but_ignores_ignored_files() {
    let f = TestRepo::new();
    f.write("tracked.txt", "before");
    f.write(".gitignore", "ignored/\n");
    f.commit("initial");
    f.write("tracked.txt", "needle");
    f.write("untracked.txt", "needle");
    f.write("ignored/secret.txt", "needle");
    let result = run(request(&f, "needle"));
    assert_eq!(
        result
            .hits
            .iter()
            .map(|h| h.path.as_str())
            .collect::<Vec<_>>(),
        vec!["tracked.txt", "untracked.txt"]
    );
}

#[test]
fn committed_search_reads_the_requested_tree_even_on_a_dirty_different_branch() {
    let f = TestRepo::new();
    f.write("code.txt", "old needle");
    let old = f.commit("old");
    f.write("code.txt", "new needle");
    f.write("added.txt", "new needle");
    let new = f.commit("new");
    f.repo
        .branch(
            "feature",
            &f.repo
                .find_commit(git2::Oid::from_str(&new).unwrap())
                .unwrap(),
            false,
        )
        .unwrap();
    f.repo
        .find_reference("refs/heads/master")
        .unwrap()
        .set_target(git2::Oid::from_str(&old).unwrap(), "test")
        .unwrap();
    f.write("code.txt", "dirty checkout");
    std::fs::remove_file(f.path().join("added.txt")).unwrap();
    let mut req = request(&f, "needle");
    req.source = ProjectSource::Commit { oid: new };
    let result = run(req);
    assert_eq!(
        result
            .hits
            .iter()
            .map(|h| (h.path.as_str(), h.snippet.as_str()))
            .collect::<Vec<_>>(),
        vec![("added.txt", "new needle"), ("code.txt", "new needle")]
    );
    assert_eq!(
        std::fs::read_to_string(f.path().join("code.txt")).unwrap(),
        "dirty checkout"
    );
    let mut req = request(&f, "needle");
    req.source = ProjectSource::Commit { oid: old };
    assert_eq!(run(req).hits[0].snippet, "old needle");
}

#[test]
fn changed_file_scope_is_an_intersection_and_empty_means_no_files() {
    let f = TestRepo::new();
    f.write("a.txt", "needle");
    f.write("b.txt", "needle");
    let mut req = request(&f, "needle");
    req.only = Some(vec![
        "a.txt".into(),
        "a.txt".into(),
        "../outside".into(),
        "/etc/passwd".into(),
    ]);
    assert_eq!(
        run(req)
            .hits
            .iter()
            .map(|h| h.path.as_str())
            .collect::<Vec<_>>(),
        vec!["a.txt"]
    );
    let mut req = request(&f, "needle");
    req.only = Some(vec![]);
    assert!(run(req).hits.is_empty());
}

#[test]
fn bounds_are_reported_and_exactly_a_thousand_hits_is_not_truncated() {
    let f = TestRepo::new();
    f.write("lines.txt", "needle\n".repeat(MAX_HITS));
    let result = run(request(&f, "needle"));
    assert_eq!(result.hits.len(), MAX_HITS);
    assert!(!result.truncated);
    f.write("lines.txt", "needle\n".repeat(MAX_HITS + 1));
    assert!(run(request(&f, "needle")).truncated);
    f.write(
        "lines.txt",
        format!("{}needle\nneedle", "x".repeat(MAX_LINE_BYTES)),
    );
    f.write("binary", b"needle\0");
    f.write("invalid", b"needle\xff");
    f.write("large", vec![b'x'; MAX_FILE_BYTES + 1]);
    let result = run(request(&f, "needle"));
    assert_eq!(result.hits.len(), 1);
    assert_eq!(result.hits[0].line, 2);
    assert_eq!(result.skipped_files, 3);
    assert_eq!(result.skipped_lines, 1);
}

#[cfg(unix)]
#[test]
fn symlinks_do_not_search_outside_the_repo_in_either_snapshot() {
    let f = TestRepo::new();
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("needle-secret");
    std::fs::write(&secret, "needle").unwrap();
    std::os::unix::fs::symlink(&secret, f.path().join("link")).unwrap();
    let oid = f.commit("symlink");
    assert!(run(request(&f, "needle")).hits.is_empty());
    let mut req = request(&f, "needle");
    req.source = ProjectSource::Commit { oid };
    let result = run(req);
    assert!(result.hits.is_empty());
    assert_eq!(result.skipped_files, 1);
}

#[test]
fn invalid_requests_fail_and_cancelled_searches_do_no_file_reads() {
    let f = TestRepo::new();
    assert!(search(request(&f, "two\nlines"), &AtomicBool::new(false)).is_err());
    let mut req = request(&f, "needle");
    req.source = ProjectSource::Commit { oid: "bad".into() };
    assert!(search(req, &AtomicBool::new(false)).is_err());
    let mut req = request(&f, "needle");
    req.repo = "/missing".into();
    assert!(search(req, &AtomicBool::new(true)).unwrap().cancelled);
    assert!(run(request(&f, "")).hits.is_empty());
}

#[test]
fn cancellation_handles_running_early_late_and_replaced_requests() {
    let registry = SearchRegistry::default();
    registry.cancel("early");
    let token = registry.begin("early");
    assert!(token.load(Ordering::Relaxed));
    registry.finish("early", &token);
    let token = registry.begin("running");
    assert!(!token.load(Ordering::Relaxed));
    registry.cancel("running");
    assert!(token.load(Ordering::Relaxed));
    let replacement = registry.begin("running");
    registry.finish("running", &token);
    registry.cancel("running");
    assert!(replacement.load(Ordering::Relaxed));
    registry.finish("running", &replacement);
    for i in 0..256 {
        registry.cancel(&i.to_string());
    }
    assert_eq!(registry.0.lock().unwrap().cancelled.len(), 128);
    assert!(registry.0.lock().unwrap().running.is_empty());
}
