import { assert, beforeEach, calls, deferred, equal, mock, rejects, run, test, waitFor } from "./support";
import { branches, branchSpec, commit, commitSpec, OID, openFile, PARENT, repoFixture, resetState, summary, tag, tags } from "./fixtures";
import { applyComparison } from "../src/lib/open-repo";
import { loadDir, openPreview, previewFile, reconcileFileBuffers, visitFile } from "../src/lib/project";
import { useFilesStore } from "../src/state/files";
import { useHistoryStore } from "../src/state/history";
import { useProjectStore } from "../src/state/project";
import { useRepoStore } from "../src/state/repo";
import { useTagsStore } from "../src/state/tags";
import { useWindowStore } from "../src/state/windows";
import type { DiffSummary } from "../src/types/diff";
import type { TreeListing } from "../src/types/repo";
import type { TagStore } from "../src/types/tags";

beforeEach(() => {
  resetState(); repoFixture();
  mock("build_symbol_index", () => ({ files: 0, symbols: 0 }));
  mock("load_tags", () => tags());
  mock("read_file", () => "fresh content");
});
const rs = () => useRepoStore.getState();
const ps = () => useProjectStore.getState();

test("comparison and tags are applied together after both loads succeed", async () => {
  const pending = deferred<TagStore>(), old = rs().diff;
  mock("compute_diff", () => summary(commit())); mock("load_tags", () => pending.promise);
  const request = applyComparison(commitSpec());
  await waitFor(() => calls.some(c => c.command === "load_tags"));
  equal(rs().diff, old); equal(rs().status.kind, "loading");
  pending.resolve(tags({ flags: [tag()] })); await request;
  equal(rs().comparison, commitSpec()); equal(useTagsStore.getState().flags.length, 1);
  equal(ps().source, { kind: "commit", oid: OID }); equal(rs().status.kind, "idle");
});

test("failed tag loading leaves the prior comparison and marks intact", async () => {
  const old = rs().diff, marked = tag(); useTagsStore.getState().setStore(tags({ reviewed: [marked] }));
  mock("compute_diff", () => summary(commit())); mock("load_tags", () => { throw new Error("Cannot read tags"); });
  await rejects(() => applyComparison(commitSpec()), "Cannot read tags");
  equal(rs().diff, old); equal(rs().comparison, { kind: "worktree" });
  equal(useTagsStore.getState().reviewed, [marked]); equal(rs().status.kind, "error");
});

test("an older comparison response cannot replace a newer selection", async () => {
  const old = deferred<DiffSummary>(), nextOid = "c".repeat(40);
  mock("compute_diff", ({ spec }) => (spec as { oid: string }).oid === OID ? old.promise : summary(commit({ oid: nextOid })));
  const first = applyComparison(commitSpec());
  await applyComparison(commitSpec(nextOid));
  old.resolve(summary(commit())); await first;
  equal(rs().comparison, commitSpec(nextOid)); equal(ps().source, { kind: "commit", oid: nextOid });
});

test("an older failed request cannot put a newer comparison into error", async () => {
  const old = deferred<DiffSummary>();
  mock("compute_diff", () => old.promise);
  const first = applyComparison(commitSpec()).catch(error => String(error));
  mock("compute_diff", () => summary()); await applyComparison({ kind: "worktree" });
  old.reject(new Error("Old failure")); equal(await first, "Error: Old failure");
  equal(rs().status.kind, "idle");
});

test("changing repositories invalidates a pending comparison even at the same revision", async () => {
  const pending = deferred<DiffSummary>(); mock("compute_diff", () => pending.promise);
  const request = applyComparison(commitSpec());
  rs().setRepo({ ...rs().repo!, root: "/other" }, "/other");
  const current = summary(); current.repoRoot = "/other";
  rs().applyComparison({ kind: "worktree" }, current);
  pending.resolve(summary(commit())); await request;
  equal(rs().repoPath, "/other"); equal(rs().diff?.repoRoot, "/other");
  equal(rs().comparison, { kind: "worktree" });
});

