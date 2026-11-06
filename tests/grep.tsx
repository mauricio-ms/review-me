import { afterEach, assert, beforeEach, calls, deferred, equal, mock, run, test, waitFor } from "./support";
import { branches, branchSpec, commit, commitSpec, file, OID, openFile, repoFixture, resetState, summary } from "./fixtures";
import { createRoot, type Root } from "react-dom/client";
import AppShell from "../src/components/AppShell";
import { cancelGrep, editGrep, finishGrep, openGrep, runGrep, setGrepScope, visitGrepHit } from "../src/lib/grep";
import { goBack } from "../src/lib/history";
import { contextScope } from "../src/lib/key-dispatch";
import { activeView, positionOf } from "../src/lib/project-view";
import { useFilesStore } from "../src/state/files";
import { useGrepStore } from "../src/state/grep";
import { useMinibufferStore } from "../src/state/minibuffer";
import { useRepoStore } from "../src/state/repo";
import { selectedBuffer, useWindowStore, windowOrder } from "../src/state/windows";
import type { SearchHit, SearchResults } from "../src/types/grep";

let root: Root | null = null;
let parent: HTMLDivElement | null = null;
const gs = () => useGrepStore.getState();
const ws = () => useWindowStore.getState();
const hit = (patch: Partial<SearchHit> = {}): SearchHit => ({ path: "src/a.txt", line: 2, col: 3,
  snippet: "😀 needle needle", ranges: [{ from: 3, to: 9 }, { from: 10, to: 16 }], ...patch });
const found = (hits = [hit()], patch: Partial<SearchResults> = {}): SearchResults => ({
  hits, truncated: false, skippedFiles: 0, skippedLines: 0, cancelled: false, ...patch,
});
const searchCalls = () => calls.filter((c) => c.command === "search_repo");

beforeEach(() => {
  resetState(); repoFixture();
  mock("cancel_repo_search", () => {});
  mock("search_repo", () => found());
  mock("read_file", () => "first\n😀 needle needle\nthird needle");
  mock("symbol_occurrences", () => null);
});
afterEach(() => {
  root?.unmount(); root = null; parent?.remove(); parent = null;
  resetState();
});
async function mount() {
  parent = document.body.appendChild(document.createElement("div")); parent.className = "fixture";
  root = createRoot(parent); root.render(<AppShell />);
  await waitFor(() => document.querySelector(".app-shell"));
}
function key(key: string, mods: KeyboardEventInit = {}, target: Element | null = document.activeElement) {
  assert(target);
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }));
}
async function prompt() {
  await waitFor(() => document.activeElement?.id === "grep-input");
  return document.querySelector<HTMLInputElement>("#grep-input")!;
}
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("the global shortcut opens live literal search and keeps input focus while previewing", async () => {
  repoFixture(branchSpec, summary(branches()));
  await mount();
  key("x", { ctrlKey: true }); key("p"); key("g");
  const input = await prompt();
  type(input, "needle");
  await waitFor(() => gs().status === "ready" && document.querySelector(".grep-row"));
  equal(searchCalls().length, 1);
  equal(searchCalls()[0].args.request, { repo: "/fixture", source: { kind: "commit", oid: OID }, query: "needle", only: null });
  await waitFor(() => document.querySelector(".grep-row mark")?.textContent === "needle");
  equal(document.querySelectorAll(".grep-row mark").length, 2);
  equal(document.querySelectorAll(".grep-file").length, 1);
  assert(document.querySelector(".grep-revision")?.textContent?.includes(`feature@${OID.slice(0, 7)}`));
  await waitFor(() => useFilesStore.getState().buffers[0]?.content != null);
  const buffer = useFilesStore.getState().buffers[0];
  equal(buffer.source, { kind: "commit", oid: OID });
  equal(positionOf(2, buffer.id)?.line, 2); equal(positionOf(2, buffer.id)?.col, 3);
  equal(ws().selected, 1); equal(ws().shown[1], "grep");
  assert(document.activeElement === input, "Preview must keep focus in the input");
  equal(windowOrder(ws().layout).length, 2);
  key("Escape", {}, input);
  await waitFor(() => document.activeElement?.classList.contains("grep-buffer"));
});

