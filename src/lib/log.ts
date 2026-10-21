import { useLogStore } from "../state/log";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
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

/** (Re)load the first page of the review branch's history and its review states. */
export async function loadLog(): Promise<void> {
  const repo = useRepoStore.getState().repoPath;
  if (!repo) return;
  const ref = logRef();
  const ticket = ++requestSeq;
  useLogStore.getState().begin(ref);
  try {
    const commits = await listCommits(repo, ref, 0, PAGE);
    if (ticket !== requestSeq) return;
    useLogStore.getState().setPage(ref, commits, commits.length < PAGE);
    void refreshCommitReviews(commits.map((c) => c.oid));
  } catch (e) {
    if (ticket === requestSeq) useLogStore.getState().fail(String(e));
  }
}

/** Load the next page of history, unless it is all here or a load is in flight. */
export async function loadMoreLog(): Promise<void> {
  const repo = useRepoStore.getState().repoPath;
  const { ref, commits, complete, loading } = useLogStore.getState();
  if (!repo || !ref || complete || loading) return;
  const ticket = ++requestSeq;
  useLogStore.getState().begin(ref);
  try {
    const page = await listCommits(repo, ref, commits.length, PAGE);
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
  const ui = useUIStore.getState();
  ui.setActiveBuffer("log");
  ui.requestFocus();
  void loadLog();
}
