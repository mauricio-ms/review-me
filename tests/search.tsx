import { afterEach, assert, beforeEach, equal, mock, run, test, waitFor } from "./support";
import { file, hunk, line, openFile, repoFixture, resetState, summary } from "./fixtures";
import { createRoot, type Root } from "react-dom/client";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import { EditorState, Prec, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import AppShell from "../src/components/AppShell";
import { activeView } from "../src/lib/project-view";
import { openHelp, showBuffer, showDiff } from "../src/lib/buffers";
import { splitWindow } from "../src/lib/windows";
import { compileSwiper, nextSwiperHit } from "../src/lib/swiper";
import { useLogStore } from "../src/state/log";
import { useMinibufferStore } from "../src/state/minibuffer";
import { useProjectStore } from "../src/state/project";
import { useRepoStore } from "../src/state/repo";
import { useSearchStore } from "../src/state/search";
import { useUIStore } from "../src/state/ui";
import { useWindowStore } from "../src/state/windows";
import type { CommitInfo } from "../src/types/repo";

let root: Root | null = null;
let parent: HTMLDivElement | null = null;
beforeEach(() => {
  resetState(); repoFixture();
  useProjectStore.setState({ treeHidden: true });
  mock("symbol_occurrences", () => null);
  mock("list_repo_dir", ({ path }) => ({ path, entries: [] }));
  mock("list_recent_repos", () => []);
  mock("list_commits", () => ({ range: { kind: "all" }, commits: [] }));
  mock("commit_reviews", () => []);
  mock("log_coverage", () => ({ total: 0, reviewed: 0, flagged: 0, ignored: 0 }));
});
afterEach(() => {
  root?.unmount(); root = null; parent?.remove(); parent = null;
  resetState();
  equal(CSS.highlights.has("swiper-match"), false);
  equal(CSS.highlights.has("swiper-current"), false);
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
async function search(query: string) {
  key("s", { ctrlKey: true });
  await waitFor(() => document.activeElement?.id === "swiper-input");
  type(query);
  await waitFor(() => document.querySelector(".swiper-row.is-selected .mb-match")?.textContent === query);
  key("Enter");
  await waitFor(() => useMinibufferStore.getState().request === null && document.activeElement?.id !== "swiper-input");
}
async function ex(command: string) {
  key(":", { shiftKey: true });
  await waitFor(() => document.activeElement?.id === "minibuffer-input" && document.querySelector(".mb-prompt")?.textContent === ":");
  type(command); key("Enter");
  await waitFor(() => useMinibufferStore.getState().request === null && document.activeElement?.id !== "minibuffer-input");
}
async function nativeSearch(query: string, backwards = false) {
  key(backwards ? "?" : "/", { shiftKey: backwards });
  await waitFor(() => document.activeElement instanceof HTMLInputElement && document.activeElement.id !== "minibuffer-input");
  type(query); key("Enter", { keyCode: 13 });
  await waitFor(() => activeView()?.hasFocus && useSearchStore.getState().query === query);
}
async function fileView(content = "needle needle\nnothing\nneedle") {
  const buffer = openFile("search.txt"); buffer.content = content;
  useWindowStore.getState().show(1, buffer.id);
  await mount(); await waitFor(() => activeView()?.hasFocus);
  return activeView()!;
}
const cursor = () => activeView()!.state.selection.main.head;
const marks = () => document.querySelectorAll(".cm-swiper-match").length;
const cssTexts = () => ["swiper-match", "swiper-current"].flatMap((name) =>
  [...(CSS.highlights.get(name) ?? [])].map((range) => range.toString()));
const logHighlighted = () => ["swiper-match", "swiper-current"].some((name) =>
  [...(CSS.highlights.get(name) ?? [])].some((range) => range.startContainer.parentElement?.closest(".log-buffer")));

test("search repeats keep multi-word occurrences together, support zero-width queries and counts", () => {
  const matcher = compileSwiper("foo bar"); assert(matcher);
  equal(nextSwiperHit(["foo bar foo bar", "foo bar"], matcher, { index: 0, column: 0 }, { direction: 1 }, true),
    { index: 0, spans: [[8, 15]] });
  equal(nextSwiperHit(["foo bar foo bar", "foo bar"], matcher, { index: 0, column: 0 }, { direction: -1, count: 4 }, true),
    { index: 1, spans: [[0, 7]] });
  const zero = compileSwiper("^"); assert(zero);
  equal(nextSwiperHit(["a", "b"], zero, { index: 0, column: 0 }, { direction: 1 }, true), { index: 1, spans: [[0, 0]] });
  equal(nextSwiperHit(["nothing"], matcher, { index: 0, column: 0 }, { direction: 1 }), null);
});

test("accepted file searches stay highlighted; n / N visit occurrences, wrap, and honor Vim counts", async () => {
  await fileView();
  await search("needle");
  equal(cursor(), 0); await waitFor(() => marks() === 3);
  key("n"); await waitFor(() => cursor() === 7);
  key("n"); await waitFor(() => cursor() === 22);
  key("n"); await waitFor(() => cursor() === 0);
  key("N", { shiftKey: true }); await waitFor(() => cursor() === 22);
  key("2"); key("n"); await waitFor(() => cursor() === 7);
  equal(useMinibufferStore.getState().request, null);
});

test(":noh and :nohlsearch hide marks; repeating restores them and cancelling preserves the accepted query", async () => {
  await fileView(); await search("needle");
  await ex("noh"); await waitFor(() => activeView()?.hasFocus && marks() === 0);
  equal(useSearchStore.getState().query, "needle");
  key("n"); await waitFor(() => cursor() === 7 && marks() === 3);
  key("s", { ctrlKey: true }); await waitFor(() => document.activeElement?.id === "swiper-input");
  type("nothing"); await waitFor(() => cursor() === 14);
  key("Escape"); await waitFor(() => activeView()?.hasFocus && cursor() === 7 && marks() === 3);
  equal(useSearchStore.getState().query, "needle");
  await ex("nohlsearch"); await waitFor(() => activeView()?.hasFocus && marks() === 0);
  key("N", { shiftKey: true }); await waitFor(() => cursor() === 0 && marks() === 3);
});

test("Vim insert mode keeps colon, n and N literal and Esc leaves search highlights intact", async () => {
  const view = await fileView(); await search("needle");
  view.dispatch({ effects: StateEffect.appendConfig.of(Prec.highest(EditorState.readOnly.of(false))) });
  const cm = getCM(view); assert(cm);
  Vim.handleKey(cm, "i", "user");
  assert(cm.state.vim?.insertMode, "Insert mode was not entered");
  key("n"); key("N", { shiftKey: true }); equal(cursor(), 0);
  key(":", { shiftKey: true }); equal(useMinibufferStore.getState().request, null);
  key("Escape"); await waitFor(() => !cm.state.vim?.insertMode);
  assert(useSearchStore.getState().visible, "Exiting insert mode cleared search highlights");
  key("v"); assert(cm.state.vim?.visualMode);
  key("Escape"); await waitFor(() => !cm.state.vim?.visualMode);
  assert(useSearchStore.getState().visible, "Exiting visual mode cleared search highlights");
  key("Escape"); equal(useSearchStore.getState().visible, true); equal(marks(), 3);
  key("g", { ctrlKey: true }); equal(useSearchStore.getState().visible, true);
});

test("cancelled and invalid colon commands preserve highlights; M-x has no search-clear command", async () => {
  await fileView(); await search("needle");
  key(":", { shiftKey: true }); await waitFor(() => document.activeElement?.id === "minibuffer-input");
  type("noh"); key("Escape"); await waitFor(() => activeView()?.hasFocus);
  equal(marks(), 3); equal(useSearchStore.getState().query, "needle");
  key(":", { shiftKey: true }); await waitFor(() => document.activeElement?.id === "minibuffer-input");
  type("nohlsearch"); key("g", { ctrlKey: true }); await waitFor(() => activeView()?.hasFocus);
  equal(marks(), 3);
  await ex(""); equal(marks(), 3);
  await ex("no"); equal(useUIStore.getState().flash, "Not an editor command: no"); equal(marks(), 3);
  await ex("quit"); equal(useUIStore.getState().flash, "Not an editor command: quit"); equal(marks(), 3);
  key("x", { altKey: true }); await waitFor(() => document.activeElement?.id === "minibuffer-input");
  type("search-clear"); await waitFor(() => document.querySelector(".mb-empty")?.textContent === "[No match]");
  key("Escape"); await waitFor(() => activeView()?.hasFocus);
  await ex("nohl"); await waitFor(() => marks() === 0);
});

test("Vim word searches share persistent highlights and repeat navigation with Swiper", async () => {
  await fileView(); await search("needle");
  key("*"); await waitFor(() => cursor() === 7);
  await waitFor(() => useSearchStore.getState().query === "\\bneedle\\b");
  key("n"); await waitFor(() => cursor() === 22);
  key("N", { shiftKey: true }); await waitFor(() => cursor() === 7);
  await waitFor(() => marks() === 3);
  key("Escape"); equal(marks(), 3);
  await ex("noh"); await waitFor(() => marks() === 0 && !document.querySelector(".cm-searchMatch"));
  key("n"); await waitFor(() => cursor() === 22 && marks() === 3);
});

test("a Vim search stays active across files and diffs while the log ignores it", async () => {
  repoFixture(undefined, summary(undefined, [file({ hunks: [hunk({ lines: [line("added", null, 1, "needle diff")] })] })]));
  const view = await fileView(); const buffer = useWindowStore.getState().shown[1];
  await nativeSearch("needle"); await waitFor(() => marks() === 3);
  showDiff(); await waitFor(() => document.activeElement?.classList.contains("diff-buffer"));
  assert(useSearchStore.getState().visible);
  key("n"); await waitFor(() => useUIStore.getState().diffCursor?.line === 1);
  await waitFor(() => cssTexts().includes("needle"));
  const commits: CommitInfo[] = ["needle first", "needle last"].map((text, index) => ({
    oid: String(index + 1).repeat(40), shortOid: String(index + 1).repeat(7), summary: text,
    authorName: "Ada", timestamp: 1, parentCount: 1, isMerge: false, isHead: index === 0, refs: [],
  }));
  useLogStore.getState().setPage("refs/heads/main", null, { kind: "all" }, commits, true);
  showBuffer("log"); await waitFor(() => document.activeElement?.classList.contains("log-buffer"));
  equal(document.querySelectorAll(".log-row").length, 2); equal(logHighlighted(), false);
  key("n"); equal(useUIStore.getState().flash, "No previous log search");
  equal(document.querySelector(".log-row.is-selected .log-summary")?.textContent, "needle first");
  equal(useSearchStore.getState().query, "needle"); assert(useSearchStore.getState().visible);
  showDiff(); await waitFor(() => document.activeElement?.classList.contains("diff-buffer"));
  await ex("noh"); await waitFor(() => cssTexts().length === 0 && !document.querySelector(".cm-searchMatch"));
  equal(useSearchStore.getState().visible, false);
  showBuffer(buffer); await waitFor(() => activeView()?.hasFocus && activeView() !== view);
  equal(marks(), 0); equal(useSearchStore.getState().query, "needle");
  key("n"); await waitFor(() => marks() === 3);
});

test("Vim regex syntax, smart case and backward search direction survive a buffer switch", async () => {
  await fileView("Needle\nneedle\nNeedle");
  activeView()!.dispatch({ selection: { anchor: 14 } });
  await nativeSearch("N[e]+dle", true);
  equal(cursor(), 0); equal(useSearchStore.getState().direction, -1);
  key("n"); await waitFor(() => cursor() === 14);
  key("N", { shiftKey: true }); await waitFor(() => cursor() === 0);
  await waitFor(() => marks() === 2);
  const other = openFile("other.txt"); other.content = "Needle\nneedle\nNeedle";
  showBuffer(other.id); await waitFor(() => activeView()?.hasFocus && activeView()?.state.doc.toString() === other.content);
  await waitFor(() => marks() === 2);
  key("n"); await waitFor(() => cursor() === 14);
});

test("cancelled native searches preserve the accepted query and its highlights", async () => {
  await fileView(); await search("needle");
  key("/"); await waitFor(() => document.activeElement instanceof HTMLInputElement);
  type("nothing"); key("Escape", { keyCode: 27 });
  await waitFor(() => activeView()?.hasFocus);
  equal(useSearchStore.getState().query, "needle"); equal(marks(), 3);
  const view = activeView()!;
  view.dispatch({ changes: { from: view.state.doc.length, insert: "\n" }, selection: { anchor: view.state.doc.length + 1 } });
  key("*");
  await waitFor(() => document.querySelector(".cm-vim-message")?.textContent === "No word under cursor");
  equal(useSearchStore.getState().query, "needle"); equal(marks(), 3);
  view.dispatch({ selection: { anchor: 0 } });
  key("n"); await waitFor(() => cursor() === 7);
  key("/"); await waitFor(() => document.activeElement instanceof HTMLInputElement);
  type("["); key("Enter", { keyCode: 13 });
  await waitFor(() => document.querySelector(".cm-vim-message")?.textContent?.startsWith("Invalid regex:"));
  equal(useSearchStore.getState().query, "needle"); equal(marks(), 3);
});

test(":noh works from help, the project tree, an empty project buffer and the start screen", async () => {
  await fileView("search search"); await search("search");
  openHelp("viewer", false); await waitFor(() => document.activeElement?.classList.contains("help-buffer"));
  await waitFor(() => cssTexts().some((text) => text.toLowerCase() === "search"));
  key("n"); await ex("noh"); await waitFor(() => cssTexts().length === 0);
  equal(useSearchStore.getState().visible, false);
  useSearchStore.getState().accept("search");
  useProjectStore.setState({ treeHidden: false });
  useWindowStore.getState().show(1, "project");
  useWindowStore.getState().setTreeFocused(true);
  await waitFor(() => document.activeElement?.classList.contains("project-tree"));
  await ex("nohlsearch"); equal(useSearchStore.getState().visible, false);
  useSearchStore.getState().accept("search");
  useWindowStore.getState().setTreeFocused(false);
  document.querySelector<HTMLElement>(".app-shell")!.focus();
  await ex("noh"); equal(useSearchStore.getState().visible, false);
  useRepoStore.getState().closeRepo();
  await waitFor(() => document.querySelector(".startup-dashboard"));
  useSearchStore.getState().accept("search");
  document.querySelector<HTMLElement>(".app-shell")!.focus();
  await ex("noh"); equal(useSearchStore.getState().visible, false);
});

test("project repeat navigation reuses the match index and invalidates it on text or query changes", async () => {
  const count = 12000;
  const view = await fileView(Array.from({ length: count }, (_, i) => `needle ${i}`).join("\n"));
  useSearchStore.getState().accept("needle");
  const matcher = useSearchStore.getState().matcher!;
  const occurrences = matcher.occurrences;
  let scanned = 0;
  matcher.occurrences = (line) => { scanned++; return occurrences(line); };
  key("n"); equal(view.state.doc.lineAt(cursor()).number, 2);
  equal(scanned, count);
  for (let i = 0; i < 20; i++) key("n");
  equal(view.state.doc.lineAt(cursor()).number, 22); equal(scanned, count);
  key("N", { shiftKey: true }); equal(view.state.doc.lineAt(cursor()).number, 21); equal(scanned, count);
  useSearchStore.getState().accept("^needle 30$");
  key("n"); equal(view.state.doc.lineAt(cursor()).number, 31);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "needle 30\nneedle 30" }, selection: { anchor: 0 } });
  key("n"); equal(cursor(), 10);
});