test("match keys preview beside the results, Enter opens, and jump-back restores selection", async () => {
  mock("search_repo", () => found([hit(), hit({ path: "src/b.txt", line: 3, col: 6, snippet: "third needle", ranges: [{ from: 6, to: 12 }] })]));
  await mount(); openGrep(); const input = await prompt(); type(input, "needle");
  await waitFor(() => gs().status === "ready");
  key("n", { ctrlKey: true }, input);
  await waitFor(() => gs().selected === 1 && useFilesStore.getState().buffers.some((b) => b.path === "src/b.txt"));
  equal(ws().selected, 1); assert(document.activeElement === input, "Moving a match must keep input focus");
  key("p", { ctrlKey: true }, input); await waitFor(() => gs().selected === 0);
  key("n", { ctrlKey: true }, input); key("Enter", {}, input);
  await waitFor(() => ws().selected === 2 && activeView()?.hasFocus);
  const buffer = useFilesStore.getState().buffers.find((b) => b.path === "src/b.txt")!;
  equal(activeView()?.state.doc.lineAt(activeView()!.state.selection.main.head).number, 3);
  equal(positionOf(2, buffer.id)?.col, 6);
  goBack();
  await waitFor(() => document.activeElement?.classList.contains("grep-buffer"));
  equal(gs().selected, 1); equal(selectedBuffer(ws()), "grep"); equal(contextScope(), "grep");
  key("k"); await waitFor(() => gs().selected === 0);
  key("G"); await waitFor(() => gs().selected === 1);
  equal(document.querySelectorAll(".grep-row.is-selected").length, 1);
});

test("C-x b keeps the grep buffer and matches accessible after opening a file", async () => {
  await mount(); openGrep(); const input = await prompt(); type(input, "needle");
  await waitFor(() => gs().status === "ready"); key("Enter", {}, input);
  await waitFor(() => activeView()?.hasFocus, "Enter must focus the result file");
  key("x", { ctrlKey: true }); key("b");
  await waitFor(() => document.activeElement?.id === "minibuffer-input", "C-x b must focus the buffer prompt");
  type(document.querySelector<HTMLInputElement>("#minibuffer-input")!, "grep");
  await waitFor(() => document.querySelector(".mb-row.is-selected .mb-name")?.textContent === "grep", "Buffer prompt must select grep");
  key("Enter");
  await waitFor(() => selectedBuffer(ws()) === "grep", "Accepting grep must return to its window");
  equal(gs().results?.hits.length, 1); equal(gs().query, "needle");
  equal(document.querySelectorAll(".grep-row").length, 1);
});

test("changed-file scope searches only surviving new paths at the comparison's revision", async () => {
  repoFixture(commitSpec(), summary(commit(), [file({ path: "renamed.txt", oldPath: "old.txt", status: "renamed" }), file({ path: "deleted.txt", status: "deleted" })]));
  openGrep(); editGrep("needle"); setGrepScope("changed"); await runGrep();
  equal(searchCalls()[0].args.request, { repo: "/fixture", source: { kind: "commit", oid: OID }, query: "needle", only: ["renamed.txt"] });
  useRepoStore.getState().applyComparison(commitSpec(), summary(commit(), []));
  await runGrep();
  equal((searchCalls()[1].args.request as { only: unknown }).only, []);
  setGrepScope("repository"); await runGrep();
  equal((searchCalls()[2].args.request as { only: unknown }).only, null);
});

test("new query edits cancel backend work and reject late successes and failures", async () => {
  const old = deferred<SearchResults>(); mock("search_repo", () => old.promise);
  openGrep(); editGrep("old"); const first = runGrep();
  const oldId = searchCalls()[0].args.searchId;
  mock("search_repo", () => found([hit({ snippet: "new" })]));
  editGrep("new"); await runGrep();
  assert(calls.some((c) => c.command === "cancel_repo_search" && c.args.searchId === oldId));
  old.resolve(found([hit({ snippet: "old" })])); await first;
  equal(gs().results?.hits[0].snippet, "new");
  const failure = deferred<SearchResults>(); mock("search_repo", () => failure.promise);
  editGrep("failing"); const second = runGrep();
  mock("search_repo", () => found([])); editGrep("latest"); await runGrep();
  failure.reject(new Error("obsolete failure")); await second;
  equal(gs().status, "ready"); equal(gs().error, null); equal(gs().results?.hits, []);
});

