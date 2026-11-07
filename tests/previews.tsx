import { afterEach, assert, beforeEach, calls, deferred, equal, mock, run, test, waitFor } from "./support";
import { branches, branchSpec, OID, openFile, PARENT, repoFixture, resetState, summary } from "./fixtures";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import AppShell from "../src/components/AppShell";
import { editGrep, openGrep } from "../src/lib/grep";
import { activeView, placeCursor, positionOf, savePosition } from "../src/lib/project-view";
import { previewFile } from "../src/lib/project";
import { findUsages, gotoDefinitionAt } from "../src/lib/xref";
import { useFilesStore } from "../src/state/files";
import { useGrepStore } from "../src/state/grep";
import { useHistoryStore } from "../src/state/history";
import { useMinibufferStore } from "../src/state/minibuffer";
import { usePickerPreviewStore } from "../src/state/picker-preview";
import { useProjectStore } from "../src/state/project";
import { useRepoStore } from "../src/state/repo";
import { useWindowStore, windowOrder } from "../src/state/windows";
import { useXrefStore } from "../src/state/xref";
import type { ProjectSource } from "../src/types/repo";
import type { XrefResult } from "../src/types/xref";

let root: Root | null = null;
let parent: HTMLElement | null = null;
const ws = () => useWindowStore.getState();
const pane = () => usePickerPreviewStore.getState().shown;
const choice = { source: { kind: "commit", oid: OID } as ProjectSource, label: "feature@bbbbbbb" };
const text = "first\n😀 needle needle\nthird caller\nfourth";
const xref = (file = "candidate.txt", line = 2, confirmed = true): XrefResult => ({
  file, line, col: 3, snippet: "😀 needle needle", kind: "reference", symbolKind: "function", confirmed,
});
const snapshot = () => {
  const { layout, shown, prev, ahead, recent, selected, treeFocused, stash } = ws();
  return structuredClone({ layout, shown, prev, ahead, recent, selected, treeFocused, stash });
};
const reads = () => calls.filter((c) => c.command === "read_preview");

