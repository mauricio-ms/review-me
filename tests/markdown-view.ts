import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";

import { diffMarks, setDeletedFile, setDiffMarks, type ShownBlock } from "../src/editor/diff-marks";
import { flagDecorations, setFlagLines } from "../src/editor/flag-decorations";
import { gruberDarkerTheme } from "../src/editor/gruber-darker";
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
      markdownView, gruberDarkerTheme, extra,
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

test("large table cells wrap inside aligned columns and stretch their separators", async () => {
  const doc = "| Key | What it does |\n| --- | --- |\n| `C-s` | Search this file for matching text, with a description long enough to wrap over several visual lines. |\n| `M-.` | Follow a link. |";
  const view = viewer(doc);
  view.dom.parentElement!.style.width = "360px";
  view.requestMeasure();
  await settle();
  const tableRows = Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-md-table"));
  equal(tableRows.length, 4);
  const cells = tableRows.map((row) => Array.from(row.querySelectorAll<HTMLElement>(".cm-md-table-cell")));
  equal(cells.map((row) => row.length), [2, 2, 2, 2]);
  const positions = cells.map((row) => row.map((cell) => cell.getBoundingClientRect()));
  for (const row of positions) {
    for (let col = 0; col < row.length; col++) {
      assert(Math.abs(row[col].left - positions[0][col].left) < 1, "column separators are not aligned");
      assert(Math.abs(row[col].width - positions[0][col].width) < 1, "column widths differ between rows");
    }
    assert(Math.abs(row[0].height - row[1].height) < 1, "separators do not span the wrapped row");
  }
  assert(positions[2][1].height > positions[3][1].height, "long cell did not wrap independently");
  const right = view.contentDOM.getBoundingClientRect().right;
  assert(positions[2][1].right <= right + 1, "table overflows the pane");
  equal(view.state.doc.toString(), doc);
  equal(linkAt(view.state, doc.indexOf("Follow")), null);
});

test("single-column tables keep both borders around wrapped content", async () => {
  const view = viewer("| a large col |\n|-------------|\n| asdf asdf asdf text continues here with an_extremely_long_unbroken_token_that_must_wrap | ");
  view.dom.parentElement!.style.width = "200px";
  view.requestMeasure();
  await settle();
  const cells = Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-md-table-cell"));
  equal(cells.length, 3);
  assert(cells[2].getBoundingClientRect().height > cells[0].getBoundingClientRect().height,
    "cell content did not wrap");
  const row = cells[2].closest<HTMLElement>(".cm-line")!;
  assert(cells[2].getBoundingClientRect().right <= row.getBoundingClientRect().right + 1,
    "unbroken text escaped its column");
  assert(parseFloat(getComputedStyle(cells[2]).borderLeftWidth) > 0, "left separator is missing");
  assert(getComputedStyle(row, "::after").content !== "none", "right separator is missing");
});

test("the header rule adds no extra padding above the first body row", async () => {
  const doc = "| Key | Action |\n| --- | --- |\n| one | First action |\n| two | Second action |\n\noutside";
  const view = viewer(doc);
  await settle();
  const rule = view.contentDOM.querySelector<HTMLElement>(".cm-md-table-rule-cell")!;
  const ruleRow = rule.closest<HTMLElement>(".cm-line")!;
  assert(ruleRow.getBoundingClientRect().height <= 2, "header delimiter still occupies a full text row");
  const bodyRows = Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-md-table")).slice(2);
  const first = view.coordsAtPos(doc.indexOf("one"))!;
  const second = view.coordsAtPos(doc.indexOf("two"))!;
  const firstGap = first.top - rule.getBoundingClientRect().bottom;
  const secondGap = second.top - bodyRows[1].getBoundingClientRect().top;
  assert(Math.abs(firstGap - secondGap) < 2, "first body row has extra space above its text");
  const gutterTexts = () => Array.from(view.dom.querySelectorAll(".cm-lineNumbers .cm-gutterElement"))
    .map((el) => el.textContent);
  assert(!gutterTexts().includes("2"), "collapsed delimiter number overlaps the next row");
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
  view.focus();
  await settle();
  equal(view.contentDOM.querySelector(".cm-md-table-raw")?.textContent, "| --- | --- |");
  assert(gutterTexts().includes("2"), "inspecting the delimiter did not restore its source line number");
});

test("tables fill empty and omitted cells and retain column alignment settings", async () => {
  const view = viewer("Left | Center | Right\n:--- | :---: | ---:\nfirst||third\nonly one cell\n| | filled | |");
  await settle();
  const tableRows = Array.from(view.contentDOM.querySelectorAll(".cm-md-table"));
  equal(tableRows.length, 5);
  for (const row of tableRows) {
    const cells = Array.from(row.querySelectorAll<HTMLElement>(".cm-md-table-cell"));
    equal(cells.length, 3);
    equal(cells.map((cell) => getComputedStyle(cell).textAlign), ["left", "center", "right"]);
  }
});