test("C-g stops a pending search, clears its prompt, and ignores the cancelled reply", async () => {
  const pending = deferred<SearchResults>(); mock("search_repo", () => pending.promise);
  await mount(); openGrep(); const input = await prompt(); type(input, "needle");
  await waitFor(() => searchCalls().length === 1);
  key("g", { ctrlKey: true }, input);
  await waitFor(() => useMinibufferStore.getState().request === null);
  equal(gs().status, "cancelled");
  assert(calls.some((c) => c.command === "cancel_repo_search"));
  pending.resolve(found());
  await waitFor(() => document.querySelector(".grep-summary")?.textContent?.includes("cancelled"));
  equal(gs().results, null);
});

test("repository and revision changes invalidate search context and pending replies", async () => {
  const pending = deferred<SearchResults>(); mock("search_repo", () => pending.promise);
  openGrep(); editGrep("needle"); const first = runGrep();
  repoFixture(branchSpec, summary(branches()));
  equal(gs().context, null); equal(useMinibufferStore.getState().request, null);
  pending.resolve(found()); await first; equal(gs().results, null);
  openGrep(); editGrep("branch"); mock("search_repo", () => found()); await runGrep();
  assert(gs().results);
  useRepoStore.getState().applyComparison(branchSpec, summary(branches("c".repeat(40))));
  equal(gs().context, null); equal(gs().results, null);
  const late = deferred<SearchResults>(); mock("search_repo", () => late.promise);
  openGrep(); editGrep("late"); const last = runGrep();
  useRepoStore.getState().closeRepo(); repoFixture();
  late.reject(new Error("closed repository")); await last;
  equal(gs().context, null); equal(gs().error, null);
});

test("M-n uses the symbol at the cursor but search still uses the reviewed target revision", async () => {
  repoFixture(commitSpec(), summary(commit()));
  const origin = openFile("old.txt", { kind: "commit", oid: "a".repeat(40) });
  useFilesStore.getState().update(origin.id, { content: "validateOrder(order)" });
  ws().show(1, origin.id);
  await mount();
  await waitFor(() => activeView()?.state.doc.toString() === "validateOrder(order)");
  openGrep(); const input = await prompt(); key("n", { altKey: true }, input);
  await waitFor(() => searchCalls().length === 1);
  equal(gs().query, "validateOrder");
  equal((searchCalls()[0].args.request as { source: unknown }).source, { kind: "commit", oid: OID });
});

test("errors, empty results and truncation are visible and retry preserves the query", async () => {
  mock("search_repo", () => { throw new Error("cannot read repository"); });
  await mount(); openGrep(); await prompt(); editGrep("needle"); await runGrep();
  await waitFor(() => document.querySelector(".grep-summary")?.textContent?.includes("cannot read repository"));
  finishGrep(); await waitFor(() => document.activeElement?.classList.contains("grep-buffer"));
  mock("search_repo", () => found([])); key("r");
  await waitFor(() => document.querySelector(".grep-summary")?.textContent?.includes("0 matching lines"));
  equal(gs().query, "needle");
  mock("search_repo", () => found([hit()], { truncated: true, skippedFiles: 2, skippedLines: 3 })); key("r");
  await waitFor(() => document.querySelector(".grep-summary")?.textContent?.includes("results limited"));
  const text = document.querySelector(".grep-summary")!.textContent!;
  assert(text.includes("2 files skipped")); assert(text.includes("3 lines over 16 KiB skipped"));
});

test("clicking a result from the file window keeps grep visible and opens the chosen file", async () => {
  await mount(); openGrep(); await prompt(); editGrep("needle"); await runGrep(); finishGrep();
  await waitFor(() => document.querySelector(".grep-row"));
  visitGrepHit(0, true); await waitFor(() => activeView()?.hasFocus);
  document.querySelector<HTMLElement>(".grep-row")!.click();
  equal(ws().shown[1], "grep"); equal(ws().selected, 2);
});

test("clearing input cancels the old query without launching an empty repository scan", async () => {
  const pending = deferred<SearchResults>(); mock("search_repo", () => pending.promise);
  openGrep(); editGrep("needle"); const first = runGrep();
  editGrep(""); equal(gs().status, "idle"); equal(gs().results, null);
  pending.resolve(found()); await first;
  equal(gs().results, null); equal(searchCalls().length, 1);
  cancelGrep();
});

void run();
