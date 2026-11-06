import { afterEach, assert, beforeEach, calls, deferred, equal, mock, run, test, waitFor } from "./support";
import { branches, branchSpec, commit, commitSpec, file, OID, openFile, repoFixture, resetState, summary } from "./fixtures";
import { createRoot, type Root } from "react-dom/client";
import AppShell from "../src/components/AppShell";
import { showDiff } from "../src/lib/buffers";
import { cancelGrep, editGrep, openGrep, runGrep, setGrepScope } from "../src/lib/grep";
import { goBack } from "../src/lib/history";
import { activeView, positionOf } from "../src/lib/project-view";
import { useFilesStore } from "../src/state/files";
import { useGrepStore } from "../src/state/grep";
import { useHistoryStore } from "../src/state/history";
import { useMinibufferStore } from "../src/state/minibuffer";
import { useProjectStore } from "../src/state/project";
import { useRepoStore } from "../src/state/repo";
import { inProjectMode, selectedBuffer, useWindowStore, windowOrder } from "../src/state/windows";
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
const fileReads = () => calls.filter((c) => c.command === "read_file");
const windowSnapshot = () => {
  const { layout, shown, selected, treeFocused, prev, ahead, recent } = ws();
  return structuredClone({ layout, shown, selected, treeFocused, prev, ahead, recent });
};