test("search highlights follow split project windows and clearing from another buffer stays cleared", async () => {
  await fileView(); await nativeSearch("needle");
  splitWindow("row"); await waitFor(() => document.querySelectorAll(".project-viewer .cm-editor").length === 2);
  await waitFor(() => marks() === 6);
  openHelp("viewer", false); await waitFor(() => document.activeElement?.classList.contains("help-buffer"));
  await ex("noh");
  key("q"); await waitFor(() => document.querySelectorAll(".project-viewer .cm-editor").length === 2);
  equal(marks(), 0); equal(useSearchStore.getState().visible, false);
});

test("clearing from a neighboring diff clears a live project view and rejects late native highlights", async () => {
  const view = await fileView(); await nativeSearch("needle");
  const cm = getCM(view); assert(cm);
  showDiff({ other: true });
  await waitFor(() => document.activeElement?.classList.contains("diff-buffer") && view.dom.isConnected);
  await ex("noh"); await waitFor(() => marks() === 0);
  // Vim's delayed renderer may still submit a native overlay after :noh.
  cm.addOverlay({ query: /needle/i });
  await waitFor(() => !document.querySelector(".cm-searchMatch"));
  equal(useSearchStore.getState().visible, false); equal(marks(), 0);
});

test("the project tree highlights and repeats the shared search without taking focus from the tree", async () => {
  repoFixture(undefined, summary(undefined, ["needle-a.ts", "needle-b.ts"].map((path) => file({ path, hunks: [hunk({ id: path })] }))));
  mock("read_file", () => "needle");
  await fileView(); await search("needle");
  useProjectStore.setState({ treeHidden: false });
  useWindowStore.getState().setTreeFocused(true);
  await waitFor(() => document.activeElement?.classList.contains("project-tree"));
  await waitFor(() => cssTexts().filter((text) => text === "needle").length >= 2);
  key("n"); await waitFor(() => useProjectStore.getState().treeCursor === "needle-b.ts");
  key("N", { shiftKey: true }); await waitFor(() => useProjectStore.getState().treeCursor === "needle-a.ts");
  assert(document.activeElement?.classList.contains("project-tree"));
  await ex("noh"); await waitFor(() => cssTexts().length === 0 && marks() === 0);
});

