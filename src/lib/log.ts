import { useLogStore } from "../state/log";
import { useRepoStore } from "../state/repo";
import { showBuffer } from "./buffers";
import { commitReviews, listCommits } from "./tauri";

/**
 * Commits per page. Deep enough that most reviews never page; the next one loads as
 * the cursor nears the end, so a long history is never a fixed window.
 */
const PAGE = 200;

/** Guards against an older page landing after a newer load of the log. */
let requestSeq = 0;

/** The history the log lists: the branch under review, else whatever HEAD is on. */
export function logRef(): string {
  return useRepoStore.getState().reviewBranch?.ref ?? "HEAD";
}

/**
 * What the log holds `logRef()` against, so it lists only the commits the branch
 * introduced. The backend falls back to the branch's unpushed commits when this names
 * the branch itself, and to its whole history when there is nothing to hold it against.
 */
export function logBase(): string | null {
  return useRepoStore.getState().reviewBase?.ref ?? null;
}

/** (Re)load the first page of the review branch's commits and their review states. */
export async function loadLog(): Promise<void> {
  const repo = useRepoStore.getState().repoPath;
  if (!repo) return;
  const ref = logRef();
  const base = logBase();
  const ticket = ++requestSeq;
  useLogStore.getState().begin(ref, base);
  try {
    const { range, commits } = await listCommits(repo, ref, base, 0, PAGE);
    if (ticket !== requestSeq) return;
    useLogStore.getState().setPage(ref, base, range, commits, commits.length < PAGE);
    void refreshCommitReviews(commits.map((c) => c.oid));
  } catch (e) {
    if (ticket === requestSeq) useLogStore.getState().fail(String(e));
  }
}

/** Load the next page of history, unless it is all here or a load is in flight. */
export async function loadMoreLog(): Promise<void> {
  const repo = useRepoStore.getState().repoPath;
  const { ref, base, commits, complete, loading } = useLogStore.getState();
  if (!repo || !ref || complete || loading) return;
  const ticket = ++requestSeq;
  useLogStore.getState().begin(ref, base);
  try {
    const { commits: page } = await listCommits(repo, ref, base, commits.length, PAGE);
    if (ticket !== requestSeq) return;
    // The branch can move between pages; never list a commit twice.
    const seen = new Set(useLogStore.getState().commits.map((c) => c.oid));
    const fresh = page.filter((c) => !seen.has(c.oid));
    useLogStore.getState().appendPage(fresh, page.length < PAGE);
    void refreshCommitReviews(fresh.map((c) => c.oid));
  } catch (e) {
    if (ticket === requestSeq) useLogStore.getState().fail(String(e));
  }
}

/** Re-read the review progress of `oids` (e.g. the commit just left). */
export async function refreshCommitReviews(oids: string[]): Promise<void> {
  const repo = useRepoStore.getState().repoPath;
  if (!repo || oids.length === 0) return;
  try {
    const reviews = await commitReviews(repo, oids);
    // A different repo opened meanwhile: these oids mean nothing there.
    if (useRepoStore.getState().repoPath !== repo) return;
    useLogStore.getState().setReviews(oids, reviews);
  } catch {
    // Progress is decoration; a failure leaves the rows as they were.
  }
}

/**
 * Show the commits buffer. The history is reloaded every time — the branch may have
 * moved since (an agent committing in the background) — and the buffer keeps its
 * cursor on the same commit across the reload.
 */
export function showLog(): void {
  showBuffer("log");
  void loadLog();
}
