import { afterEach, assert, beforeEach, calls, deferred, equal, mock, run, test, waitFor } from "./support";
import { commit, commitSpec, file, hunk, line, OID, openFile, repoFixture, resetState, summary } from "./fixtures";
import { createRoot, type Root } from "react-dom/client";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM, Vim, vim, type CodeMirrorV } from "@replit/codemirror-vim";
import DiffBuffer from "../src/components/DiffBuffer";
import FileView from "../src/components/FileView";
import { activeView, setProjectCursor } from "../src/lib/project-view";
import { cancelKeySequence, feedKey } from "../src/lib/key-dispatch";
import { KEYMAP } from "../src/lib/keymap";
import { useHistoryStore } from "../src/state/history";
import { useRepoStore } from "../src/state/repo";
import { useTagsStore } from "../src/state/tags";
import { useUIStore } from "../src/state/ui";
import { useWindowStore } from "../src/state/windows";

const COPY = "plugin:clipboard-manager|write_text";
let root: Root | null = null;
let parent: HTMLElement | null = null;
let extraView: EditorView | null = null;
const copied = () => calls.filter((call) => call.command === COPY).map((call) => call.args.text);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetState(); repoFixture(); cancelKeySequence("diff");
  mock(COPY, () => {});
  mock("symbol_occurrences", () => null);
});
afterEach(async () => {
  root?.unmount(); root = null;
  extraView?.destroy(); extraView = null;
  parent?.remove(); parent = null;
  await tick();
  cancelKeySequence("diff"); resetState();
});

async function mount(element: React.ReactNode) {
  parent = document.body.appendChild(document.createElement("div")); parent.className = "fixture";
  root = createRoot(parent); root.render(element);
  await tick();
}
async function diff() {
  useRepoStore.getState().setExpanded(new Set(useRepoStore.getState().diff!.files.map((f) => f.path)));
  await mount(<DiffBuffer />);
  await waitFor(() => document.querySelector(".diff-buffer"));
  document.querySelector<HTMLElement>(".diff-buffer")!.focus();
}
async function viewer(content = "one\ntwo\nthree", path = "a.txt", historical = false) {
  if (historical) repoFixture(commitSpec(), summary(commit()));
  const buffer = openFile(path, historical ? { kind: "commit", oid: OID } : { kind: "worktree" });
  buffer.content = content;
  useWindowStore.getState().show(1, buffer.id);
  await mount(<FileView win={1} bufferId={buffer.id} />);
  await waitFor(() => activeView()?.hasFocus);
  return activeView()!;
}
async function press(...keys: string[]) {
  for (const key of keys) {
    assert(document.activeElement instanceof HTMLElement);
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {
      key: key === "C-g" ? "g" : key, ctrlKey: key === "C-g", bubbles: true, cancelable: true,
    }));
    await tick();
  }
}
async function lineAt(index: number) {
  const row = document.querySelectorAll<HTMLElement>(".diff-line-row")[index]; assert(row);
  row.click(); await tick();
}

test("diff yy yanks a removed replacement line without gutters and preserves review/history", async () => {
  await diff(); await lineAt(1);
  const tags = useTagsStore.getState().flags;
  await press("y"); equal(copied(), []);
  await press("y"); await waitFor(() => copied().length === 1);
  equal(copied(), ["old\n"]);
  equal(Vim.getRegisterController().getRegister('"').toString(), "old\n");
  equal(useTagsStore.getState().flags, tags); equal(useHistoryStore.getState().back, []);
  assert(document.activeElement?.classList.contains("diff-buffer"));
  equal(document.querySelector(".is-selected .diff-line-content")?.textContent, "old");
});

test("diff counted yy counts source lines and preserves whitespace, blank lines and Unicode", async () => {
  repoFixture(undefined, summary(undefined, [file({ hunks: [hunk({ lines: [
    line("added", null, 1, "\t  λ  "), line("added", null, 2, ""), line("added", null, 3, "😀"),
  ] })] })]));
  await diff(); await lineAt(0); await press("3", "y", "y");
  await waitFor(() => copied().length === 1);
  equal(copied(), ["\t  λ  \n\n😀\n"]);
  equal(useUIStore.getState().flash, "Yanked 3 lines");
});

test("diff yank motion counts multiply and backward motions keep display order", async () => {
  await diff(); await lineAt(0); await press("y", "2", "j");
  await waitFor(() => copied().length === 1); equal(copied()[0], "text\nold\nnew\n");
  await lineAt(3); await press("2", "y", "1", "k");
  await waitFor(() => copied().length === 2); equal(copied()[1], "old\nnew\ntext\n");
});

test("diff visual y exits visual mode and returns to the beginning of a reversed selection", async () => {
  await diff(); await lineAt(2); await press("V", "k", "y");
  await waitFor(() => copied().length === 1); equal(copied(), ["old\nnew\n"]);
  assert(!document.querySelector(".diff-buffer.is-visual"));
  equal(document.querySelector(".is-selected .diff-line-content")?.textContent, "old");
});