test("a search character used by a Vim find motion does not replace the accepted query", async () => {
  await fileView("needle/needle"); await search("needle");
  key("f"); key("/"); await waitFor(() => cursor() === 6);
  equal(useSearchStore.getState().query, "needle");
  key("n"); await waitFor(() => cursor() === 7);
});

test("a colon in a Vim find motion stays literal and a cancelled Vim prefix cannot clear a search", async () => {
  await fileView("needle:needle"); await search("needle");
  key("f"); key(":", { shiftKey: true }); await waitFor(() => cursor() === 6);
  equal(useMinibufferStore.getState().request, null); equal(useSearchStore.getState().visible, true);
  key("g"); key("Escape"); equal(marks(), 2);
  await ex("noh"); await waitFor(() => marks() === 0);
  key("n"); await waitFor(() => cursor() === 7 && marks() === 2);
});

test("global Vim mappings preserve native search in note and commit editors", async () => {
  await fileView(); await search("needle");
  const host = document.body.appendChild(document.createElement("div"));
  const editor = new EditorView({ parent: host, state: EditorState.create({ doc: "other other other", extensions: [vim()] }) });
  try {
    const cm = getCM(editor); assert(cm);
    Vim.handleKey(cm, "*", "user"); equal(editor.state.selection.main.head, 6);
    Vim.handleKey(cm, "n", "user"); equal(editor.state.selection.main.head, 12);
    Vim.handleKey(cm, "N", "user"); equal(editor.state.selection.main.head, 6);
    Vim.handleKey(cm, "<Esc>", "user");
    equal(cursor(), 0); assert(useSearchStore.getState().visible);
  } finally { editor.destroy(); host.remove(); }
});

