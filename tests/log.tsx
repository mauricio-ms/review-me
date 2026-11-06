import { createRoot, type Root } from "react-dom/client";
import LogBuffer from "../src/components/LogBuffer";
import { loadLog, loadMoreLog, refreshCommitReviews, refreshLogCoverage } from "../src/lib/log";
import { reviewWholeFile } from "../src/lib/review-actions";
import { useLogStore } from "../src/state/log";
import { useRepoStore } from "../src/state/repo";
import { useWindowStore } from "../src/state/windows";
import type { CommitInfo, CommitLog, Coverage } from "../src/types/repo";
import { commit, commitSpec, file, OID, repoFixture, resetState, summary, tag, tags } from "./fixtures";
import { afterEach, assert, beforeEach, calls, deferred, equal, mock, run, test, waitFor } from "./support";

let root: Root | null = null;
let parent: HTMLDivElement | null = null;
const ls = () => useLogStore.getState();
const coverage = (patch: Partial<Coverage> = {}): Coverage => ({ total: 100, reviewed: 10, ignored: 0, flagged: 0, ...patch });
const commits: CommitInfo[] = Array.from({ length: 202 }, (_, i) => ({
  oid: i === 0 ? OID : i.toString(16).padStart(40, "0"), shortOid: String(i).padStart(7, "0"),
  summary: `Commit ${i}`, authorName: "Ada", timestamp: 1, parentCount: 1, isMerge: false, isHead: i === 0, refs: [],
}));
const page = (rows = commits.slice(0, 200)): CommitLog => ({ range: { kind: "all" }, commits: rows });

beforeEach(() => {
  resetState(); repoFixture();
  useRepoStore.getState().setReviewBranch({ ref: "refs/heads/main", display: "main" });
  mock("list_commits", ({ skip }) => page(skip === 0 ? commits.slice(0, 200) : commits.slice(200)));
  mock("commit_reviews", () => []);
  mock("log_coverage", () => coverage());
});
afterEach(() => {
  root?.unmount(); root = null; parent?.remove(); parent = null;
  resetState();
});

async function mount() {
  const windows = useWindowStore.getState(); windows.show(windows.selected, "log");
  parent = document.body.appendChild(document.createElement("div")); parent.className = "fixture";
  root = createRoot(parent); root.render(<LogBuffer />);
  await waitFor(() => document.querySelector(".log-review-progress"));
}
const progressText = () => document.querySelector(".log-review-progress")?.textContent ?? "";

test("progress covers the full range and does not change when another page loads", async () => {
  const pending = deferred<Coverage>(); mock("log_coverage", () => pending.promise);
  await loadLog(); equal(ls().commits.length, 200); equal(ls().coverage, null);
  assert(ls().coverageLoading);
  pending.resolve(coverage({ total: 205, reviewed: 1 }));
  await waitFor(() => ls().coverage?.total === 205);
  await loadMoreLog();
  equal(ls().commits.length, 202); assert(ls().complete);
  equal(ls().coverage, coverage({ total: 205, reviewed: 1 }));
  equal(calls.filter(c => c.command === "log_coverage").length, 1);
  equal(calls.find(c => c.command === "log_coverage")?.args, { repo: "/fixture", refName: "refs/heads/main", baseRef: null });
});

test("switching the base invalidates old aggregate and page replies", async () => {
  const oldCoverage = deferred<Coverage>(), oldPage = deferred<CommitLog>();
  mock("log_coverage", () => oldCoverage.promise); mock("list_commits", () => oldPage.promise);
  const first = loadLog();
  useRepoStore.getState().setReviewBase({ ref: "refs/heads/base", display: "base" }, true);
  mock("log_coverage", () => coverage({ total: 7, reviewed: 3 })); mock("list_commits", () => page([commits[1]]));
  await loadLog();
  oldCoverage.resolve(coverage({ total: 999 })); oldPage.resolve(page()); await first;
  equal(ls().coverage, coverage({ total: 7, reviewed: 3 })); equal(ls().commits, [commits[1]]);
  equal(calls.filter(c => c.command === "log_coverage")[1].args.baseRef, "refs/heads/base");
});