test("diff counted visual motions and G/gg yank motions use the logical row range", async () => {
  await diff(); await lineAt(0); await press("v", "2", "j", "y");
  await waitFor(() => copied().length === 1); equal(copied()[0], "text\nold\nnew\n");
  await press("y", "G"); await waitFor(() => copied().length === 2);
  equal(copied()[1], "text\nold\nnew\ntext\n");
  await lineAt(3); await press("y", "g", "g"); await waitFor(() => copied().length === 3);
  equal(copied()[2], "text\nold\nnew\ntext\n");
});

test("diff copies hundreds of unmounted selected source rows", async () => {
  const text = Array.from({ length: 350 }, (_, i) => `source ${i + 1}`);
  repoFixture(undefined, summary(undefined, [file({ hunks: [hunk({ lines: text.map((s, i) => line("added", null, i + 1, s)) })] })]));
  await diff(); await lineAt(0);
  assert(document.querySelectorAll(".diff-line-row").length < 300, "Fixture must exercise virtualization");
  await press("3", "0", "0", "y", "y"); await waitFor(() => copied().length === 1);
  equal(copied()[0], text.slice(0, 300).join("\n") + "\n");
});

test("diff headers and cross-file selections do not overwrite the clipboard", async () => {
  repoFixture(undefined, summary(undefined, [file(), file({ path: "b.ts", hunks: [hunk({ id: "h2" })] })]));
  await diff(); await press("y", "y"); equal(copied(), []);
  equal(useUIStore.getState().flash, "No source line at cursor");
  await lineAt(0); await press("v", "G", "y"); equal(copied(), []);
  equal(useUIStore.getState().flash, "Select lines within one file");
  assert(document.querySelector(".diff-buffer.is-visual"));
});

test("diff counts stop at a file boundary and do not include folded hunks", async () => {
  repoFixture(undefined, summary(undefined, [file({ hunks: [hunk(), hunk({ id: "folded", lines: [line("added", null, 8, "hidden")] })] }), file({ path: "b.ts", hunks: [hunk({ id: "other" })] })]));
  useRepoStore.setState({ collapsedHunks: new Set(["folded"]) });
  await diff(); await lineAt(0); await press("9", "y", "y");
  await waitFor(() => copied().length === 1); equal(copied(), ["text\nold\nnew\ntext\n"]);
});

test("diff yank/count prefixes cancel with Escape, C-g, invalid input and a focus change", async () => {
  await diff(); await lineAt(1);
  for (const cancel of ["Escape", "C-g", "z"]) {
    await press("3", "y", cancel, "y"); equal(copied(), []);
    await press("y"); await waitFor(() => copied().length === 1);
    equal(copied(), ["old\n"]); calls.length = 0;
  }
  await press("y"); document.querySelector<HTMLElement>(".diff-buffer")!.blur();
  document.querySelector<HTMLElement>(".diff-buffer")!.focus();
  await press("y"); equal(copied(), []);
  await press("Escape");
  equal(feedKey("global", "C-x", KEYMAP.global).kind, "pending");
  await press("C-g"); equal(copied(), []);
});

test("viewer yy and 3yy keep Vim registers, counts, cursor and read-only contents", async () => {
  const view = await viewer("\tfirst  \n\n😀 last");
  await press("y", "y"); await waitFor(() => copied().length === 1);
  equal(copied()[0], "\tfirst  \n"); equal(view.state.selection.main.head, 0);
  await press("3", "y", "y"); await waitFor(() => copied().length === 2);
  equal(copied()[1], "\tfirst  \n\n😀 last\n");
  equal(Vim.getRegisterController().getRegister("0").toString(), copied()[1]);
  equal(view.state.doc.toString(), "\tfirst  \n\n😀 last");
});

test("viewer yw and yiw use Vim's exact character ranges", async () => {
  const view = await viewer("alpha beta\nnext");
  await press("y", "w"); await waitFor(() => copied().length === 1); equal(copied()[0], "alpha ");
  setProjectCursor(1, 7); await press("y", "i", "w");
  await waitFor(() => copied().length === 2); equal(copied()[1], "beta");
  equal(view.state.doc.toString(), "alpha beta\nnext");
});

test("viewer multiplies operator/motion counts and handles backwards line motions", async () => {
  await viewer("one\ntwo\nthree\nfour\nfive\nsix");
  await press("2", "y", "2", "j"); await waitFor(() => copied().length === 1);
  equal(copied()[0], "one\ntwo\nthree\nfour\nfive\n");
  setProjectCursor(3); await press("y", "k"); await waitFor(() => copied().length === 2);
  equal(copied()[1], "two\nthree\n");
});

test("viewer visual y includes the final selected character and ends visual mode", async () => {
  const view = await viewer("alpha beta");
  await press("v", "l", "l", "y"); await waitFor(() => copied().length === 1);
  equal(copied()[0], "alp");
  equal((getCM(view) as CodeMirrorV).state.vim.visualMode, false);
  setProjectCursor(1, 7); await press("v", "h", "h", "y");
  await waitFor(() => copied().length === 2); equal(copied()[1], " be");
});