test("file repeats use the live cursor, new buffers, and report missing matches", async () => {
  const view = await fileView(); await search("needle");
  view.dispatch({ selection: { anchor: 15 } });
  key("N", { shiftKey: true }); await waitFor(() => cursor() === 7);
  const buffer = openFile("different.txt"); buffer.content = "no matches here";
  useWindowStore.getState().show(1, buffer.id);
  await waitFor(() => activeView()?.state.doc.toString() === buffer.content && activeView()?.hasFocus);
  key("n"); equal(cursor(), 0); equal(useUIStore.getState().flash, "No match: needle");
  equal(document.querySelector(".cm-swiper-line"), null);
});

test("file repeats traverse visible deleted lines, then skip them when changed mode is disabled", async () => {
  repoFixture(undefined, summary(undefined, [file({ hunks: [hunk({ lines: [
    line("removed", 1, null, "needle old"), line("added", null, 1, "needle new"),
  ], oldStart: 1, newStart: 1, oldLines: 1, newLines: 1 })] })]));
  const buffer = openFile(); buffer.content = "needle new\nneedle last";
  useWindowStore.getState().show(1, buffer.id);
  await mount(); await waitFor(() => activeView()?.hasFocus && document.querySelector(".cm-diff-removed-line"));
  await search("needle");
  key("N", { shiftKey: true });
  await waitFor(() => document.querySelector(".cm-diff-removed-line.cm-swiper-line"));
  key("n"); await waitFor(() => !document.querySelector(".cm-diff-removed-line.cm-swiper-line"));
  equal(cursor(), 0);
  useProjectStore.setState({ filter: "all" });
  await waitFor(() => !document.querySelector(".cm-diff-removed-line"));
  key("N", { shiftKey: true }); await waitFor(() => cursor() === 11);
});

