import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore } from "../state/ui";
import { WORKTREE_SPEC, type DiffSpec } from "../types/diff";
import { branchShorthand, type ReviewBranch } from "../types/repo";
import { scopeForSpec } from "../types/tags";
import { ambientSource } from "./project";
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
    const ambient = ambientSource(diff.comparison);
    useProjectStore.getState().setSource(ambient.source, ambient.label);
    void buildSymbolIndex(path, ambient.source).catch(() => {});
  } catch (e) {
    if (ticket === requestSeq) {
      useRepoStore.getState().setStatus({ kind: "error", message: String(e) });
    }
    throw e;
  }
}

/**
 * Open a repository by path: load its info, adopt its review branch, apply the
 * working-tree comparison (a fresh open always starts there), switch to the diff
 * buffer, and focus it. Throws on failure (callers surface the error).
 */
export async function openRepoByPath(path: string): Promise<void> {
  const repoStore = useRepoStore.getState();
  const ui = useUIStore.getState();
  repoStore.setStatus({ kind: "loading" });
  const info = await openRepo(path);
  repoStore.setRepo(info, info.root);
  // The branch under review starts as whatever the checkout is on (else the repo's
  // default branch) — the backend already picked; we only need its display name.
  repoStore.setReviewBranch(
    info.reviewBranchRef
      ? { ref: info.reviewBranchRef, display: branchShorthand(info.reviewBranchRef) }
      : null,
  );
  await applyComparison(WORKTREE_SPEC);
  ui.setActiveBuffer("diff");
  ui.requestFocus();
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
  if (comparison.kind !== "branches") return;
  const spec: DiffSpec =
    comparison.baseRef === branch.ref
      ? WORKTREE_SPEC
      : { ...comparison, targetRef: branch.ref };
  await applyComparison(spec);
}

/** Recompute the comparison currently applied and reload its tags (`refresh`). */
export async function refreshDiff(): Promise<void> {
  const { repoPath, comparison } = useRepoStore.getState();
  if (!repoPath) return;
  // applyComparison already records the failure in the diff status.
  await applyComparison(comparison).catch(() => {});
}