test("closing a repository invalidates pending failures", async () => {
  const pending = deferred<DiffSummary>(); mock("compute_diff", () => pending.promise);
  const request = applyComparison(commitSpec()).catch(() => {});
  rs().closeRepo(); pending.reject(new Error("Late failure")); await request;
  equal(rs().repoPath, null); equal(rs().status.kind, "idle");
});

test("closing and reopening the same repository invalidates its previous requests", async () => {
  const pending = deferred<DiffSummary>(); mock("compute_diff", () => pending.promise);
  const request = applyComparison(commitSpec());
  rs().closeRepo(); repoFixture();
  pending.resolve(summary(commit())); await request;
  equal(rs().comparison, { kind: "worktree" }); equal(ps().source, { kind: "worktree" });
});

test("refresh keeps folds and jump history when the comparison and revision are unchanged", async () => {
  repoFixture(branchSpec, summary(branches())); ps().setSource({ kind: "commit", oid: OID }, "feature@bbbbbbb");
  rs().setFolds({ expandedFiles: new Set(["a.ts"]), collapsedHunks: new Set(["h1"]), collapsedSections: new Set(["reviewed"]) });
  useHistoryStore.getState().record({ kind: "diff", path: "a.ts", line: 2 });
  const epoch = rs().comparisonEpoch;
  mock("compute_diff", () => summary(branches())); await applyComparison(branchSpec);
  equal(rs().expandedFiles, new Set(["a.ts"])); equal(rs().collapsedHunks, new Set(["h1"]));
  equal(rs().collapsedSections, new Set(["reviewed"])); equal(rs().comparisonEpoch, epoch);
  equal(useHistoryStore.getState().back.length, 1);
});

test("changing comparisons resets folds, history and cached directory listings", async () => {
  rs().setExpanded(new Set(["a.ts"])); ps().setDir("", [{ path: "old", name: "old", isDir: false }]);
  ps().openFolders(["src"]); useHistoryStore.getState().record({ kind: "diff", path: "a.ts", line: 2 });
  mock("compute_diff", () => summary(commit())); await applyComparison(commitSpec());
  equal(rs().expandedFiles.size, 0); equal(useHistoryStore.getState().back, []); equal(ps().dirs, {});
  assert(ps().expanded.has("src"));
});

test("a moved branch refresh repoints open buffers and invalidates old jump history", async () => {
  repoFixture(branchSpec, summary(branches()));
  const buffer = openFile("a.ts", { kind: "commit", oid: OID });
  useWindowStore.getState().show(1, buffer.id);
  useHistoryStore.getState().record({ kind: "diff", path: "a.ts", line: 2 });
  const next = "c".repeat(40); mock("compute_diff", () => summary(branches(next)));
  await applyComparison(branchSpec);
  await waitFor(() => useFilesStore.getState().buffers[0]?.content === "fresh content");
  equal(useFilesStore.getState().buffers[0].id, buffer.id);
  equal(useFilesStore.getState().buffers[0].source, { kind: "commit", oid: next });
  equal(useHistoryStore.getState().back, []);
});

test("buffers outside a new comparison are killed while its old and new sides survive", () => {
  const old = openFile("gone.ts", { kind: "commit", oid: PARENT });
  const current = openFile("a.ts", { kind: "commit", oid: OID }); openFile("unrelated.ts", { kind: "worktree" });
  reconcileFileBuffers(undefined, commit(), false);
  equal(useFilesStore.getState().buffers.map(b => b.id), [old.id, current.id]);
});

test("directory results from a previous revision are discarded", async () => {
  const pending = deferred<TreeListing>(); mock("list_repo_dir", () => pending.promise);
  const request = loadDir(""); ps().setSource({ kind: "commit", oid: OID }, "commit");
  pending.resolve({ path: "", entries: [{ name: "old", path: "old", isDir: false }] }); await request;
  equal(ps().dirs, {});
});