test("diff repeats reveal folded matches, follow manual moves and keep CSS highlights until cleared", async () => {
  const changed = (path: string, content: string) => file({ path, hunks: [hunk({ id: path, lines: [line("added", null, 1, content)] })] });
  repoFixture(undefined, summary(undefined, [changed("a.ts", "needle first"), changed("b.ts", "needle second")]));
  await mount(); await waitFor(() => document.querySelector(".diff-buffer"));
  document.querySelector<HTMLElement>(".diff-buffer")!.focus();
  key("n"); equal(useUIStore.getState().flash, "No previous search");
  await search("needle"); await waitFor(() => useUIStore.getState().diffCursor?.path === "a.ts");
  assert(cssTexts().some((text) => text === "needle"));
  key("n"); await waitFor(() => useUIStore.getState().diffCursor?.path === "b.ts");
  assert(useRepoStore.getState().expandedFiles.has("b.ts"));
  key("n"); await waitFor(() => useUIStore.getState().diffCursor?.path === "a.ts");
  key("N", { shiftKey: true }); await waitFor(() => useUIStore.getState().diffCursor?.path === "b.ts");
  key("Escape"); assert(cssTexts().some((text) => text === "needle"));
  key("g", { ctrlKey: true }); assert(useSearchStore.getState().visible);
  await ex("noh"); await waitFor(() => cssTexts().length === 0);
  key("g"); key("g"); await waitFor(() => useUIStore.getState().diffCursor?.path == null);
  key("n"); await waitFor(() => useUIStore.getState().diffCursor?.path === "a.ts");
  assert(cssTexts().some((text) => text === "needle"));
  // Cancelling a pending prefix leaves the cursor in place.
  key("g"); key("Escape");
  equal(useUIStore.getState().diffCursor?.path, "a.ts");
});

