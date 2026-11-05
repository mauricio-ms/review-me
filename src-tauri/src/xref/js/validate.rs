//! End-to-end validation of the JavaScript and TypeScript resolver against real
//! projects, pinned to the commits it was measured on — the evidence that it works
//! beyond the fixtures in `tests.rs`, and the guard against it getting worse:
//!
//!     ./scripts/make-frontend-samples.sh                     # fetch them (gitignored)
//!     cargo test --lib xref::js::validate -- --ignored --nocapture
//!
//! Each sample's imports must resolve as well as they did — the ones left are files
//! the revision doesn't have (generated, a submodule) — and no more of its names may
//! come out undecided than did. Ignored by default: it parses tens of thousands of
//! files. Once requested, every sample is required and empty samples fail validation.

use std::path::Path;

use git2::Repository;

use super::*;
use crate::xref::TEST_LOCK;

struct Sample {
    name: &'static str,
    /// Imports nothing in the revision accounts for, at most.
    unresolved_imports: u32,
    /// Names resolution leaves undecided, at most, as a percentage; `None` skips counting
    /// (a repo too big to resolve every name of in a test).
    undecided_names: Option<f64>,
}

const SAMPLES: &[Sample] = &[
    // One import of a playground template's App.vue, which isn't committed.
    Sample { name: "vue-core", unresolved_imports: 1, undecided_names: Some(8.0) },
    Sample { name: "next-commerce", unresolved_imports: 0, undecided_names: Some(11.0) },
    // The registry's built styles and the CLI-generated components, all gitignored.
    Sample { name: "shadcn-ui", unresolved_imports: 5400, undecided_names: None },
    // Plain JavaScript: SvelteKit's untyped `{ locals, url }` and the like stay undecided.
    Sample { name: "sveltekit-realworld", unresolved_imports: 0, undecided_names: Some(22.0) },
    // A playwright spec from a git submodule.
    Sample { name: "angular-realworld", unresolved_imports: 1, undecided_names: Some(2.5) },
    Sample { name: "nuxt-movies", unresolved_imports: 0, undecided_names: Some(5.0) },
    Sample { name: "vitesse", unresolved_imports: 0, undecided_names: Some(6.0) },
    Sample { name: "starlight", unresolved_imports: 0, undecided_names: Some(10.0) },
    // CommonJS with untyped requests and responses.
    Sample { name: "express", unresolved_imports: 0, undecided_names: Some(21.0) },
    Sample { name: "bootstrap", unresolved_imports: 0, undecided_names: Some(17.0) },
];

/// Every name in the index resolved: found, ambiguous, external, undecided.
pub(super) fn tally_names(index: &JsIndex) -> [u32; 4] {
    let mut tally = [0u32; 4];
    for fi in 0..index.files.len() {
        let Some(parsed) = index.parsed(fi) else { continue };
        let code = index.code(fi);
        walk(parsed.tree.root_node(), &mut |n| {
            if !NAME_KINDS.contains(&n.kind()) || is_declaration_name(n) || text(n, code).is_empty() {
                return;
            }
            let slot = match index.resolve(fi, n) {
                Resolution::Found(_) => 0,
                Resolution::Ambiguous(_) => 1,
                Resolution::External => 2,
                Resolution::Unresolved => 3,
            };
            tally[slot] += 1;
        });
    }
    tally
}

#[test]
#[ignore = "requires ./scripts/make-frontend-samples.sh"]
fn validate() {
    let samples = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("sample-frontend");
    validate_samples(&samples).unwrap();
}

fn validate_samples(samples: &Path) -> Result<(), String> {
    // Check the whole fixture set before doing any expensive resolver work.
    let repos = SAMPLES.iter().map(|sample| {
        crate::test_support::required_sample(&samples.join(sample.name), "./scripts/make-frontend-samples.sh")
            .map(|repo| (sample, repo))
    }).collect::<Result<Vec<_>, _>>()?;
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut failures = Vec::new();
    for (sample, repo) in repos {
        let root = crate::repo::root(&repo).map_err(|e| e.to_string())?;
        let files = crate::fuzzy::repo_files(&repo, &ProjectSource::Worktree).map_err(|e| e.to_string())?;
        let index = JsIndex::build(&repo, &root, &ProjectSource::Worktree, &files).map_err(|e| e.to_string())?;
        let audit = audit_index(&index);
        if audit.files == 0 || audit.imports == 0 {
            return Err(format!("{} contains no source files or imports; rebuild the sample fixtures", sample.name));
        }
        let unresolved = audit.unresolved.len() as u32;
        let mut line = format!(
            "{:20} {:5} files {:6} imports: {:5} unresolved (≤ {})",
            sample.name, audit.files, audit.imports, unresolved, sample.unresolved_imports
        );
        if unresolved > sample.unresolved_imports {
            failures.push(format!("{}: {unresolved} unresolved imports, {:?}", sample.name, &audit.patterns[..audit.patterns.len().min(5)]));
        }
        if let Some(max) = sample.undecided_names {
            let [found, ambiguous, external, undecided] = tally_names(&index);
            let total = (found + ambiguous + external + undecided).max(1);
            let pct = 100.0 * undecided as f64 / total as f64;
            line.push_str(&format!(" | {total:6} names: {pct:4.1}% undecided (≤ {max})"));
            if pct > max {
                failures.push(format!("{}: {pct:.1}% of names undecided", sample.name));
            }
        }
        eprintln!("{line}");
    }
    if failures.is_empty() { Ok(()) } else { Err(format!("resolution got worse:\n{}", failures.join("\n"))) }
}

#[test]
fn missing_samples_fail_instead_of_reporting_success() {
    let dir = tempfile::tempdir().unwrap();
    let error = validate_samples(dir.path()).unwrap_err();
    assert!(error.contains("required sample"));
    assert!(error.contains("make-frontend-samples.sh"));
}

#[test]
fn empty_sample_repositories_fail_instead_of_reporting_zero_unresolved_imports() {
    let dir = tempfile::tempdir().unwrap();
    for sample in SAMPLES { Repository::init(dir.path().join(sample.name)).unwrap(); }
    assert!(validate_samples(dir.path()).unwrap_err().contains("no source files or imports"));
}
