import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";

import { diffMarks, setDeletedFile, setDiffMarks, type ShownBlock } from "../src/editor/diff-marks";
import { flagDecorations, setFlagLines } from "../src/editor/flag-decorations";
import { markdownView } from "../src/editor/markdown-view";
import { swiper, swiperHighlight } from "../src/editor/swiper";
import { linkAt } from "../src/lib/markdown";
import { compileSwiper } from "../src/lib/swiper";
import { useMinibufferStore } from "../src/state/minibuffer";

const tests: Array<{ name: string; run: () => void | Promise<void> }> = [];
const test = (name: string, run: () => void | Promise<void>) => tests.push({ name, run });
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
function equal(actual: unknown, expected: unknown) {
  assert(JSON.stringify(actual) === JSON.stringify(expected),
    `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const views: EditorView[] = [];
function viewer(doc: string, extra: Extension = []) {
  const parent = document.body.appendChild(document.createElement("div"));
  parent.className = "project-viewer";
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [
      markdown({ base: markdownLanguage }), lineNumbers(), EditorView.lineWrapping,
      EditorState.readOnly.of(true), diffMarks, flagDecorations, swiperHighlight,
      markdownView, extra,
    ] }),
  });
  views.push(view);
  return view;
}
const rows = (view: EditorView) => Array.from(view.contentDOM.querySelectorAll(".cm-line"))
  .map((line) => line.textContent?.replace(/\u200b/g, ""));
const block = (patch: Partial<ShownBlock> = {}): ShownBlock => ({
  id: "test", modified: [2], added: [], removed: [], removedAt: 2,
  removedSegs: [], newSegs: new Map(), newText: new Map(), trailingRemoval: false,
  showRemoved: false, words: false, ...patch,
});

test("soft breaks flow as spaces while source positions and links stay intact", () => {
  const doc = "First **bold**\nsecond [link](https://example.com).\nthird.";
  const view = viewer(doc);
  equal(rows(view), ["First bold second link. third."]);
  equal(view.state.doc.toString(), doc);
  equal(view.state.doc.lines, 3);
  equal(linkAt(view.state, doc.indexOf("link")), "https://example.com");
});

test("explicit hard breaks keep their newlines and hide their syntax", () => {
  const view = viewer("alpha  \nbeta\\\ngamma\ndelta\n\nAnother paragraph.");
  equal(rows(view), ["alpha", "beta", "gamma delta", "", "Another paragraph."]);
});

test("formatting and code spans can cross soft breaks", () => {
  const view = viewer("A *multiline\nemphasis* and `code\nspan`, plus [a link\nlabel](https://example.com).");
  equal(rows(view), ["A multiline emphasis and code span, plus a link label."]);
  equal(view.contentDOM.querySelector(".cm-md-code")?.textContent, "code span");
  equal(view.contentDOM.querySelector(".cm-md-link")?.textContent, "a link label");
});

test("lists and tasks join continuation lines without extra markers", () => {
  const view = viewer("- First item\n  continues here.\n- [x] Second item\n  continues too.");
  equal(rows(view), ["•First item continues here.", "Second item continues too."]);
  equal(view.contentDOM.querySelectorAll(".cm-md-list-mark").length, 2);
  equal(view.contentDOM.querySelectorAll(".cm-md-task.is-done").length, 1);
});

test("nested quote and list prefixes disappear from joined lines", () => {
  const view = viewer("> > Quoted text\n> > continues.\n> >\n> > - An item\n> >   continues.");
  equal(rows(view), ["Quoted text continues.", "", "•An item continues."]);
});

test("ordered and nested lists keep one marker per item and hang hard breaks", () => {
  const view = viewer("1. First item\n   continues\n   - Nested item\n     continues  \n     after a hard break\n2. Next item\n   continues");
  equal(rows(view), ["1.First item continues", "◦Nested item continues", "after a hard break", "2.Next item continues"]);
  equal(view.contentDOM.querySelectorAll(".cm-md-list-mark").length, 4);
});

test("GitHub alert labels stay above their flowing prose", () => {
  const view = viewer("> [!NOTE]\n> First line\n> second line.");
  equal(rows(view), ["Note", "First line second line."]);
});

test("headings, code, tables, frontmatter and definitions keep their structure", () => {
  const view = viewer("---\ntitle: Sample\n---\n\n# Heading\n\n```\na\nb\n```\n\n| A | B |\n| - | - |\n| x | y |\n\n[ref]: https://example.com\n\nFlowing\nprose");
  equal(view.contentDOM.querySelectorAll(".cm-md-softbreak").length, 1);
  equal(view.contentDOM.querySelectorAll(".cm-md-table").length, 3);
  assert(rows(view).includes("a") && rows(view).includes("b"), "code lines were joined");
  equal(rows(view).at(-1), "Flowing prose");
});

test("change marks and flags retain their original source rows", () => {
  const view = viewer("First\nsecond\nthird");
  view.dispatch({ effects: setDiffMarks.of([block()]) });
  equal(rows(view), ["First", "second", "third"]);
  equal(view.contentDOM.querySelector(".cm-diff-line-modified")?.textContent, "second");
  equal(view.dom.querySelectorAll(".cm-diff-sign-modified").length, 1);
  view.dispatch({ effects: [setDiffMarks.of([]), setFlagLines.of([[2, 2]])] });
  equal(rows(view), ["First", "second", "third"]);
  equal(view.contentDOM.querySelector(".cm-flagged-line")?.textContent, "second");
  view.dispatch({ effects: setFlagLines.of([]) });
  equal(rows(view), ["First second third"]);
});

test("inspected and annotated prose uses the pane width without orphaning the last word", async () => {
  const source = [
    "tables lined up, prose in a proportional face. Source newlines within a paragraph flow",
    "as spaces; blank lines and explicit Markdown hard breaks remain. Paragraphs being inspected,",
    "searched, changed or flagged keep their source rows so line annotations stay accurate.",
    "It is still the file's text underneath — the",
  ];
  const view = viewer(`${source.join("\n")}\n\noutside`);
  view.dom.parentElement!.style.width = "1700px";
  view.dom.parentElement!.style.setProperty("--fs", "26px");
  view.dispatch({
    selection: { anchor: view.state.doc.line(2).to - 2 },
    effects: setDiffMarks.of([block({ modified: [1, 2, 3, 4], showRemoved: true })]),
  });
  view.focus();
  await settle();
  const sameVisualLine = () => {
    const line = view.state.doc.line(2);
    const first = view.coordsAtPos(line.from);
    const last = view.coordsAtPos(line.to - 2);
    assert(first && last, "source row has no layout coordinates");
    return Math.abs(first!.top - last!.top) < 1;
  };
  assert(sameVisualLine(), "the reading-width limit wrapped 'inspected,' onto an extra visual line");
  equal(rows(view), [...source, "", "outside"]);
  view.dispatch({ effects: [setDiffMarks.of([]), setFlagLines.of([[2, 2]])] });
  view.contentDOM.blur();
  await settle();
  assert(sameVisualLine(), "a flagged source row still uses the reading-width limit");
  view.dom.parentElement!.style.width = "300px";
  view.requestMeasure();
  await settle();
  assert(!sameVisualLine(), "source rows should still wrap when the pane is actually narrow");
  view.dispatch({ effects: setFlagLines.of([]) });
  equal(rows(view), [source.join(" "), "", "outside"]);
});

test("removal anchors, inline removed text and deleted files retain their rows", () => {
  const view = viewer("First\nsecond\nthird");
  view.dispatch({ effects: setDiffMarks.of([block({
    modified: [], removed: [{ kind: "removed", content: "old", oldLine: 2, newLine: null }],
    removedSegs: [null], showRemoved: true,
  })]) });
  equal(rows(view), ["First", "second", "third"]);
  equal(view.contentDOM.querySelector(".cm-diff-removed-line")?.textContent, "old");
  view.dispatch({ effects: [setDiffMarks.of([]), setDeletedFile.of(true)] });
  equal(view.contentDOM.querySelectorAll(".cm-diff-line-removed").length, 3);
  view.dispatch({ effects: setDeletedFile.of(false) });
  equal(rows(view), ["First second third"]);
});

test("focus, cursor movement, blur and line selections switch layout safely", async () => {
  const view = viewer("First\n**second**\n\noutside");
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
  view.focus();
  await settle();
  equal(rows(view), ["First", "**second**", "", "outside"]);
  view.dispatch({ selection: { anchor: view.state.doc.line(4).from } });
  equal(rows(view), ["First second", "", "outside"]);
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.line(3).from } });
  equal(rows(view), ["First", "**second**", "", "outside"]);
  view.dispatch({ selection: { anchor: 0 } });
  view.contentDOM.blur();
  await settle();
  equal(rows(view), ["First second", "", "outside"]);
});

test("Swiper preserves the matched source row while the minibuffer has focus", async () => {
  const view = viewer("First\nsecond match\nthird\n\noutside");
  swiper(view);
  const request = useMinibufferStore.getState().request;
  if (request?.kind !== "swiper") throw new Error("Swiper did not open");
  request.onMove({ index: 1, spans: [[7, 12]] }, compileSwiper("match"));
  await settle();
  equal(rows(view), ["First", "second match", "third", "", "outside"]);
  equal(view.contentDOM.querySelector(".cm-swiper-line")?.textContent, "second match");
  request.onCancel();
  useMinibufferStore.getState().close();
  equal(rows(view), ["First second match third", "", "outside"]);
});

test("Vim motions and visual selection still use source line numbers", async () => {
  const view = viewer("First\nsecond\nthird\n\noutside", vim());
  view.focus();
  await settle();
  const cm = getCM(view)!;
  Vim.handleKey(cm, "j", "user");
  equal(view.state.doc.lineAt(view.state.selection.main.head).number, 2);
  Vim.handleKey(cm, "V", "user");
  Vim.handleKey(cm, "j", "user");
  const selection = view.state.selection.main;
  equal(view.state.doc.lineAt(selection.from).number, 2);
  equal(view.state.doc.lineAt(selection.to).number, 3);
  equal(rows(view), ["First", "second", "third", "", "outside"]);
});

test("raw markup toggling and document refresh rebuild paragraph flow", () => {
  const compartment = new Compartment();
  const parent = document.body.appendChild(document.createElement("div"));
  parent.className = "project-viewer";
  const view = new EditorView({ parent, doc: "one\ntwo", extensions: [
    markdown({ base: markdownLanguage }), compartment.of(markdownView), EditorView.lineWrapping,
  ] });
  views.push(view);
  equal(rows(view), ["one two"]);
  view.dispatch({ effects: compartment.reconfigure([]) });
  equal(rows(view), ["one", "two"]);
  view.dispatch({ effects: compartment.reconfigure(markdownView) });
  equal(rows(view), ["one two"]);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "new\ntext\n\nlast" } });
  equal(rows(view), ["new text", "", "last"]);
});

test("lazy language loading and scrolling decorate paragraphs outside the initial viewport", async () => {
  const language = new Compartment();
  const parent = document.body.appendChild(document.createElement("div"));
  parent.className = "project-viewer";
  const doc = Array.from({ length: 400 }, (_, i) => `Paragraph ${i}\ncontinues with [link](https://example.com).\n`).join("\n");
  const view = new EditorView({ parent, doc, extensions: [
    language.of([]), markdownView, EditorView.lineWrapping,
  ] });
  views.push(view);
  assert(!view.contentDOM.querySelector(".cm-md-softbreak"), "unparsed text was joined");
  view.dispatch({ effects: language.reconfigure(markdown({ base: markdownLanguage })) });
  const target = doc.indexOf("Paragraph 350");
  assert(forceParsing(view, target + 100, 500), "could not parse the scrolled paragraph");
  view.dispatch({ effects: EditorView.scrollIntoView(target, { y: "center" }) });
  await settle();
  assert(view.viewport.from > 0, "viewer did not scroll");
  assert(rows(view).includes("Paragraph 350 continues with link."), "scrolled paragraph did not reflow");
  equal(view.state.doc.toString(), doc);
});

test("narrow panes wrap a paragraph without restoring source breaks", async () => {
  const view = viewer("Words that fill a reading line\nand continue as one paragraph\nwith enough text to wrap naturally.");
  const wideHeight = view.contentDOM.querySelector(".cm-line")!.getBoundingClientRect().height;
  view.dom.parentElement!.style.width = "240px";
  view.requestMeasure();
  await settle();
  equal(rows(view).length, 1);
  assert(view.contentDOM.querySelector(".cm-line")!.getBoundingClientRect().height > wideHeight,
    "paragraph did not wrap when the pane narrowed");
});

async function run() {
  const results: Array<{ name: string; error?: string }> = [];
  const errors: string[] = [];
  window.addEventListener("error", (event) => errors.push(event.message));
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); originalError(...args); };
  for (const { name, run } of tests) {
    try {
      await run();
      await settle();
      assert(errors.length === 0, errors.join("\n"));
      results.push({ name });
    } catch (error) {
      results.push({ name, error: String(error) });
    } finally {
      for (const view of views.splice(0)) { const parent = view.dom.parentElement; view.destroy(); parent?.remove(); }
      errors.length = 0;
    }
  }
  const output = document.body.appendChild(document.createElement("pre"));
  output.id = "test-results";
  output.textContent = encodeURIComponent(JSON.stringify(results));
}
void run();