test("log searches and repeats use current subjects without affecting the global term or highlights", async () => {
  const commits: CommitInfo[] = ["needle first", "other", "needle last"].map((text, index) => ({
    oid: String(index + 1).repeat(40), shortOid: String(index + 1).repeat(7), summary: text,
    authorName: "Ada", timestamp: 1, parentCount: 1, isMerge: false, isHead: index === 0, refs: [],
  }));
  useLogStore.getState().setPage("refs/heads/main", null, { kind: "all" }, commits, true);
  useSearchStore.getState().acceptNative(/other/i, true);
  useSearchStore.getState().clear();
  const global = useSearchStore.getState();
  useWindowStore.getState().show(1, "log");
  await mount(); await waitFor(() => document.querySelector(".log-buffer"));
  document.querySelector<HTMLElement>(".log-buffer")!.focus();
  await search("needle");
  equal(logHighlighted(), false);
  equal(useSearchStore.getState().query, "other"); equal(useSearchStore.getState().visible, false);
  equal(useSearchStore.getState().direction, -1); assert(useSearchStore.getState().matcher === global.matcher);
  const selected = () => document.querySelector(".log-row.is-selected .log-summary")?.textContent;
  key("n"); await waitFor(() => selected() === "needle last");
  const extra = { ...commits[0], oid: "4".repeat(40), shortOid: "4444444", summary: "needle new" };
  useLogStore.getState().appendPage([extra], true);
  await waitFor(() => document.querySelectorAll(".log-row").length === 4);
  key("n"); await waitFor(() => selected() === "needle new");
  key("n"); await waitFor(() => selected() === "needle first");
  key("N", { shiftKey: true }); await waitFor(() => selected() === "needle new");
  equal(document.querySelectorAll(".log-row").length, 4); equal(logHighlighted(), false);
  key("Escape"); equal(logHighlighted(), false);
  key("g", { ctrlKey: true }); equal(useSearchStore.getState().visible, false);
  await ex("nohlsearch"); await waitFor(() => cssTexts().length === 0);
  equal(selected(), "needle new"); equal(useSearchStore.getState().query, "other");
  key("n"); await waitFor(() => selected() === "needle first");
  equal(logHighlighted(), false); equal(useSearchStore.getState().visible, false);
  assert(useSearchStore.getState().matcher === global.matcher);
});