test("viewer linewise visual y excludes the next line and normalizes the last line", async () => {
  await viewer("one\ntwo\nlast");
  await press("V", "j", "y"); await waitFor(() => copied().length === 1);
  equal(copied()[0], "one\ntwo\n");
  setProjectCursor(3); await press("V", "y"); await waitFor(() => copied().length === 2);
  equal(copied()[1], "last\n");
});

test("viewer yanks historical Markdown source rather than rendered text", async () => {
  const view = await viewer("**old revision**\nsecond", "readme.md", true);
  await press("y", "y"); await waitFor(() => copied().length === 1);
  equal(copied(), ["**old revision**\n"]); equal(view.state.doc.toString(), "**old revision**\nsecond");
  assert(!calls.some((call) => call.command === "read_file"));
});

test("viewer registers remain usable, black-hole yanks stay private, and + uses native copy", async () => {
  await viewer("one\ntwo");
  await press('"', "a", "y", "y"); await waitFor(() => copied().length === 1);
  equal(Vim.getRegisterController().getRegister("a").toString(), "one\n");
  setProjectCursor(2); await press('"', "_", "y", "y"); equal(copied().length, 1);
  await press('"', "+", "y", "y"); await waitFor(() => copied().length === 2);
  equal(copied()[1], "two\n"); equal(Vim.getRegisterController().getRegister("+").toString(), "two\n");
});

test("viewer cancelled operators and insert-mode typing never write the clipboard", async () => {
  const view = await viewer("one\ntwo");
  await press("y", "Escape", "j"); equal(copied(), []);
  await press("y", "C-g", "k"); equal(copied(), []);
  // Modal editors use editable CodeMirror and must retain ordinary Vim registers.
  const host = parent!.appendChild(document.createElement("div"));
  extraView = new EditorView({ parent: host, state: EditorState.create({ doc: "modal text", extensions: [vim()] }) });
  const cm = getCM(extraView); assert(cm);
  Vim.handleKey(cm, "y", "user"); Vim.handleKey(cm, "y", "user"); await tick();
  equal(copied(), []); equal(Vim.getRegisterController().getRegister('"').toString(), "modal text\n");
  Vim.handleKey(cm, "i", "user");
  extraView.dispatch({ changes: { from: 0, insert: "y" } }); await tick();
  equal(copied(), []); equal(extraView.state.doc.toString(), "ymodal text");
  equal(view.state.doc.toString(), "one\ntwo");
});

test("two windows showing one file yank their own cursors and selections", async () => {
  const buffer = openFile("shared.txt");
  useWindowStore.getState().show(1, buffer.id);
  const other = useWindowStore.getState().split(1, "row", buffer.id);
  useWindowStore.getState().select(1);
  await mount(<><FileView win={1} bufferId={buffer.id} /><FileView win={other} bufferId={buffer.id} /></>);
  await waitFor(() => activeView()?.hasFocus);
  setProjectCursor(2); await press("y", "y"); await waitFor(() => copied().length === 1);
  equal(copied()[0], "two\n");
  useWindowStore.getState().select(other); await waitFor(() => activeView()?.hasFocus);
  await press("v", "l", "y"); await waitFor(() => copied().length === 2);
  equal(copied()[1], "on");
  useWindowStore.getState().select(1); await waitFor(() => activeView()?.hasFocus);
  await press("y", "y"); await waitFor(() => copied().length === 3);
  equal(copied()[2], "two\n");
});

test("native clipboard failures are reported, queued writes stay ordered and later yanks recover", async () => {
  const first = deferred<void>(); const second = deferred<void>();
  mock(COPY, () => copied().length === 1 ? first.promise : copied().length === 2 ? second.promise : undefined);
  await viewer("one\ntwo\nthree");
  await press("y", "y"); await waitFor(() => copied().length === 1);
  setProjectCursor(2); await press("y", "y"); equal(copied(), ["one\n"]);
  first.resolve(); await waitFor(() => copied().length === 2); equal(copied(), ["one\n", "two\n"]);
  second.reject("clipboard unavailable"); await waitFor(() => useUIStore.getState().flash?.includes("clipboard unavailable"));
  setProjectCursor(3); await press("y", "y"); await waitFor(() => copied().length === 3);
  await waitFor(() => useUIStore.getState().flash === "Yanked 1 line"); equal(copied()[2], "three\n");
});

test("late clipboard replies do not overwrite a newer repository's echo", async () => {
  const pending = deferred<void>(); mock(COPY, () => pending.promise);
  await viewer(); await press("y", "y"); await waitFor(() => copied().length === 1);
  repoFixture(); useUIStore.getState().showFlash("New repository");
  pending.resolve(); await tick(); equal(useUIStore.getState().flash, "New repository");
});

void run();
