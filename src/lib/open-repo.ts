import { useLogStore } from "../state/log";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore } from "../state/ui";
import { WORKTREE_SPEC, type DiffSpec } from "../types/diff";
import { branchShorthand, rangeBaseRef, type ReviewBranch } from "../types/repo";
import { scopeForSpec } from "../types/tags";
import { loadLog, refreshCommitReviews, showLog } from "./log";
import { ambientSource, useProjectSource } from "./project";
import { buildSymbolIndex, computeDiff, loadTags, openRepo } from "./tauri";

/**
 * Guards against an older comparison request landing after a newer one. Every
 * `applyComparison` call claims a ticket; only the newest may write to the stores.
 */
let requestSeq = 0;

/**
 * Compute `spec` and load its tags, then commit both to the stores at once. Nothing
 * is applied unless the whole load succeeds, so a failed comparison leaves the
 * previous one on screen (with the error in the diff status). Throws so callers —
 * the branch picker in particular — can surface the failure without closing.
 */
export async function applyComparison(spec: DiffSpec): Promise<void> {
  const repoStore = useRepoStore.getState();
  const path = repoStore.repoPath;
  if (!path) return;
  const ticket = ++requestSeq;
  repoStore.setStatus({ kind: "loading" });
  try {
    const diff = await computeDiff(path, spec);
    const tags = await loadTags(path, scopeForSpec(spec));
    if (ticket !== requestSeq) return; // a newer selection already won
    useRepoStore.getState().applyComparison(spec, diff);
    useTagsStore.getState().setStore(tags);
    // Project mode follows the comparison. Re-pointing it drops listings and the
    // open file when the revision changed — including when a branch has moved
    // under a plain refresh — and is a no-op when it hasn't.
    // Goes through `useProjectSource` so a changed revision also drops the jump
    // history, whose entries name files at the *old* revision.
    const ambient = ambientSource(diff.comparison);
    useProjectSource(ambient);
    void buildSymbolIndex(path, ambient.source).catch(() => {});
  } catch (e) {
    if (ticket === requestSeq) {
      useRepoStore.getState().setStatus({ kind: "error", message: String(e) });
    }
    throw e;
  }
}

/**
 * Open a repository by path: load its info, adopt its review branch, and apply the
 * working-tree comparison (a fresh open always starts there). Uncommitted changes open
 * in the diff buffer; a clean checkout has nothing to show there, so it opens on the
 * commits buffer instead. Throws on failure (callers surface the error).
 */
export async function openRepoByPath(path: string): Promise<void> {
  const repoStore = useRepoStore.getState();
  const ui = useUIStore.getState();
  repoStore.setStatus({ kind: "loading" });
  const info = await openRepo(path);
  repoStore.setRepo(info, info.root);
  // Even the same repo reopened gets a fresh history.
  useLogStore.getState().reset();
  // The branch under review starts as whatever the checkout is on (else the repo's
  // default branch) — the backend already picked; we only need its display name.
  repoStore.setReviewBranch(
    info.reviewBranchRef
      ? { ref: info.reviewBranchRef, display: branchShorthand(info.reviewBranchRef) }
      : null,
  );
  // ...and is held against the default branch until `M-x compare` picks another base.
  repoStore.setReviewBase(
    info.defaultBranchRef
      ? { ref: info.defaultBranchRef, display: branchShorthand(info.defaultBranchRef) }
      : null,
  );
  await applyComparison(WORKTREE_SPEC);
  const clean = (useRepoStore.getState().diff?.files.length ?? 0) === 0;
  // An unborn branch has no history to list either; its (empty) diff stays put.
  if (clean && info.head) {
    showLog();
    return;
  }
  ui.setActiveBuffer("diff");
  ui.requestFocus();
}

/**
 * Enter a commit from the commits buffer: review it against its first parent in the
 * diff buffer. Throws when the diff can't be computed, leaving the log where it was.
 */
export async function enterCommit(oid: string): Promise<void> {
  const branchRef = useRepoStore.getState().reviewBranch?.ref ?? null;
  await applyComparison({ kind: "commit", oid, branchRef });
  const ui = useUIStore.getState();
  ui.setActiveBuffer("diff");
  ui.requestFocus();
}

/**
 * Review everything the commits buffer lists as one diff (`b` in the log): the
 * `base...branch` comparison over the base the log is holding the branch against —
 * its upstream, when the branch is its own base. Throws when the diff can't be
 * computed, leaving the log where it was.
 */
export async function enterLogRange(): Promise<void> {
  const { ref, range } = useLogStore.getState();
  const baseRef = range ? rangeBaseRef(range) : null;
  if (!ref || !baseRef) return;
  await applyComparison({
    kind: "branches",
    baseRef,
    targetRef: ref,
    strategy: "mergeBase",
  });
  const ui = useUIStore.getState();
  ui.setActiveBuffer("diff");
  ui.requestFocus();
}

/**
 * Leave committed history under review (`q`) — a commit, or a branch's whole range —
 * for the commits buffer, which kept its cursor where it was. The diff buffer goes
 * back to meaning the current changes — and project mode and xref back to the
 * checkout — while a left commit's row picks up whatever was just marked.
 */
export function leaveHistory(): void {
  const { comparison } = useRepoStore.getState();
  if (comparison.kind === "worktree") return;
  const ui = useUIStore.getState();
  ui.setActiveBuffer("log");
  ui.requestFocus();
  // A comparison entered from `M-x show` or `M-x compare` may come before the log was ever
  // loaded.
  const log = useLogStore.getState();
  if (log.ref === null) void loadLog();
  else if (comparison.kind === "commit") void refreshCommitReviews([comparison.oid]);
  // applyComparison records any failure in the diff status.
  void applyComparison(WORKTREE_SPEC).catch(() => {});
}

/**
 * Hold the review branch against `base` from now on — the base `M-x compare` picked — so
 * the commits buffer lists what the branch introduced over the same base the branch
 * diff uses. The log follows, once it has been opened.
 */
export function chooseReviewBase(base: ReviewBranch): void {
  if (useRepoStore.getState().reviewBase?.ref === base.ref) return;
  useRepoStore.getState().setReviewBase(base);
  if (useLogStore.getState().ref !== null) void loadLog();
}

/**
 * Point the app at a different branch to review. A branch comparison re-targets so the
 * concept stays live — you see the new branch's work against the same base — unless
 * that would compare the base against itself, which is no comparison at all and falls
 * back to the working-tree diff. A commit comparison is left alone: a commit belongs to
 * no branch in particular.
 */
export async function switchReviewBranch(branch: ReviewBranch): Promise<void> {
  const { reviewBranch, comparison } = useRepoStore.getState();
  if (reviewBranch?.ref === branch.ref) return;
  useRepoStore.getState().setReviewBranch(branch);
  // The log lists the review branch, so it follows too — once it has been opened.
  if (useLogStore.getState().ref !== null) void loadLog();
  if (comparison.kind !== "branches") return;
  const spec: DiffSpec =
    comparison.baseRef === branch.ref
      ? WORKTREE_SPEC
      : { ...comparison, targetRef: branch.ref };
  await applyComparison(spec);
}

/**
 * Recompute the comparison currently applied and reload its tags (`refresh`), and
 * reload the commits buffer's history if it has been opened.
 */
export async function refreshDiff(): Promise<void> {
  const { repoPath, comparison } = useRepoStore.getState();
  if (!repoPath) return;
  if (useLogStore.getState().ref !== null) void loadLog();
  // applyComparison already records the failure in the diff status.
  await applyComparison(comparison).catch(() => {});
}