test("colon text begins immediately after the prompt while ordinary minibuffer spacing is preserved", async () => {
  await fileView();
  key(":", { shiftKey: true }); await waitFor(() => document.activeElement?.id === "minibuffer-input");
  type("noh");
  const gap = () => document.querySelector<HTMLInputElement>(".mb-input")!.getBoundingClientRect().left -
    document.querySelector(".mb-prompt")!.getBoundingClientRect().right;
  equal(gap(), 0); equal(document.querySelector<HTMLInputElement>(".mb-input")!.value, "noh");
  key("Escape"); await waitFor(() => activeView()?.hasFocus);
  key("x", { altKey: true }); await waitFor(() => document.activeElement?.id === "minibuffer-input");
  assert(gap() > 0);
});

test("each commit picker starts empty and never recalls or replaces another buffer's search", async () => {
  const commits: CommitInfo[] = ["needle first", "other", "needle last"].map((text, index) => ({
    oid: String(index + 1).repeat(40), shortOid: String(index + 1).repeat(7), summary: text,
    authorName: "Ada", timestamp: 1, parentCount: 1, isMerge: false, isHead: index === 0, refs: [],
  }));
  useLogStore.getState().setPage("refs/heads/main", null, { kind: "all" }, commits, true);
  const view = await fileView("other other"); const buffer = useWindowStore.getState().shown[1];
  await search("other");
  const global = useSearchStore.getState();
  showBuffer("log"); await waitFor(() => document.activeElement?.classList.contains("log-buffer"));
  equal(document.querySelectorAll(".log-row").length, 3); equal(logHighlighted(), false);
  key("s", { ctrlKey: true }); await waitFor(() => document.activeElement?.id === "swiper-input");
  equal(document.querySelector<HTMLInputElement>("#swiper-input")!.value, "");
  equal(document.querySelectorAll(".swiper-row").length, 3);
  key("s", { ctrlKey: true });
  equal(document.querySelector<HTMLInputElement>("#swiper-input")!.value, "");
  type("needle"); await waitFor(() => document.querySelectorAll(".swiper-row").length === 2);
  equal(document.querySelectorAll(".log-row").length, 3); equal(logHighlighted(), false);
  key("Enter"); await waitFor(() => document.activeElement?.classList.contains("log-buffer"));
  assert(useSearchStore.getState().matcher === global.matcher); equal(useSearchStore.getState().query, "other");
  assert(useSearchStore.getState().visible);
  key("s", { ctrlKey: true }); await waitFor(() => document.activeElement?.id === "swiper-input");
  equal(document.querySelector<HTMLInputElement>("#swiper-input")!.value, "");
  equal(document.querySelectorAll(".swiper-row").length, 3);
  type("other"); key("Escape"); await waitFor(() => document.activeElement?.classList.contains("log-buffer"));
  key("n"); await waitFor(() => document.querySelector(".log-row.is-selected .log-summary")?.textContent === "needle last");
  showBuffer(buffer); await waitFor(() => activeView()?.hasFocus && activeView() !== view);
  await waitFor(() => marks() === 2); equal(useSearchStore.getState().query, "other");
  key("n"); await waitFor(() => cursor() === 6);
});

test("changing a log's scope closes its finder and resets only its local repeat query", async () => {
  const commits: CommitInfo[] = ["needle first", "needle last"].map((text, index) => ({
    oid: String(index + 1).repeat(40), shortOid: String(index + 1).repeat(7), summary: text,
    authorName: "Ada", timestamp: 1, parentCount: 1, isMerge: false, isHead: index === 0, refs: [],
  }));
  useLogStore.getState().setPage("refs/heads/main", null, { kind: "all" }, commits, true);
  useSearchStore.getState().accept("global");
  const global = useSearchStore.getState();
  showBuffer("log"); await mount(); await waitFor(() => document.activeElement?.classList.contains("log-buffer"));
  await search("needle");
  key("s", { ctrlKey: true }); await waitFor(() => document.activeElement?.id === "swiper-input");
  const pending = useMinibufferStore.getState().request; assert(pending?.kind === "swiper");
  useLogStore.getState().begin("refs/heads/other", null);
  useLogStore.getState().setPage("refs/heads/other", null, { kind: "all" }, commits, true);
  await waitFor(() => useMinibufferStore.getState().request === null && document.activeElement?.classList.contains("log-buffer"));
  pending.onAccept({ index: 1, spans: [] }, "stale");
  key("n"); equal(useUIStore.getState().flash, "No previous log search");
  equal(useSearchStore.getState().query, "global"); assert(useSearchStore.getState().matcher === global.matcher);
  assert(useSearchStore.getState().visible); equal(logHighlighted(), false);
});

void run();