beforeEach(() => {
  resetState(); repoFixture();
  mock("cancel_repo_search", () => {});
  mock("search_repo", () => found());
  mock("read_file", () => "first\n😀 needle needle\nthird needle");
  mock("read_preview", () => "first\n😀 needle needle\nthird needle");
  mock("symbol_occurrences", () => null);
  mock("list_repo_dir", ({ path }) => ({ path, entries: path === "" ? [
    { name: "src", path: "src", isDir: true },
    { name: "origin.txt", path: "origin.txt", isDir: false },
  ] : path === "src" ? [
    { name: "a.txt", path: "src/a.txt", isDir: false },
    { name: "b.txt", path: "src/b.txt", isDir: false },
    { name: "services", path: "src/services", isDir: true },
  ] : path === "src/services" ? [
    { name: "unused.txt", path: "src/services/unused.txt", isDir: false },
    { name: "changed.txt", path: "src/services/changed.txt", isDir: false },
  ] : [] }));
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
async function search() {
  openGrep();
  const input = await prompt();
  type(input, "needle");
  await waitFor(() => gs().status === "ready" && document.querySelector(".grep-row"));
  return input;
}
const matches = [hit(), hit({ path: "src/b.txt", line: 3, col: 6, snippet: "third needle", ranges: [{ from: 6, to: 12 }] })];

test("the global shortcut opens a full-width picker below the current buffer with inline match rows", async () => {
  repoFixture(branchSpec, summary(branches()));
  await mount();
  const before = windowSnapshot();
  key("x", { ctrlKey: true }); key("p"); key("g");
  const input = await prompt(); type(input, "needle");
  await waitFor(() => gs().status === "ready" && document.querySelector(".grep-row"));
  equal(searchCalls().length, 1);
  equal(searchCalls()[0].args.request, { repo: "/fixture", source: { kind: "commit", oid: OID }, query: "needle", only: null });
  equal(document.querySelectorAll(".grep-row mark").length, 2);
  assert(document.querySelector(".grep-row")?.textContent?.includes("src/a.txt:2:"));
  assert(document.querySelector(".grep-row")?.textContent?.includes("😀 needle needle"));
  assert(document.querySelector(".grep-revision")?.textContent?.includes("feature@" + OID.slice(0, 7)));
  const picker = document.querySelector(".grep-picker")!.getBoundingClientRect();
  const body = document.querySelector(".app-body")!.getBoundingClientRect();
  const modeLine = document.querySelector(".status-bar")!.getBoundingClientRect();
  const shell = document.querySelector(".app-shell")!.getBoundingClientRect();
  equal(picker.left, shell.left); equal(picker.right, shell.right);
  assert(picker.top >= body.bottom && picker.top >= modeLine.bottom);
  const row = document.querySelector(".grep-row")!;
  equal(row.querySelector(".grep-location")!.getBoundingClientRect().top, row.querySelector(".grep-snippet")!.getBoundingClientRect().top);
  equal(windowSnapshot(), before); equal(fileReads().length, 0);
  equal(useFilesStore.getState().buffers.length, 0);
  assert(document.activeElement === input);
  assert(!document.querySelector(".grep-buffer"));
});

test("candidate navigation previews source while preserving focus, buffers and histories", async () => {
  mock("search_repo", () => found(Array.from({ length: 40 }, (_, i) => hit({ path: "src/file" + i + ".txt", line: i + 1 }))));
  await mount(); const before = windowSnapshot(); const input = await search();
  key("n", { ctrlKey: true }, input);
  await waitFor(() => gs().selected === 1);
  equal(input.getAttribute("aria-activedescendant"), "grep-hit-1");
  key("p", { ctrlKey: true }, input); await waitFor(() => gs().selected === 0);
  key("p", { ctrlKey: true }, input); await waitFor(() => gs().selected === 39);
  await waitFor(() => document.querySelector(".grep-list")!.scrollTop > 0);
  await waitFor(() => document.querySelector('[data-preview-path="src/file39.txt"] .cm-editor'));
  equal(calls.filter((c) => c.command === "read_preview").length, 1);
  equal(windowSnapshot(), before); equal(fileReads().length, 0);
  equal(useHistoryStore.getState().back, []); equal(useFilesStore.getState().buffers, []);
  assert(document.activeElement === input);
});

test("search waits for three characters and shows how many more are needed", async () => {
  await mount(); openGrep(); const input = await prompt();
  await waitFor(() => document.querySelector(".grep-picker .mb-empty")?.textContent === "3 chars more");
  const height = document.querySelector(".grep-list")!.getBoundingClientRect().height;
  type(input, "n");
  await waitFor(() => document.querySelector(".grep-picker .mb-empty")?.textContent === "2 chars more");
  await runGrep(); equal(searchCalls().length, 0);
  type(input, "ne");
  await waitFor(() => document.querySelector(".grep-picker .mb-empty")?.textContent === "1 char more");
  await runGrep(); equal(searchCalls().length, 0);
  type(input, "nee");
  await waitFor(() => gs().status === "ready" && document.querySelector(".grep-row"));
  equal(searchCalls().length, 1); equal((searchCalls()[0].args.request as { query: string }).query, "nee");
  equal(document.querySelector(".grep-list")!.getBoundingClientRect().height, height);
});

test("the minimum query length counts Unicode characters rather than UTF-16 units", async () => {
  await mount(); openGrep(); const input = await prompt();
  type(input, "😀");
  await waitFor(() => document.querySelector(".grep-picker .mb-empty")?.textContent === "2 chars more");
  await runGrep(); equal(searchCalls().length, 0);
  type(input, "😀é");
  await waitFor(() => document.querySelector(".grep-picker .mb-empty")?.textContent === "1 char more");
  await runGrep(); equal(searchCalls().length, 0);
  type(input, "😀éx"); await waitFor(() => searchCalls().length === 1);
  equal((searchCalls()[0].args.request as { query: string }).query, "😀éx");
});

test("rapid edits debounce into a single search for the latest query", async () => {
  openGrep(); editGrep("nee"); editGrep("need"); editGrep("needle");
  equal(searchCalls().length, 0);
  await waitFor(() => gs().status === "ready");
  equal(searchCalls().length, 1); equal((searchCalls()[0].args.request as { query: string }).query, "needle");
});

test("query updates retain mounted rows, selection and picker height until results arrive", async () => {
  mock("search_repo", () => found(matches));
  await mount(); const input = await search(); key("n", { ctrlKey: true }, input);
  await waitFor(() => gs().selected === 1);
  const selected = document.querySelector<HTMLElement>(".grep-row.is-selected")!;
  const list = document.querySelector(".grep-list")!;
  const height = list.getBoundingClientRect().height;
  const bodyHeight = document.querySelector(".app-body")!.getBoundingClientRect().height;
  const scopeLeft = document.querySelector(".grep-scope")!.getBoundingClientRect().left;
  const pending = deferred<SearchResults>(); mock("search_repo", () => pending.promise);
  type(input, "needleX");
  await waitFor(() => gs().status === "loading" && searchCalls().length === 2);
  assert(document.querySelector(".grep-row.is-selected") === selected);
  equal(gs().selected, 1); equal(document.querySelectorAll(".grep-row").length, 2);
  equal(list.getBoundingClientRect().height, height);
  equal(document.querySelector(".app-body")!.getBoundingClientRect().height, bodyHeight);
  equal(document.querySelector(".grep-scope")!.getBoundingClientRect().left, scopeLeft);
  assert(!document.querySelector(".grep-picker .mb-empty"));
  assert(document.querySelector(".grep-picker .mb-hint")?.textContent?.includes("Updating"));
  key("Enter", {}, input); selected.click();
  assert(document.querySelector(".grep-picker")); equal(fileReads().length, 0);
  pending.resolve(found([hit({ path: "src/b.txt", line: 3, col: 6, snippet: "third needleX", ranges: [{ from: 6, to: 13 }] })]));
  await waitFor(() => gs().status === "ready" && document.querySelectorAll(".grep-row").length === 1);
  assert(document.querySelector(".grep-row.is-selected") === selected);
  equal(gs().selected, 0); assert(selected.textContent?.includes("third needleX"));
  equal(list.getBoundingClientRect().height, height); assert(document.activeElement === input);
  equal(fileReads().length, 0);
});

test("failed updates keep the displayed rows and report the error without allowing outdated selection", async () => {
  await mount(); const input = await search();
  const row = document.querySelector(".grep-row")!;
  mock("search_repo", () => { throw new Error("read failed"); });
  type(input, "needleX");
  await waitFor(() => gs().status === "error");
  assert(document.querySelector(".grep-row") === row);
  assert(document.querySelector(".grep-summary")?.textContent?.includes("read failed"));
  key("Enter", {}, input); assert(document.querySelector(".grep-picker")); equal(fileReads().length, 0);
  mock("search_repo", () => found([])); type(input, "needleXY");
  await waitFor(() => gs().status === "ready");
  equal(document.querySelectorAll(".grep-row").length, 0);
  assert(document.querySelector(".grep-picker .mb-empty")?.textContent?.includes("No matching lines"));
});

test("Enter from the diff closes search and opens the selected match in project mode without splitting", async () => {
  repoFixture(branchSpec, summary(branches()));
  mock("search_repo", () => found(matches));
  await mount(); const input = await search(); key("n", { ctrlKey: true }, input);
  await waitFor(() => gs().selected === 1); key("Enter", {}, input);
  await waitFor(() => activeView()?.hasFocus && !document.querySelector(".grep-picker"));
  assert(inProjectMode(ws())); equal(ws().selected, 1); equal(windowOrder(ws().layout), [1]);
  const buffer = useFilesStore.getState().buffers[0];
  equal(buffer.path, "src/b.txt"); equal(buffer.source, { kind: "commit", oid: OID });
  equal(positionOf(1, buffer.id)?.line, 3); equal(positionOf(1, buffer.id)?.col, 6);
  equal(gs().results, null); equal(gs().context, null);
  equal(useMinibufferStore.getState().request, null);
  goBack(); await waitFor(() => selectedBuffer(ws()) === "diff");
  assert(!document.querySelector(".grep-picker"));
});

test("clicking a match from the log closes search and opens its exact line and UTF-16 column", async () => {
  ws().show(1, "log"); await mount(); await search();
  document.querySelector<HTMLElement>(".grep-row")!.click();
  await waitFor(() => activeView()?.hasFocus && !document.querySelector(".grep-picker"));
  const buffer = useFilesStore.getState().buffers[0];
  assert(inProjectMode(ws())); equal(windowOrder(ws().layout), [1]);
  equal(positionOf(1, buffer.id)?.line, 2); equal(positionOf(1, buffer.id)?.col, 3);
  equal(activeView()!.state.selection.main.head - activeView()!.state.doc.line(2).from, 3);
  goBack(); await waitFor(() => selectedBuffer(ws()) === "log");
});

test("a search from a project file opens the result in that same window", async () => {
  const origin = openFile("origin.txt"); ws().show(1, origin.id);
  await mount(); await waitFor(() => activeView()?.hasFocus);
  const before = windowSnapshot(); const input = await search();
  equal(windowSnapshot(), before); equal(fileReads().length, 0);
  key("Enter", {}, input);
  await waitFor(() => activeView()?.hasFocus && !document.querySelector(".grep-picker"));
  equal(ws().selected, 1); equal(windowOrder(ws().layout), [1]);
  const result = useFilesStore.getState().buffers.find((b) => b.path === "src/a.txt")!;
  equal(ws().shown[1], result.id);
  goBack(); equal(ws().shown[1], origin.id);
});

test("a selected secondary project window is reused even if the matched file is already visible elsewhere", async () => {
  const target = openFile("src/a.txt"), origin = openFile("origin.txt");
  ws().show(1, target.id); const second = ws().split(1, "row", origin.id); ws().select(second);
  await mount(); await waitFor(() => activeView()?.hasFocus);
  const input = await search(); key("Enter", {}, input);
  await waitFor(() => !document.querySelector(".grep-picker"));
  equal(ws().selected, second); equal(windowOrder(ws().layout), [1, second]);
  equal(ws().shown[1], target.id); equal(ws().shown[second], target.id);
  equal(fileReads().length, 0);
  goBack(); equal(ws().shown[second], origin.id);
});

test("searching from a file beside the diff enters project mode on acceptance", async () => {
  const origin = openFile("beside.txt");
  const side = ws().split(1, "row", origin.id); ws().select(side);
  await mount(); await waitFor(() => activeView()?.hasFocus);
  assert(!inProjectMode(ws()));
  const input = await search();
  equal(ws().shown[1], "diff"); equal(ws().shown[side], origin.id); equal(fileReads().length, 0);
  key("Enter", {}, input);
  await waitFor(() => inProjectMode(ws()) && !document.querySelector(".grep-picker"));
  const target = useFilesStore.getState().buffers.find((b) => b.path === "src/a.txt")!;
  equal(ws().shown[1], target.id); equal(ws().shown[side], origin.id); equal(ws().selected, 1);
  equal(windowOrder(ws().layout), [1, side]);
});

test("accepting a result from the diff restores the existing project layout", async () => {
  const left = openFile("left.txt"), right = openFile("right.txt");
  ws().show(1, left.id); const second = ws().split(1, "row", right.id); ws().select(second);
  const layout = structuredClone(ws().layout);
  showDiff(); equal(selectedBuffer(ws()), "diff");
  await mount(); const input = await search(); key("Enter", {}, input);
  await waitFor(() => activeView()?.hasFocus && !document.querySelector(".grep-picker"));
  const target = useFilesStore.getState().buffers.find((b) => b.path === "src/a.txt")!;
  equal(ws().layout, layout); assert(inProjectMode(ws()));
  equal(ws().shown[1], left.id); equal(ws().shown[second], target.id); equal(ws().selected, second);
});

test("a search from the project tree opens its result in the existing project window", async () => {
  repoFixture({ kind: "worktree" }, summary(undefined, []));
  ws().show(1, "project"); ws().setTreeFocused(true);
  await mount(); const input = await search();
  equal(ws().shown[1], "project"); assert(ws().treeFocused); equal(fileReads().length, 0);
  key("Enter", {}, input);
  await waitFor(() => activeView()?.hasFocus && !document.querySelector(".grep-picker"));
  assert(inProjectMode(ws())); assert(!ws().treeFocused); equal(windowOrder(ws().layout), [1]);
});

test("opening an unchanged result switches to all files and reveals its folders at the searched revision", async () => {
  repoFixture(branchSpec, summary(branches(), [file({ path: "src/services/changed.txt" })]));
  mock("search_repo", () => found([hit({ path: "src/services/unused.txt" })]));
  useProjectStore.getState().setSource({ kind: "commit", oid: "a".repeat(40) }, "old side");
  await mount(); const input = await search();
  equal(useProjectStore.getState().filter, "changed");
  key("Enter", {}, input);
  await waitFor(() => document.querySelector(".tree-row.is-selected.is-open .tree-name")?.textContent === "unused.txt");
  const project = useProjectStore.getState();
  equal(project.filter, "all"); equal(project.treeCursor, "src/services/unused.txt");
  equal(project.source, { kind: "commit", oid: OID });
  assert(project.expanded.has("src")); assert(project.expanded.has("src/services"));
  equal(document.querySelector(".project-tree-mode")?.textContent, "all files");
  const listings = calls.filter((call) => call.command === "list_repo_dir");
  assert(listings.some((call) => call.args.path === "src/services"));
  for (const listing of listings) equal(listing.args.source, { kind: "commit", oid: OID });
  assert(activeView()?.hasFocus); assert(!ws().treeFocused);
});

test("opening a changed result reveals a folded path without switching out of changed files", async () => {
  repoFixture(branchSpec, summary(branches(), [file({ path: "src/services/changed.txt" })]));
  mock("search_repo", () => found([hit({ path: "src/services/changed.txt" })]));
  await mount(); useProjectStore.getState().closeFolder("src/services");
  const input = await search(); key("Enter", {}, input);
  await waitFor(() => document.querySelector(".tree-row.is-selected.is-open .tree-name")?.textContent === "changed.txt");
  equal(useProjectStore.getState().filter, "changed");
  equal(useProjectStore.getState().treeCursor, "src/services/changed.txt");
  assert(useProjectStore.getState().expanded.has("src/services"));
  equal(calls.filter((call) => call.command === "list_repo_dir").length, 0);
  assert(activeView()?.hasFocus);
});

test("C-g dismisses completed results, restores the originating focus and leaves no grep buffer to switch to", async () => {
  const origin = openFile("origin.txt"); ws().show(1, origin.id);
  await mount(); await waitFor(() => activeView()?.hasFocus);
  const before = windowSnapshot(); const input = await search();
  key("g", { ctrlKey: true }, input);
  await waitFor(() => !document.querySelector(".grep-picker") && activeView()?.hasFocus);
  equal(windowSnapshot(), before); equal(gs().results, null); equal(gs().context, null);
  equal(fileReads().length, 0); equal(useHistoryStore.getState().back, []);
  key("x", { ctrlKey: true }); key("b");
  await waitFor(() => document.activeElement?.id === "minibuffer-input");
  assert(!Array.from(document.querySelectorAll(".mb-name")).some((el) => el.textContent === "grep"));
});

test("Escape cancels backend work and a late reply cannot restore the closed picker or affect a reopened search", async () => {
  const pending = deferred<SearchResults>(); mock("search_repo", () => pending.promise);
  await mount(); openGrep(); const input = await prompt(); type(input, "needle");
  await waitFor(() => searchCalls().length === 1);
  const searchId = searchCalls()[0].args.searchId;
  key("Escape", {}, input);
  await waitFor(() => !document.querySelector(".grep-picker"));
  assert(calls.some((c) => c.command === "cancel_repo_search" && c.args.searchId === searchId));
  equal(gs().context, null); equal(gs().results, null); equal(selectedBuffer(ws()), "diff");
  openGrep(); const reopened = await prompt(); equal(reopened.value, "");
  mock("search_repo", () => found([])); type(reopened, "latest");
  await waitFor(() => gs().status === "ready");
  pending.resolve(found(matches)); await new Promise((resolve) => setTimeout(resolve, 0));
  equal(gs().query, "latest"); equal(gs().results?.hits, []); equal(fileReads().length, 0);
});

test("changed-file scope searches only surviving new paths at the comparison's revision", async () => {
  repoFixture(commitSpec(), summary(commit(), [file({ path: "renamed.txt", oldPath: "old.txt", status: "renamed" }), file({ path: "deleted.txt", status: "deleted" })]));
  openGrep(); editGrep("needle"); setGrepScope("changed"); await runGrep();
  equal(searchCalls()[0].args.request, { repo: "/fixture", source: { kind: "commit", oid: OID }, query: "needle", only: ["renamed.txt"] });
  useRepoStore.getState().applyComparison(commitSpec(), summary(commit(), [])); await runGrep();
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

test("repository and revision changes close search and invalidate pending replies", async () => {
  const pending = deferred<SearchResults>(); mock("search_repo", () => pending.promise);
  openGrep(); editGrep("needle"); const first = runGrep();
  repoFixture(branchSpec, summary(branches()));
  equal(gs().context, null); equal(useMinibufferStore.getState().request, null);
  pending.resolve(found()); await first; equal(gs().results, null);
  openGrep(); editGrep("branch"); mock("search_repo", () => found()); await runGrep(); assert(gs().results);
  useRepoStore.getState().applyComparison(branchSpec, summary(branches("c".repeat(40))));
  equal(gs().context, null); equal(gs().results, null);
  const late = deferred<SearchResults>(); mock("search_repo", () => late.promise);
  openGrep(); editGrep("late"); const last = runGrep();
  useRepoStore.getState().closeRepo(); repoFixture();
  late.reject(new Error("closed repository")); await last;
  equal(gs().context, null); equal(gs().error, null);
});

test("M-n uses the symbol at the cursor while search follows the reviewed target revision", async () => {
  repoFixture(commitSpec(), summary(commit()));
  const origin = openFile("old.txt", { kind: "commit", oid: "a".repeat(40) });
  useFilesStore.getState().update(origin.id, { content: "validateOrder(order)" }); ws().show(1, origin.id);
  await mount(); await waitFor(() => activeView()?.state.doc.toString() === "validateOrder(order)");
  openGrep(); const input = await prompt(); key("n", { altKey: true }, input);
  await waitFor(() => searchCalls().length === 1);
  equal(gs().query, "validateOrder");
  equal((searchCalls()[0].args.request as { source: unknown }).source, { kind: "commit", oid: OID });
  equal(fileReads().length, 0);
});

test("errors, empty results, scope changes and truncation remain visible inside the picker", async () => {
  mock("search_repo", () => { throw new Error("cannot read repository"); });
  await mount(); openGrep(); const input = await prompt(); type(input, "needle");
  await waitFor(() => document.querySelector(".grep-picker .mb-empty")?.textContent?.includes("cannot read repository"));
  mock("search_repo", () => found([])); type(input, "missing");
  await waitFor(() => document.querySelector(".grep-picker .mb-empty")?.textContent?.includes("No matching lines"));
  key("Enter", {}, input); assert(document.querySelector(".grep-picker"));
  mock("search_repo", () => found([hit()], { truncated: true, skippedFiles: 2, skippedLines: 3 }));
  document.querySelector<HTMLButtonElement>(".grep-scope")!.click();
  await waitFor(() => document.querySelector(".grep-summary")?.textContent?.includes("Results limited"));
  const text = document.querySelector(".grep-summary")!.textContent!;
  assert(text.includes("2 files skipped")); assert(text.includes("3 lines over 16 KiB skipped"));
  equal(gs().scope, "changed"); equal(fileReads().length, 0); assert(document.activeElement === input);
});

test("replacing the minibuffer cancels the transient search and discards late failures", async () => {
  const pending = deferred<SearchResults>(); mock("search_repo", () => pending.promise);
  openGrep(); editGrep("needle"); const first = runGrep();
  useMinibufferStore.getState().open({ kind: "command" });
  equal(gs().context, null); equal(gs().results, null);
  assert(calls.some((c) => c.command === "cancel_repo_search"));
  pending.reject(new Error("old search")); await first;
  equal(useMinibufferStore.getState().request?.kind, "command"); equal(gs().error, null);
});

test("clearing input cancels the old query without launching an empty repository scan", async () => {
  const pending = deferred<SearchResults>(); mock("search_repo", () => pending.promise);
  openGrep(); editGrep("needle"); const first = runGrep();
  editGrep(""); equal(gs().status, "idle"); equal(gs().results, null);
  pending.resolve(found()); await first;
  equal(gs().results, null); equal(searchCalls().length, 1);
  cancelGrep(); equal(useMinibufferStore.getState().request, null);
});

test("shortening a pending query below three characters cancels it and restores the length hint", async () => {
  const pending = deferred<SearchResults>(); mock("search_repo", () => pending.promise);
  await mount(); openGrep(); const input = await prompt(); type(input, "needle");
  await waitFor(() => searchCalls().length === 1);
  type(input, "ne");
  await waitFor(() => document.querySelector(".grep-picker .mb-empty")?.textContent === "1 char more");
  assert(calls.some((call) => call.command === "cancel_repo_search"));
  await runGrep(); equal(searchCalls().length, 1);
  pending.resolve(found()); await new Promise((resolve) => setTimeout(resolve, 0));
  equal(gs().results, null); equal(gs().status, "idle"); equal(gs().query, "ne");
  equal(document.querySelectorAll(".grep-row").length, 0);
});

void run();
