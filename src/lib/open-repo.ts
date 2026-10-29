import { useFilesStore } from "../state/files";
import { useHistoryStore } from "../state/history";
import { useLogStore } from "../state/log";
import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useWindowStore } from "../state/windows";
import { sameSpec, WORKTREE_SPEC, type DiffSpec } from "../types/diff";
import {
  branchShorthand,
  rangeBaseRef,
  sameSource,
  type ReviewBranch,
} from "../types/repo";
import { scopeForSpec } from "../types/tags";
import { showBuffer, showDiff, type ShowOptions } from "./buffers";
import { loadLog, refreshCommitReviews, showLog } from "./log";
import { ambientSource, reconcileFileBuffers, useProjectSource } from "./project";
import { buildSymbolIndex, computeDiff, loadTags, openRepo, reviewBaseFor } from "./tauri";

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
    const before = useRepoStore.getState();
    const prev = before.diff?.comparison;
    const same = sameSpec(before.comparison, spec);
    useRepoStore.getState().applyComparison(spec, diff);
    useTagsStore.getState().setStore(tags);
    // `M-x hunk`'s per-change exceptions name the changes of the comparison they were
    // made in.
    if (!same) useProjectStore.getState().clearFlipped();
    // The tree and the finder follow the comparison. Re-pointing them drops listings
    // when the revision changed — including when a branch has moved under a plain
    // refresh — and is a no-op when it hasn't.
    const ambient = ambientSource(diff.comparison);
    // History starts fresh with a new comparison (or its revision moving): its places —
    // diff rows, files at the old revision — mean nothing in this one.
    if (!same || !prev || !sameSource(ambientSource(prev).source, ambient.source)) {
      useHistoryStore.getState().clear();
    }
    useProjectSource(ambient);
    // Open files follow it too: re-read, re-pointed, or — a review that's over — killed.
    reconcileFileBuffers(prev, diff.comparison, same);
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
  repoStore.setStatus({ kind: "loading" });
  const info = await openRepo(path);
  repoStore.setRepo(info, info.root);
  // Even the same repo reopened gets a fresh history — and no files open, one window.
  useLogStore.getState().reset();
  useFilesStore.getState().reset();
  useWindowStore.getState().reset();
  useHistoryStore.getState().clear();
  // The branch under review starts as whatever the checkout is on (else the repo's
  // default branch) — the backend already picked; we only need its display name.
  repoStore.setReviewBranch(
    info.reviewBranchRef
      ? { ref: info.reviewBranchRef, display: branchShorthand(info.reviewBranchRef) }
      : null,
  );
  // ...and is held against the branch it tracks (else the default branch) until
  // `M-x compare` picks another base.
  repoStore.setReviewBase(asReviewBranch(info.reviewBaseRef), false);
  await applyComparison(WORKTREE_SPEC);
  const clean = (useRepoStore.getState().diff?.files.length ?? 0) === 0;
  // An unborn branch has no history to list either; its (empty) diff stays put.
  if (clean && info.head) {
    showLog();
    return;
  }
  showBuffer("diff");
}

/**
 * Enter a commit from the commits buffer: review it against its first parent in the
 * diff buffer — here, or in the other window (`o`). Throws when the diff can't be
 * computed, leaving the log where it was.
 */
export async function enterCommit(oid: string, options: ShowOptions = {}): Promise<void> {
  const branchRef = useRepoStore.getState().reviewBranch?.ref ?? null;
  await applyComparison({ kind: "commit", oid, branchRef });
  showDiff(options);
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
  showDiff();
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
  showBuffer("log");
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
  const moved = useRepoStore.getState().reviewBase?.ref !== base.ref;
  useRepoStore.getState().setReviewBase(base, true);
  if (moved && useLogStore.getState().ref !== null) void loadLog();
}

/**
 * Point the app at a different branch to review. Its base comes along: the branch it
 * tracks, unless `M-x compare` picked one, which stays. A branch comparison re-targets
 * so the concept stays live — you see the new branch's work against its base — unless
 * that would compare the base against itself, which is no comparison at all and falls
 * back to the working-tree diff. A commit comparison is left alone: a commit belongs to
 * no branch in particular.
 */
export async function switchReviewBranch(branch: ReviewBranch): Promise<void> {
  const { repoPath, reviewBranch, reviewBase, reviewBaseChosen, comparison } =
    useRepoStore.getState();
  if (!repoPath || reviewBranch?.ref === branch.ref) return;
  const base = reviewBaseChosen
    ? reviewBase
    : asReviewBranch(await reviewBaseFor(repoPath, branch.ref));
  useRepoStore.getState().setReviewBranch(branch);
  useRepoStore.getState().setReviewBase(base, reviewBaseChosen);
  // The log lists the review branch, so it follows too — once it has been opened.
  if (useLogStore.getState().ref !== null) void loadLog();
  if (comparison.kind !== "branches") return;
  // Held against the old branch's base, the comparison moves to the new one's.
  const baseRef =
    base && comparison.baseRef === reviewBase?.ref ? base.ref : comparison.baseRef;
  const spec: DiffSpec =
    baseRef === branch.ref
      ? WORKTREE_SPEC
      : { ...comparison, baseRef, targetRef: branch.ref };
  await applyComparison(spec);
}

function asReviewBranch(ref: string | null): ReviewBranch | null {
  return ref ? { ref, display: branchShorthand(ref) } : null;
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
