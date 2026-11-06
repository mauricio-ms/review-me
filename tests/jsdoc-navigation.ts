import { afterEach, assert, beforeEach, calls, deferred, equal, mock, run, test, waitFor } from "./support";
import { openFile, repoFixture, resetState } from "./fixtures";
import { forceParsing, LanguageDescription } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { jsdocHighlight } from "../src/editor/jsdoc";
import { languages } from "../src/editor/languages";
import { occurrenceHighlight } from "../src/editor/occurrences";
import { viewerKeymap } from "../src/editor/viewer-keymap";
import { xrefClick } from "../src/editor/xref-click";
import { goBack } from "../src/lib/history";
import { positionOf, registerFileView } from "../src/lib/project-view";
import { symbolOccurrences } from "../src/lib/tauri";
import { gotoDefinition } from "../src/lib/xref";
import { useFilesStore } from "../src/state/files";
import { useWindowStore } from "../src/state/windows";
import type { ProjectSource } from "../src/types/repo";
import type { Occurrences } from "../src/types/xref";

let view: EditorView | null = null;
let origin: ReturnType<typeof openFile> | null = null;
const doc = '/** @param {User} user @returns {Other} */\nfunction greet(user) {}\n// User\nconst message = "User";';
const result = { file: "types.js", line: 2, col: 7, snippet: "class User {}", kind: "definition", symbolKind: "class", confirmed: true };
beforeEach(() => { resetState(); repoFixture(); });
afterEach(() => {
  if (origin) registerFileView(1, origin.id, null);
  view?.destroy(); view = null; origin = null;
  document.querySelectorAll(".jsdoc-navigation-fixture").forEach(n => n.remove());
});
async function setup(source: ProjectSource = { kind: "worktree" }, occurrences = false) {
  origin = openFile("main.js", source);
  useFilesStore.getState().update(origin.id, { content: doc });
  useWindowStore.getState().show(1, origin.id);
  const parent = document.body.appendChild(document.createElement("div"));
  parent.className = "project-viewer jsdoc-navigation-fixture";
  parent.dataset.window = "1";
  const lang = LanguageDescription.matchFilename(languages, "main.js"); assert(lang);
  view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [
    await lang.load(), jsdocHighlight, viewerKeymap, xrefClick, EditorState.readOnly.of(true),
    ...(occurrences ? [occurrenceHighlight((line, col) => symbolOccurrences("/fixture", source, "main.js", line, col))] : []),
  ] }) });
  registerFileView(1, origin.id, view);
  forceParsing(view, doc.length, 1000);
  await waitFor(() => view?.contentDOM.querySelector(".cm-jsdoc-type"));
  return view;
}
function navigationMocks(source: ProjectSource) {
  mock("symbol_at", args => {
    equal(args.source, source); equal(args.path, "main.js"); equal(args.line, 1); equal(args.col, doc.indexOf("User"));
    return { name: "User", kind: "type", file: "main.js", line: 1, col: doc.indexOf("User") };
  });
  mock("find_definition", args => { equal(args.source, source); return [result]; });
  mock("read_file", args => { equal(args.source, source); equal(args.path, "types.js"); return "// types\nexport class User {}"; });
}

test("M-. from JSDoc navigates at the selected revision and jump-back restores the origin", async () => {
  const source: ProjectSource = { kind: "commit", oid: "c".repeat(40) };
  const v = await setup(source); navigationMocks(source);
  v.dispatch({ selection: { anchor: doc.indexOf("User") } });
  v.focus();
  v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: ".", altKey: true, bubbles: true, cancelable: true }));
  await waitFor(() => useFilesStore.getState().buffers.some(b => b.path === "types.js"));
  const target = useFilesStore.getState().buffers.find(b => b.path === "types.js"); assert(target);
  equal(target.source, source); equal(positionOf(1, target.id)?.line, 2); equal(positionOf(1, target.id)?.col, 7);
  goBack();
  equal(useWindowStore.getState().shown[1], origin!.id);
  equal(v.state.selection.main.head, doc.indexOf("User"));
});

test("Ctrl-click on a documentation type uses its source column", async () => {
  const source: ProjectSource = { kind: "worktree" };
  const v = await setup(source); navigationMocks(source);
  const coords = v.coordsAtPos(doc.indexOf("User")); assert(coords);
  v.contentDOM.dispatchEvent(new MouseEvent("mousedown", { ctrlKey: true, button: 0, clientX: coords.left + 1, clientY: (coords.top + coords.bottom)/2, bubbles: true, cancelable: true }));
  await waitFor(() => useFilesStore.getState().buffers.some(b => b.path === "types.js"));
  assert(calls.some(c => c.command === "find_definition"));
});

test("other-window definition navigation preserves the documentation buffer", async () => {
  const source: ProjectSource = { kind: "worktree" };
  const v = await setup(source); navigationMocks(source);
  v.dispatch({ selection: { anchor: doc.indexOf("User") } });
  await gotoDefinition(true);
  const ws = useWindowStore.getState();
  equal(ws.shown[1], origin!.id); assert(ws.selected !== 1);
  const target = useFilesStore.getState().buffers.find(b => b.path === "types.js"); assert(target);
  equal(ws.shown[ws.selected], target.id); equal(positionOf(ws.selected, target.id)?.col, 7);
});

test("JSDoc occurrence lookup rejects a stale reply and excludes ordinary comments and strings", async () => {
  const first = deferred<Occurrences>();
  mock("symbol_occurrences", args => args.col === doc.indexOf("User") ? first.promise : { name: "Other", spans: [{ line: 1, col: doc.indexOf("Other") }] });
  const v = await setup({ kind: "worktree" }, true);
  v.dispatch({ selection: { anchor: doc.indexOf("User") } });
  await waitFor(() => calls.some(c => c.command === "symbol_occurrences"));
  v.dispatch({ selection: { anchor: doc.indexOf("Other") } });
  await waitFor(() => v.contentDOM.querySelector(".cm-occurrence")?.textContent === "Other");
  first.resolve({ name: "User", spans: [{ line: 1, col: doc.indexOf("User") }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  equal(v.contentDOM.querySelector(".cm-occurrence")?.textContent, "Other");
  for (const pos of [doc.indexOf("// User")+3, doc.lastIndexOf("User")]) {
    const count = calls.filter(c => c.command === "symbol_occurrences").length;
    v.dispatch({ selection: { anchor: pos } });
    await new Promise(resolve => setTimeout(resolve, 180));
    equal(calls.filter(c => c.command === "symbol_occurrences").length, count);
    equal(v.contentDOM.querySelector(".cm-occurrence"), null);
  }
});

void run();