test("late failures cannot replace progress from a newer branch", async () => {
  const old = deferred<Coverage>(); mock("log_coverage", () => old.promise);
  await loadLog();
  useRepoStore.getState().setReviewBranch({ ref: "refs/heads/other", display: "other" });
  mock("log_coverage", () => coverage({ total: 2, reviewed: 2 })); await loadLog();
  old.reject(new Error("Old failure")); await new Promise(resolve => setTimeout(resolve, 0));
  equal(ls().coverage, coverage({ total: 2, reviewed: 2 })); equal(ls().coverageError, null);
});

test("closing and reopening the same repository invalidates pending progress", async () => {
  const old = deferred<Coverage>(); mock("log_coverage", () => old.promise);
  await loadLog(); resetState(); repoFixture();
  old.resolve(coverage()); await new Promise(resolve => setTimeout(resolve, 0));
  equal(ls().coverage, null); assert(!ls().coverageLoading);
});

test("the newest mark refresh wins when aggregate replies arrive out of order", async () => {
  await loadLog();
  const old = deferred<Coverage>(); mock("log_coverage", () => old.promise);
  const first = refreshCommitReviews([OID]);
  mock("log_coverage", () => coverage({ reviewed: 20 })); await refreshCommitReviews([OID]);
  old.resolve(coverage({ reviewed: 15 })); await first;
  equal(ls().coverage?.reviewed, 20);
});

test("summary shows change-weighted completion with ignored and flagged counts", async () => {
  mock("log_coverage", () => coverage({ total: 200, reviewed: 108, ignored: 20, flagged: 12 }));
  await loadLog(); await mount();
  await waitFor(() => progressText().includes("64%"));
  assert(progressText().includes("128/200 changes complete"));
  assert(progressText().includes("12 flagged")); assert(progressText().includes("20 ignored"));
  const bar = document.querySelector<HTMLProgressElement>("progress")!;
  equal(bar.max, 200); equal(bar.value, 128);
  // The summary stays outside the scroll container, pinned while rows scroll.
  const pinned = document.querySelector<HTMLElement>(".log-review-progress")!;
  const list = document.querySelector<HTMLElement>(".log-list")!;
  assert(!list.contains(pinned));
  const top = pinned.getBoundingClientRect().top;
  list.scrollTop = 500; assert(list.scrollTop > 0);
  equal(pinned.getBoundingClientRect().top, top);
});

test("empty ranges show no changes rather than an undefined percentage", async () => {
  mock("log_coverage", () => coverage({ total: 0, reviewed: 0 })); mock("list_commits", () => page([]));
  await loadLog(); await mount();
  await waitFor(() => progressText().includes("no changes to review"));
  assert(!document.querySelector("progress")); assert(!/NaN|Infinity|100%/.test(progressText()));
});

test("unfinished changes never round up to 100 percent", async () => {
  mock("log_coverage", () => coverage({ total: 200, reviewed: 199, flagged: 1 }));
  await loadLog(); await mount();
  await waitFor(() => progressText().includes("99%")); assert(!progressText().includes("100%"));
});

test("loading, calculation failure and retry remain visible without hiding commits", async () => {
  const pending = deferred<Coverage>(); mock("log_coverage", () => pending.promise);
  await loadLog(); await mount(); assert(progressText().includes("calculating"));
  pending.reject(new Error("Cannot read review marks"));
  await waitFor(() => progressText().includes("progress unavailable"));
  assert(document.querySelectorAll(".log-row").length === 200);
  equal(ls().coverage, null); equal(ls().coverageError, "Error: Cannot read review marks");
  mock("log_coverage", () => coverage()); await refreshLogCoverage();
  await waitFor(() => progressText().includes("10%")); equal(ls().coverageError, null);
});

test("reviewing a commit refreshes a visible log without leaving the diff", async () => {
  repoFixture(commitSpec(), summary(commit()));
  let current = coverage({ total: 1, reviewed: 0 });
  mock("log_coverage", () => current);
  mock("add_reviewed_tag", () => {
    current = coverage({ total: 1, reviewed: 1 });
    return tags({ reviewed: [tag({ scope: { kind: "commit", oid: OID } })] });
  });
  await loadLog(); await mount();
  await waitFor(() => progressText().includes("0%"));
  await reviewWholeFile(file());
  await waitFor(() => progressText().includes("100%"));
  assert(progressText().includes("1/1 changes complete"));
  equal(useRepoStore.getState().comparison, commitSpec());
});

void run();