beforeEach(() => {
  resetState(); useXrefStore.getState().close(); repoFixture();
  useProjectStore.setState({ treeHidden: true });
  mock("read_preview", () => text);
  mock("read_file", () => text);
  mock("symbol_occurrences", () => null);
  mock("list_repo_dir", ({ path }) => ({ path, entries: [] }));
  mock("list_recent_repos", () => []);
  mock("list_commits", () => ({ range: { kind: "all" }, commits: [] }));
  mock("log_coverage", () => ({ total: 0, reviewed: 0, flagged: 0, ignored: 0 }));
  mock("cancel_repo_search", () => {});
  mock("search_repo", () => ({ hits: [
    { path: "candidate.txt", line: 2, col: 3, snippet: "😀 needle needle", ranges: [{ from: 3, to: 9 }, { from: 10, to: 16 }] },
    { path: "candidate.txt", line: 3, col: 6, snippet: "third caller", ranges: [{ from: 6, to: 12 }] },
  ], truncated: false, skippedFiles: 0, skippedLines: 0, cancelled: false }));
});
afterEach(() => {
  root?.unmount(); root = null; parent?.remove(); parent = null;
  useXrefStore.getState().close(); resetState();
  equal(usePickerPreviewStore.getState(), { owner: null, shown: null, frame: null });
});
async function mount() {
  parent = document.body.appendChild(document.createElement("div")); parent.className = "fixture";
  root = createRoot(parent); root.render(<AppShell />);
  await waitFor(() => document.querySelector(".app-shell"));
}
function key(key: string, mods: KeyboardEventInit = {}) {
  assert(document.activeElement);
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }));
}
function type(value: string) {
  const input = document.activeElement;
  assert(input instanceof HTMLInputElement);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function origin() {
  const buffer = openFile("origin.txt");
  buffer.content = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n");
  ws().show(1, buffer.id);
  await mount(); await waitFor(() => activeView()?.hasFocus);
  placeCursor(1, buffer.id, 85, 2);
  await waitFor(() => positionOf(1, buffer.id)?.line === 85);
  return buffer;
}
async function previewReady(path = "candidate.txt") {
  await waitFor(() => pane()?.buffer.path === path && pane()?.buffer.content != null &&
    document.querySelector(`[data-preview-path="${path}"] .cm-editor`));
  const el = document.querySelector<HTMLElement>(`[data-preview-path="${path}"] .cm-editor`)!;
  const view = EditorView.findFromDOM(el); assert(view);
  return view;
}
async function grep() {
  openGrep(); await waitFor(() => document.activeElement?.id === "grep-input");
  editGrep("needle");
  await waitFor(() => useGrepStore.getState().status === "ready");
  return previewReady();
}

test("grep previews revision text, UTF-16 matches and line without changing review state", async () => {
  repoFixture(branchSpec, summary(branches())); await mount();
  const before = snapshot(); const source = useProjectStore.getState().source;
  const view = await grep();
  equal(view.state.doc.toString(), text);
  equal(view.state.doc.lineAt(view.state.selection.main.head).number, 2);
  equal(view.state.selection.main.head - view.state.doc.line(2).from, 3);
  equal([...view.dom.querySelectorAll(".cm-preview-match")].map((el) => el.textContent), ["needle", "needle"]);
  equal(reads()[0].args, { repo: "/fixture", source: { kind: "commit", oid: OID }, path: "candidate.txt" });
  equal(snapshot(), before); equal(useProjectStore.getState().source, source);
  equal(useFilesStore.getState().buffers, []); equal(useHistoryStore.getState().back, []);
  equal(document.activeElement?.id, "grep-input");
  assert(document.querySelector(".project-tree")?.getAttribute("aria-hidden") !== "false");
});

test("grep reuses text across locations, adopts on RET and records the captured origin once", async () => {
  await origin(); await grep();
  key("n", { ctrlKey: true });
  await waitFor(() => pane()?.position.line === 3 && pane()?.buffer.content != null);
  equal(reads().length, 1);
  key("Enter");
  await waitFor(() => !document.querySelector(".grep-picker") && activeView()?.hasFocus);
  equal(useFilesStore.getState().buffers.map((b) => b.path), ["origin.txt", "candidate.txt"]);
  equal(calls.filter((c) => c.command === "read_file").length, 0);
  equal(useHistoryStore.getState().back.map((p) => p.kind === "file" ? [p.path, p.line, p.col] : p.kind), [["origin.txt", 85, 2]]);
  equal(activeView()?.state.doc.lineAt(activeView()!.state.selection.main.head).number, 3);
});

test("cancelling an already-open same-file result preserves the exact view and selection", async () => {
  const buffer = await origin();
  mock("search_repo", () => ({ hits: [{ path: buffer.path, line: 2, col: 1, snippet: "line 2", ranges: [] }],
    truncated: false, skippedFiles: 0, skippedLines: 0, cancelled: false }));
  const view = activeView()!;
  view.dispatch({ selection: { anchor: view.state.doc.line(83).from + 1, head: view.state.doc.line(85).from + 2 } });
  await waitFor(() => view.scrollDOM.scrollTop > 0);
  const selection = view.state.selection.toJSON(); const scroll = view.scrollDOM.scrollTop;
  const before = snapshot();
  openGrep(); await waitFor(() => document.activeElement?.id === "grep-input"); editGrep("line");
  await previewReady(buffer.path); equal(reads().length, 0);
  key("g", { ctrlKey: true });
  await waitFor(() => !pane() && activeView()?.hasFocus);
  assert(activeView() === view); equal(view.state.selection.toJSON(), selection);
  equal(view.scrollDOM.scrollTop, scroll); equal(snapshot(), before);
  equal(useHistoryStore.getState().back, []);
});

test("updating a grep query clears the old preview and cannot preview retained old rows", async () => {
  await mount(); await grep();
  const next = deferred<unknown>(); mock("search_repo", () => next.promise);
  editGrep("replacement");
  await waitFor(() => pane() == null);
  key("n", { ctrlKey: true }); key("Enter");
  equal(useFilesStore.getState().buffers, []); equal(reads().length, 1);
  next.resolve({ hits: [], truncated: false, skippedFiles: 0, skippedLines: 0, cancelled: false });
  await waitFor(() => useGrepStore.getState().status === "ready"); equal(pane(), null);
});

test("references keep confirmation groups and preview the originating revision", async () => {
  const buffer = openFile("origin.txt", choice.source); ws().show(1, buffer.id);
  await mount(); await waitFor(() => activeView()?.hasFocus);
  mock("symbol_at", () => ({ name: "needle", kind: "function", file: buffer.path, line: 1, col: 0 }));
  mock("find_references", () => [xref(), xref("unproven.txt", 3, false)]);
  await findUsages(); const view = await previewReady();
  equal(reads()[0].args.source, choice.source);
  assert(document.querySelector(".xref-group.is-unconfirmed")?.textContent?.includes("unconfirmed"));
  assert(document.querySelector(".xref-panel")?.contains(document.activeElement));
  const before = snapshot();
  view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  assert(document.querySelector(".xref-panel")?.contains(document.activeElement));
  equal(useFilesStore.getState().buffers.length, 1); equal(snapshot(), before);
  key("k"); await previewReady("unproven.txt");
  key("Escape"); await waitFor(() => !pane() && activeView()?.hasFocus);
  equal(useHistoryStore.getState().back, []);
});

test("ambiguous definitions preview and accept through normal xref navigation", async () => {
  await origin();
  mock("symbol_at", () => ({ name: "needle", kind: "function", file: "origin.txt", line: 85, col: 2 }));
  mock("find_definition", () => [xref(), xref("other.txt")]);
  await gotoDefinitionAt(85, 2); await previewReady();
  key("j"); await previewReady("other.txt");
  const id = pane()!.buffer.id;
  key("Enter"); await waitFor(() => !useXrefStore.getState().open && activeView()?.hasFocus);
  equal(ws().shown[1], id); equal(useFilesStore.getState().buffers.map((b) => b.path), ["origin.txt", "other.txt"]);
  equal(useHistoryStore.getState().back.length, 1); equal(calls.filter((c) => c.command === "read_file").length, 0);
});

test("a single resolved definition still jumps directly", async () => {
  await origin();
  mock("symbol_at", () => ({ name: "needle", kind: "function", file: "origin.txt", line: 85, col: 2 }));
  mock("find_definition", () => [xref()]);
  await gotoDefinitionAt(85, 2); await waitFor(() => activeView()?.state.doc.toString() === text);
  equal(reads().length, 0); equal(pane(), null); equal(useHistoryStore.getState().back.length, 1);
});

test("other-window preview removes its temporary split on cancel and keeps a real split on acceptance", async () => {
  await origin(); const before = snapshot();
  useXrefStore.getState().show("definitions", [xref()], choice, true);
  await previewReady(); equal(windowOrder(ws().layout).length, 2); equal(ws().selected, 1);
  key("Escape"); await waitFor(() => !pane()); equal(snapshot(), before);
  useXrefStore.getState().show("definitions", [xref()], choice, true);
  await previewReady(); key("Enter");
  await waitFor(() => !useXrefStore.getState().open && activeView()?.hasFocus);
  equal(windowOrder(ws().layout).length, 2); assert(ws().selected !== 1);
  equal(useHistoryStore.getState().back.length, 1);
});

test("buffer switching previews file candidates immediately without reads or reordering", async () => {
  const other = openFile("second.txt", { kind: "commit", oid: PARENT }); other.sourceLabel = "parent@aaaaaaa";
  savePosition(1, other.id, { line: 3, col: 1, top: 1 });
  await origin(); const before = snapshot();
  useMinibufferStore.getState().open({ kind: "buffer" });
  await waitFor(() => document.activeElement?.id === "minibuffer-input"); type("second.txt");
  await previewReady("second.txt"); equal(reads().length, 0); equal(snapshot(), before);
  assert(document.querySelector(".picker-file-preview .project-viewer-rev")?.textContent?.includes("parent@"));
  key("g", { ctrlKey: true }); await waitFor(() => !pane() && activeView()?.hasFocus);
  equal(snapshot(), before); equal(useHistoryStore.getState().back, []);
  useMinibufferStore.getState().open({ kind: "buffer", other: true });
  await waitFor(() => document.activeElement?.id === "minibuffer-input"); type("second.txt");
  await previewReady("second.txt"); key("Enter");
  await waitFor(() => activeView()?.hasFocus && useMinibufferStore.getState().request == null);
  equal(ws().shown[ws().selected], other.id); equal(windowOrder(ws().layout).length, 2);
  equal(activeView()?.state.selection.main.head, activeView()!.state.doc.line(3).from + 1);
  equal(useHistoryStore.getState().back.length, 1);
});

test("buffer switcher previews a diff across the frame without changing project windows", async () => {
  await origin(); useMinibufferStore.getState().open({ kind: "buffer" });
  await waitFor(() => document.activeElement?.id === "minibuffer-input"); type("diff");
  await waitFor(() => document.querySelector(".mb-row.is-selected .mb-name")?.textContent === "diff");
  await waitFor(() => document.querySelector('.frame-buffer-preview[data-preview-buffer="diff"] .diff-buffer'));
  equal(pane(), null); key("Enter");
  await waitFor(() => useMinibufferStore.getState().request == null);
  equal(ws().shown[ws().selected], "diff"); equal(useHistoryStore.getState().back.length, 1);
});

test("other-window buffer switching offers only files and never creates a frame preview", async () => {
  openFile("second.txt"); await origin(); const before = snapshot();
  useMinibufferStore.getState().open({ kind: "buffer", other: true });
  await waitFor(() => document.activeElement?.id === "minibuffer-input");
  equal([...document.querySelectorAll(".mb-row .mb-name")].map((row) => row.textContent), ["second.txt"]);
  type("diff"); await waitFor(() => document.querySelector(".mb-empty")?.textContent === "[No match]");
  equal(document.querySelector(".frame-buffer-preview"), null);
  key("Escape"); await waitFor(() => useMinibufferStore.getState().request == null);
  equal(snapshot(), before);
});

test("application buffer previews fill the frame and cancel back to the exact project split", async () => {
  await origin(); const original = activeView();
  const second = openFile("second.txt"); ws().split(1, "row", second.id);
  useProjectStore.setState({ treeHidden: false });
  await waitFor(() => document.querySelectorAll(".window").length === 2);
  const before = snapshot();
  useMinibufferStore.getState().open({ kind: "buffer" });
  await waitFor(() => document.activeElement?.id === "minibuffer-input");
  for (const name of ["log", "help", "diff", "help", "log"] as const) {
    type(name);
    await waitFor(() => document.querySelector(`[data-preview-buffer="${name}"] .${name}-buffer`));
    const preview = document.querySelector<HTMLElement>(".frame-buffer-preview")!;
    const frame = document.querySelector(".frame")!.getBoundingClientRect();
    equal(preview.getBoundingClientRect().width, frame.width);
    equal(preview.getBoundingClientRect().height, frame.height);
    equal(preview.getBoundingClientRect().left, frame.left);
    equal(preview.getBoundingClientRect().top, frame.top);
    equal(getComputedStyle(document.querySelector(".project-tree")!).visibility, "hidden");
    equal(document.activeElement?.id, "minibuffer-input");
    equal(snapshot(), before); equal(useHistoryStore.getState().back, []);
  }
  type("second.txt"); await previewReady("second.txt");
  equal(document.querySelector(".frame-buffer-preview"), null);
  key("Escape"); await waitFor(() => useMinibufferStore.getState().request == null && activeView()?.hasFocus);
  equal(snapshot(), before); assert(activeView() === original);
  equal(positionOf(1, ws().shown[1] as `file:${string}`)?.line, 85);
});

test("full help preview scrolls inside the buffer area and leaves the picker visible and clickable", async () => {
  await origin();
  useMinibufferStore.getState().open({ kind: "buffer" });
  await waitFor(() => document.activeElement?.id === "minibuffer-input"); type("help");
  await waitFor(() => document.querySelector('.frame-buffer-preview[data-preview-buffer="help"] .help-buffer'));
  const shell = document.querySelector<HTMLElement>(".app-shell")!;
  const input = document.querySelector<HTMLInputElement>("#minibuffer-input")!;
  const help = document.querySelector<HTMLElement>(".frame-buffer-preview .help-buffer")!;
  const scroll = help.querySelector<HTMLElement>(".help-scroll")!;
  for (const height of [600, 340]) {
    shell.style.height = `${height}px`;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const body = document.querySelector(".app-body")!.getBoundingClientRect();
    const bounds = help.getBoundingClientRect();
    assert(bounds.top >= body.top && bounds.bottom <= body.bottom + 1,
      `Help escaped its buffer area: bottom ${bounds.bottom}, buffer bottom ${body.bottom}`);
    assert(scroll.clientHeight > 0 && scroll.scrollHeight > scroll.clientHeight,
      "Long help must scroll within the preview");
    const selected = document.querySelector<HTMLElement>(".mb-row.is-selected")!;
    const row = selected.getBoundingClientRect();
    const topmost = document.elementFromPoint(Math.max(0, row.left) + 10, row.top + row.height / 2);
    assert(selected.contains(topmost),
      `Selected buffer candidate is covered: ${JSON.stringify({ height, row: row.toJSON(), body: body.toJSON(),
        hit: topmost?.className, viewport: innerHeight, scroll: window.scrollY })}`);
    const field = input.getBoundingClientRect();
    assert(document.elementFromPoint(field.left + 2, field.top + field.height / 2) === input,
      "Help covered the minibuffer input");
    assert(document.activeElement === input);
    scroll.scrollTop = scroll.scrollHeight;
    assert(scroll.scrollTop > 0);
  }
  key("Escape"); await waitFor(() => activeView()?.hasFocus);
});

test("previewing a buffer already in a neighboring window returns its live host on cancel", async () => {
  await origin(); const neighbor = ws().split(1, "row", "diff");
  await waitFor(() => document.querySelector(`[data-window="${neighbor}"] .diff-buffer`));
  const diff = document.querySelector(".diff-buffer"); const before = snapshot();
  useMinibufferStore.getState().open({ kind: "buffer" });
  await waitFor(() => document.activeElement?.id === "minibuffer-input"); type("diff");
  await waitFor(() => document.querySelector(".frame-buffer-preview .diff-buffer"));
  assert(document.querySelector(".frame-buffer-preview .diff-buffer") === diff);
  key("Escape");
  await waitFor(() => document.querySelector(`[data-window="${neighbor}"] .diff-buffer`));
  assert(document.querySelector(`[data-window="${neighbor}"] .diff-buffer`) === diff);
  equal(snapshot(), before);
});

test("accepting help takes the whole frame and q restores the saved project layout", async () => {
  await origin(); const second = openFile("second.txt");
  const other = ws().split(1, "row", second.id); ws().select(other);
  await waitFor(() => activeView()?.hasFocus && document.querySelectorAll(".window").length === 2);
  const layout = ws().layout; const shown = ws().shown;
  useMinibufferStore.getState().open({ kind: "buffer" });
  await waitFor(() => document.activeElement?.id === "minibuffer-input"); type("help");
  await waitFor(() => document.querySelector(".frame-buffer-preview .help-buffer")); key("Enter");
  await waitFor(() => useMinibufferStore.getState().request == null && document.activeElement?.classList.contains("help-buffer"));
  equal(windowOrder(ws().layout), [other]); equal(ws().shown[other], "help"); assert(ws().stash);
  equal(useHistoryStore.getState().back, []);
  key("q");
  await waitFor(() => activeView()?.hasFocus && document.querySelectorAll(".window").length === 2);
  equal(ws().layout, layout); equal(ws().shown, shown); equal(ws().selected, other);
  assert(!ws().prev[other]?.includes("help"));
});

test("late preview successes and failures cannot replace newer results or survive cancellation", async () => {
  await origin(); const old = deferred<string>();
  mock("read_preview", ({ path }) => path === "slow.txt" ? old.promise : text);
  useXrefStore.getState().show("refs", [xref("slow.txt"), xref()], choice);
  await waitFor(() => reads().length === 1);
  key("j"); await previewReady(); old.resolve("obsolete");
  await Promise.resolve(); equal(pane()?.buffer.path, "candidate.txt"); equal(pane()?.buffer.content, text);
  key("Escape"); await waitFor(() => !pane());
  const late = deferred<string>(); mock("read_preview", () => late.promise);
  useXrefStore.getState().show("refs", [xref("late.txt")], choice);
  await waitFor(() => reads().length === 3); key("Escape");
  await waitFor(() => !pane()); late.reject("late failure");
  await Promise.resolve(); equal(pane(), null); equal(useFilesStore.getState().buffers.length, 1);
});

test("unavailable previews have a separate error state and explicit acceptance still visits", async () => {
  await origin(); mock("read_preview", () => { throw new Error("file is over the 2 MiB preview limit"); });
  useXrefStore.getState().show("refs", [xref()], choice);
  await waitFor(() => document.querySelector(".picker-file-preview [role=status]")?.textContent?.includes("2 MiB"));
  equal(useFilesStore.getState().buffers.length, 1);
  assert(document.querySelector(".xref-panel")?.contains(document.activeElement));
  key("Enter"); await waitFor(() => activeView()?.state.doc.toString() === text);
  equal(calls.filter((c) => c.command === "read_file").length, 1);
});

test("refresh and repository replacement close sessions and ignore outstanding content", async () => {
  await origin(); const late = deferred<string>(); mock("read_preview", () => late.promise);
  useXrefStore.getState().show("refs", [xref()], choice);
  await waitFor(() => reads().length === 1);
  useRepoStore.getState().applyComparison({ kind: "worktree" }, summary());
  await waitFor(() => !useXrefStore.getState().open && !pane());
  late.resolve("old revision"); await Promise.resolve(); equal(pane(), null);
  useMinibufferStore.getState().open({ kind: "buffer" });
  await waitFor(() => usePickerPreviewStore.getState().owner != null);
  useRepoStore.getState().closeRepo();
  await waitFor(() => useMinibufferStore.getState().request == null);
});

test("cancelling a picker over a tree preview restores that preview without adopting it", async () => {
  await origin(); ws().setTreeFocused(true);
  await previewFile("tree.txt", { source: { kind: "worktree" }, label: null });
  const tree = ws().preview; assert(tree);
  useXrefStore.getState().show("refs", [xref()], choice);
  await previewReady(); key("Escape"); await waitFor(() => !pane());
  equal(ws().preview, tree); equal(useFilesStore.getState().preview?.path, "tree.txt");
  equal(useFilesStore.getState().buffers.map((b) => b.path), ["origin.txt"]);
});

test("a Markdown preview keeps the matched source row and its markup visible", async () => {
  await origin();
  mock("read_preview", () => "A paragraph begins here\nand **needle** continues here\nand ends here.\n");
  useXrefStore.getState().show("refs", [xref("README.md")], choice);
  const view = await previewReady("README.md");
  await waitFor(() => view.dom.querySelector(".cm-preview-line.cm-md-source")?.textContent?.includes("**needle**"));
  assert(view.dom.querySelector(".cm-preview-line")?.textContent?.includes("and **needle** continues here"));
  assert(document.querySelector(".xref-panel")?.contains(document.activeElement));
});

test("replacing a picker synchronously invalidates its in-flight preview", async () => {
  await origin(); const late = deferred<string>(); mock("read_preview", () => late.promise);
  useMinibufferStore.getState().open({ kind: "buffer" });
  await waitFor(() => document.activeElement?.id === "minibuffer-input");
  // Existing file candidates need no reads; switch to a location picker with a pending read.
  useMinibufferStore.getState().close();
  useXrefStore.getState().show("refs", [xref()], choice);
  await waitFor(() => reads().length === 1);
  useXrefStore.getState().close();
  useMinibufferStore.getState().open({ kind: "command" });
  late.resolve("obsolete"); await Promise.resolve();
  equal(pane(), null); equal(useFilesStore.getState().buffers.map((b) => b.path), ["origin.txt"]);
});

test("clicking another xref candidate does not adopt the file currently being previewed", async () => {
  await origin(); useXrefStore.getState().show("refs", [xref(), xref("clicked.txt", 3)], choice);
  await previewReady();
  const rows = document.querySelectorAll<HTMLElement>(".xref-row");
  rows[1].click();
  await waitFor(() => !useXrefStore.getState().open && activeView()?.state.doc.toString() === text);
  equal(useFilesStore.getState().buffers.map((b) => b.path), ["origin.txt", "clicked.txt"]);
  equal(calls.filter((c) => c.command === "read_file").length, 1);
  equal(useHistoryStore.getState().back.length, 1);
});

test("a late reference lookup cannot open a preview after the review changes", async () => {
  await origin(); const lookup = deferred<XrefResult[]>();
  mock("symbol_at", () => ({ name: "needle", kind: "function", file: "origin.txt", line: 85, col: 2 }));
  mock("find_references", () => lookup.promise);
  const pending = findUsages();
  await waitFor(() => calls.some((c) => c.command === "find_references"));
  useRepoStore.getState().applyComparison({ kind: "worktree" }, summary());
  lookup.resolve([xref()]); await pending;
  equal(useXrefStore.getState().open, false); equal(pane(), null); equal(reads().length, 0);
});

void run();