test("table sizing follows pane resizing and font scaling", async () => {
  const view = viewer("| Key | Description |\n| --- | --- |\n| C-s | A lengthy description with enough words to wrap when the pane is narrow. |\n| M-. | Short. |");
  const parent = view.dom.parentElement!;
  const body = () => Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-md-table"))[2];
  const check = () => {
    const tableRows = Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-md-table"));
    const expected = Array.from(tableRows[0].querySelectorAll(".cm-md-table-cell"))
      .map((cell) => cell.getBoundingClientRect().left);
    for (const row of tableRows) {
      const cells = Array.from(row.querySelectorAll(".cm-md-table-cell"));
      cells.forEach((cell, i) => assert(Math.abs(cell.getBoundingClientRect().left - expected[i]) < 1,
        "columns lost alignment after resizing"));
      assert(cells[1].getBoundingClientRect().right <= row.getBoundingClientRect().right + 1,
        "resized table overflows the pane");
    }
  };
  await settle();
  const wideHeight = body().getBoundingClientRect().height;
  parent.style.width = "300px";
  view.requestMeasure();
  await settle();
  check();
  assert(body().getBoundingClientRect().height > wideHeight, "narrow table did not get taller");
  parent.style.setProperty("--fs", "24px");
  view.requestMeasure();
  await settle();
  check();
});

test("table borders align with indentation, quotes and many narrow columns", async () => {
  const view = viewer("  | A | B |\n | --- | --- |\n   | left | long content which wraps within this column |\n| right | short |\n\n> | A | B |\n> | --- | --- |\n> | left | quoted content which wraps within this column |\n> | right | short |");
  view.dom.parentElement!.style.width = "300px";
  view.requestMeasure();
  await settle();
  const tableRows = Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-md-table"));
  equal(tableRows.length, 8);
  for (let start = 0; start < tableRows.length; start += 4) {
    const left = tableRows[start].querySelector(".cm-md-table-cell")!.getBoundingClientRect().left;
    for (const row of tableRows.slice(start, start + 4)) {
      assert(Math.abs(row.querySelector(".cm-md-table-cell")!.getBoundingClientRect().left - left) < 1,
        "source indentation shifted a table border");
    }
  }
  const many = viewer(`|${Array(8).fill(" Col ").join("|")}|\n|${Array(8).fill(" --- ").join("|")}|\n|${Array(8).fill(" long text ").join("|")}|`);
  many.dom.parentElement!.style.width = "220px";
  many.requestMeasure();
  await settle();
  for (const row of many.contentDOM.querySelectorAll<HTMLElement>(".cm-md-table")) {
    const cells = row.querySelectorAll(".cm-md-table-cell");
    equal(cells.length, 8);
    assert(cells[7].getBoundingClientRect().right <= row.getBoundingClientRect().right + 1,
      "many-column table escaped the narrow pane");
  }
});

test("wrapped table text retains links, source coordinates and review highlights", async () => {
  const doc = "| Key | Description |\n| --- | --- |\n| `C-s` | A [linked phrase](https://example.com) and **important** text with enough detail to wrap. |\n| other | Short. |";
  const view = viewer(doc);
  view.dom.parentElement!.style.width = "360px";
  const line = view.state.doc.line(3);
  const changed = line.text.indexOf("important");
  view.dispatch({ effects: [
    setDiffMarks.of([block({
      modified: [3], removedAt: 3, words: true,
      newText: new Map([[3, line.text]]),
      newSegs: new Map([[3, [
        { text: line.text.slice(0, changed), changed: false },
        { text: "important", changed: true },
        { text: line.text.slice(changed + 9), changed: false },
      ]]]),
    })]),
    setFlagLines.of([[3, 3]]),
  ] });
  await settle();
  const row = view.contentDOM.querySelector<HTMLElement>(".cm-diff-line-modified")!;
  equal(row.querySelectorAll(".cm-md-table-cell").length, 2);
  assert(row.classList.contains("cm-flagged-line"), "flag moved off the table row");
  equal(row.querySelector(".cm-diff-word")?.textContent, "important");
  const linkPos = doc.indexOf("linked phrase") + 3;
  equal(linkAt(view.state, linkPos), "https://example.com");
  const coords = view.coordsAtPos(linkPos)!;
  assert(coords, "wrapped link has no source coordinates");
  const at = view.posAtCoords({ x: coords.left + 1, y: (coords.top + coords.bottom) / 2 });
  assert(at != null && linkAt(view.state, at) === "https://example.com", "link click lost its source position");
  equal(view.state.doc.toString(), doc);
});

test("table cursor inspection and Vim selections still use original source rows", async () => {
  const doc = "| Key | Description |\n| --- | --- |\n| `C-s` | Long content which wraps over several visual lines within its own cell. |\n| `M-.` | Follow a link. |\n\noutside";
  const view = viewer(doc, vim());
  view.dom.parentElement!.style.width = "300px";
  view.dispatch({ selection: { anchor: view.state.doc.line(3).from } });
  view.focus();
  await settle();
  equal(view.contentDOM.querySelector(".cm-md-table-raw")?.textContent, view.state.doc.line(3).text);
  const cm = getCM(view)!;
  Vim.handleKey(cm, "V", "user");
  Vim.handleKey(cm, "j", "user");
  equal(view.state.doc.lineAt(view.state.selection.main.from).number, 3);
  equal(view.state.doc.lineAt(view.state.selection.main.to).number, 4);
  equal(view.contentDOM.querySelectorAll(".cm-md-table-raw").length, 2);
  Vim.handleKey(cm, "<Esc>", "user");
  view.dispatch({ selection: { anchor: view.state.doc.line(6).from } });
  equal(view.contentDOM.querySelectorAll(".cm-md-table-raw").length, 0);
  equal(view.contentDOM.querySelectorAll(".cm-md-table-cell").length, 8);
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