test("directory results from a previous repository are discarded even with the same source", async () => {
  const pending = deferred<TreeListing>(); mock("list_repo_dir", () => pending.promise);
  const request = loadDir(""); rs().setRepo({ ...rs().repo!, root: "/other" }, "/other"); ps().reset();
  pending.resolve({ path: "", entries: [{ name: "old", path: "old", isDir: false }] }); await request;
  equal(ps().dirs, {});
});

test("a newer preview wins when reads finish out of order", async () => {
  const pending = deferred<string>(); mock("read_file", ({ path }) => path === "old.ts" ? pending.promise : "new content");
  const windows = useWindowStore.getState(); windows.show(1, "project"); windows.setTreeFocused(true);
  const first = previewFile("old.ts", { source: { kind: "worktree" }, label: null });
  await previewFile("new.ts", { source: { kind: "worktree" }, label: null });
  pending.resolve("old content"); await first;
  equal(useFilesStore.getState().preview?.path, "new.ts"); equal(useFilesStore.getState().buffers, []);
});

test("a preview finishing after its repository changed cannot appear in the new tree", async () => {
  const pending = deferred<string>(); mock("read_file", () => pending.promise);
  useWindowStore.getState().show(1, "project"); useWindowStore.getState().setTreeFocused(true);
  const request = previewFile("old.ts", { source: { kind: "worktree" }, label: null });
  rs().setRepo({ ...rs().repo!, root: "/other" }, "/other");
  pending.resolve("old content"); await request;
  equal(useFilesStore.getState().preview, null); equal(useWindowStore.getState().preview, null);
});

test("a preview finishing after the tree changed revision cannot appear over the new source", async () => {
  const pending = deferred<string>(); mock("read_file", () => pending.promise);
  useWindowStore.getState().show(1, "project"); useWindowStore.getState().setTreeFocused(true);
  const request = previewFile("old.ts", { source: { kind: "worktree" }, label: null });
  ps().setSource({ kind: "commit", oid: OID }, "commit");
  pending.resolve("old content"); await request;
  equal(useFilesStore.getState().preview, null);
});

test("opening a preview adopts its buffer without rereading or changing its identity", async () => {
  useWindowStore.getState().show(1, "project"); useWindowStore.getState().setTreeFocused(true);
  await previewFile("a.ts", { source: { kind: "worktree" }, label: null });
  const id = useFilesStore.getState().preview?.id; assert(id);
  equal(openPreview(1), true); equal(useFilesStore.getState().buffers[0].id, id);
  equal(useFilesStore.getState().preview, null); equal(useWindowStore.getState().shown[1], id);
  equal(calls.filter(c => c.command === "read_file").length, 1);
});

test("file reads cannot replace a buffer that was repointed to another revision", async () => {
  const pending = deferred<string>(); mock("read_file", () => pending.promise);
  visitFile("a.ts", { source: { kind: "worktree" }, label: null });
  const buffer = useFilesStore.getState().buffers[0];
  useFilesStore.getState().update(buffer.id, { source: { kind: "commit", oid: OID }, content: "new revision" });
  pending.resolve("old worktree");
  await new Promise(resolve => setTimeout(resolve, 0));
  equal(useFilesStore.getState().buffers[0].content, "new revision");
});

test("file read failures render an explanation in the file buffer", async () => {
  mock("read_file", () => { throw new Error("File not found"); });
  visitFile("missing.ts", { source: { kind: "worktree" }, label: null });
  await waitFor(() => useFilesStore.getState().buffers[0]?.content != null);
  assert(useFilesStore.getState().buffers[0].content?.includes("failed to read missing.ts"));
  assert(useFilesStore.getState().buffers[0].content?.includes("File not found"));
});

void run();
