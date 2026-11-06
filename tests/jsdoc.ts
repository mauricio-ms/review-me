import { forceParsing, LanguageDescription, syntaxTree } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";

import { diffMarks, setDiffMarks, type ShownBlock } from "../src/editor/diff-marks";
import { flagDecorations, setFlagLines } from "../src/editor/flag-decorations";
import { gruberDarkerTheme } from "../src/editor/gruber-darker";
import { jsdocHighlight, jsdocTokens } from "../src/editor/jsdoc";
import { languages } from "../src/editor/languages";
import { markdownView } from "../src/editor/markdown-view";
import { swiper, swiperHighlight } from "../src/editor/swiper";
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
const tokens = (doc: string) => jsdocTokens(doc).map(({ from, to, kind }) => [kind, doc.slice(from, to)]);
const text = (view: EditorView, kind: string) => Array.from(view.contentDOM.querySelectorAll(`.cm-jsdoc-${kind}`))
  .map((node) => node.textContent);
function viewer(doc: string, extra: Extension = []) {
  const parent = document.body.appendChild(document.createElement("div"));
  parent.className = "project-viewer";
  const view = new EditorView({ parent, doc, extensions: [
    lineNumbers(), EditorView.lineWrapping, EditorState.readOnly.of(true),
    jsdocHighlight, gruberDarkerTheme, diffMarks, flagDecorations, swiperHighlight, extra,
  ] });
  views.push(view);
  return view;
}
async function parse(view: EditorView) {
  forceParsing(view, view.state.doc.length, 1000);
  await settle();
  assert(forceParsing(view, view.state.doc.length, 1000), "could not finish parsing the fixture");
  await settle();
}
async function support(path: string) {
  const description = LanguageDescription.matchFilename(languages, path);
  if (!description) throw new Error(`Missing language for ${path}`);
  return description.load();
}
async function file(path: string, doc: string, extra: Extension = []) {
  const view = viewer(doc, [await support(path), extra]);
  await parse(view);
  return view;
}
function color(view: EditorView, selector: string) {
  let node = view.contentDOM.querySelector(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  while (node.firstElementChild) node = node.firstElementChild;
  return getComputedStyle(node).color;
}

test("tags, types, parameter names and inline link targets have precise source ranges", () => {
  equal(tokens("/** Summarize.\n * @param {string} name - A name.\n * @returns {boolean} See {@link Foo#bar|the method}.\n */"), [
    ["tag", "@param"], ["type", "{string}"], ["name", "name"],
    ["tag", "@returns"], ["type", "{boolean}"], ["tag", "@link"], ["link", "Foo#bar"],
  ]);
  equal(tokens("/** @arg {...number} values */"), [
    ["tag", "@arg"], ["type", "{...number}"], ["name", "values"],
  ]);
});

test("repeated same-line tags preserve every type and parameter", () => {
  equal(tokens('/** @param {User} user @param {Options} [options={label: "@param fake"}] @returns {User} */'), [
    ["tag", "@param"], ["type", "{User}"], ["name", "user"],
    ["tag", "@param"], ["type", "{Options}"], ["name", '[options={label: "@param fake"}]'],
    ["tag", "@returns"], ["type", "{User}"],
  ]);
});

test("nested records, quoted braces, unions, generics and optional defaults stay intact", () => {
  const type = "{Array<{label: '}', value: (number|string)}>}";
  const name = '[options={label: "a ] b", values: [1, 2]}]';
  equal(tokens(`/** @param ${type} ${name} - Description. */`), [
    ["tag", "@param"], ["type", type], ["name", name],
  ]);
  equal(tokens("/** @property {string[]} employees[].name */"), [
    ["tag", "@property"], ["type", "{string[]}"], ["name", "employees[].name"],
  ]);
});

test("multiline types and incomplete comments recover at the following tag", () => {
  equal(tokens("/**\n * @param {{\n *   name: string,\n *   value: number\n * }} options\n * @custom-marker extra\n */").filter(([kind]) => kind !== "type"), [
    ["tag", "@param"], ["name", "options"], ["tag", "@custom-marker"],
  ]);
  const incomplete = tokens("/**\n * @param {Array<string>\n * @returns {number}");
  equal(incomplete.filter(([kind]) => kind === "tag"), [["tag", "@param"], ["tag", "@returns"]]);
  assert(incomplete.some(([kind, value]) => kind === "type" && value === "{number}"), "the next type was swallowed");
});

test("custom tags and template constraints work while prose and quoted inline tags stay prose", () => {
  equal(tokens('/** Contact a@example.com; mention @param here.\n * @template {string} K, V\n * @typedef {"{@link fake}"} Mode\n * @custom-tag prose\n * {@linkcode https://example.com label} */'), [
    ["tag", "@template"], ["type", "{string}"], ["name", "K, V"],
    ["tag", "@typedef"], ["type", '{"{@link fake}"}'], ["name", "Mode"],
    ["tag", "@custom-tag"], ["tag", "@linkcode"], ["link", "https://example.com"],
  ]);
});

// Run before loading standalone JS descriptions: these fences really start with
// their LanguageDescription.support unset and are loaded by Markdown's parser.
test("lazy language installation and lazy Markdown fences acquire JSDoc highlighting", async () => {
  const compartment = new Compartment();
  const doc = "Prose /** @param {string} fake */\n\n```js\n/** @param {string} name */\nfunction hello(name) {}\n```\n\n```ts\n/** @returns {number} */\nconst count: number = 1;\n```";
  const view = viewer(doc, [compartment.of([]), markdownView]);
  equal(text(view, "tag"), []);
  view.dispatch({ effects: compartment.reconfigure(await support("sample.md")) });
  await parse(view);
  equal(text(view, "tag"), ["@param", "@returns"]);
  equal(view.state.doc.toString(), doc);
});

test("all JavaScript and TypeScript file extensions highlight documentation", async () => {
  for (const extension of ["js", "mjs", "cjs", "ts", "mts", "cts", "jsx", "tsx"]) {
    const view = await file(`sample.${extension}`, "/** @param {number} value */\nfunction twice(value) { return value * 2; }");
    equal(text(view, "tag"), ["@param"]);
    equal(text(view, "name"), ["value"]);
  }
});

test("strings, templates, regexps and ordinary comments do not become JSDoc", async () => {
  const doc = [
    'const string = "/** @param {string} fake */";',
    'const template = `/** @param {string} fake */`;',
    String.raw`const regex = /\/\*\* @param/;`,
    "// /** @param {string} fake */",
    "/* @param {string} fake */",
    "/*** @param {string} suppressed */",
    "/** Real documentation. */",
  ].join("\n");
  const view = await file("sample.js", doc);
  syntaxTree(view.state).iterate({ enter: (node) => assert(!node.type.isError, "invalid JavaScript fixture") });
  equal(text(view, "tag"), []);
  equal(Array.from(view.contentDOM.querySelectorAll(".cm-jsdoc")).map((node) => node.textContent),
    ["/** Real documentation. */"]);
});

test("Java and CSS documentation retain their existing language styles", async () => {
  for (const path of ["Sample.java", "sample.css"]) {
    const view = await file(path, "/** @param {string} fake */\n");
    equal(view.contentDOM.querySelectorAll(".cm-jsdoc").length, 0);
  }
});

test("HTML, Vue and Svelte scripts highlight JS and TS while styles stay ordinary comments", async () => {
  for (const path of ["sample.html", "sample.vue", "sample.svelte"]) {
    const doc = '<script>\n/** @param {string} name */\nfunction hello(name) {}\n</script>\n<style>\n/** @param {string} fake */\np { color: red; }\n</style>';
    const view = await file(path, doc);
    equal(text(view, "tag"), ["@param"]);
  }
  for (const path of ["sample.vue", "sample.svelte"]) {
    const view = await file(path, '<script lang="ts">\n/** @returns {number} */\nconst value: number = 1;\n</script>');
    equal(text(view, "tag"), ["@returns"]);
  }
});

test("Astro frontmatter and separate expression overlays preserve source offsets", async () => {
  const doc = '---\n/** @type {{name: string}} */\nconst item = {name: "Ada"};\n---\n<p>{/** @returns {string} */ item.name}</p>\n<p>{/** @custom-tag docs */ item.name}</p>';
  const view = await file("sample.astro", doc);
  equal(text(view, "tag"), ["@type", "@returns", "@custom-tag"]);
  equal(text(view, "type"), ["{{name: string}}", "{string}"]);
  equal(view.state.doc.toString(), doc);
});

test("Markdown fence overlays inside quotes and lists use original document positions", async () => {
  const view = await file("sample.md", "> ```js\n> /**\n>  * @param {number} value\n>  */\n> ```\n\n- Example:\n\n  ```ts\n  /** @returns {string} */\n  ```\n\n```java\n/** @param fake */\n```", markdownView);
  equal(text(view, "tag"), ["@param", "@returns"]);
  equal(text(view, "name"), ["value"]);
});

test("prose, tags, types, names and links override the parser's block comment color", async () => {
  const view = await file("sample.js", "/** Description.\n * @param {string} name See {@link Example}.\n */\n/* Ordinary comment. */");
  equal(color(view, ".cm-jsdoc"), "rgb(115, 201, 54)");
  equal(color(view, ".cm-jsdoc-tag"), "rgb(255, 221, 51)");
  equal(color(view, ".cm-jsdoc-type"), "rgb(149, 169, 159)");
  equal(color(view, ".cm-jsdoc-name"), "rgb(244, 244, 255)");
  equal(color(view, ".cm-jsdoc-link"), "rgb(150, 166, 200)");
  const ordinary = Array.from(view.contentDOM.querySelectorAll(".cm-line"))
    .find((line) => line.textContent === "/* Ordinary comment. */")!;
  equal(getComputedStyle(ordinary.firstElementChild!).color, "rgb(204, 140, 60)");
});

test("scrolling into the middle of a long comment decorates only visible ranges", async () => {
  const doc = Array.from({ length: 150 }, (_, i) => `const value${i} = ${i};`).join("\n") +
    "\n/**\n" + Array.from({ length: 150 }, (_, i) => ` * Detail ${i}.`).join("\n") +
    "\n * @param {number} value - A value.\n */";
  const view = await file("sample.js", doc);
  equal(text(view, "tag"), []);
  const target = doc.indexOf("@param");
  view.dispatch({ effects: EditorView.scrollIntoView(target, { y: "center" }) });
  await parse(view);
  assert(view.viewport.from > doc.indexOf("/**"), "the viewport still includes the comment opening");
  equal(text(view, "tag"), ["@param"]);
  assert(view.contentDOM.textContent!.length < doc.length / 2, "the whole file was rendered");
  equal(view.state.doc.toString(), doc);
});

test("refreshes and language changes clear old marks and handle unfinished comments", async () => {
  const compartment = new Compartment();
  const view = viewer("/** @param {string} old */", compartment.of(await support("sample.js")));
  await parse(view);
  equal(text(view, "name"), ["old"]);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "/** @returns {number}" } });
  await parse(view);
  equal(text(view, "name"), []);
  equal(text(view, "tag"), ["@returns"]);
  view.dispatch({ effects: compartment.reconfigure(await support("sample.css")) });
  await parse(view);
  equal(view.contentDOM.querySelectorAll(".cm-jsdoc").length, 0);
});

test("flags, word diffs, Swiper and Vim navigation coexist with documentation marks", async () => {
  const doc = "/**\n * @param {string} name Description.\n */\nconst value = 1;";
  const view = await file("sample.js", doc, vim());
  const row = view.state.doc.line(2);
  const block: ShownBlock = {
    id: "test", modified: [2], added: [], removed: [], removedAt: 2, removedSegs: [],
    newSegs: new Map([[2, [{ text: " * ", changed: false }, { text: "@param", changed: true },
      { text: row.text.slice(9), changed: false }]]]),
    newText: new Map([[2, row.text]]), trailingRemoval: false, showRemoved: false, words: true,
  };
  view.dispatch({ effects: [setDiffMarks.of([block]), setFlagLines.of([[2, 2]])] });
  assert(view.contentDOM.querySelector(".cm-flagged-line .cm-jsdoc-tag"), "flag hid the tag");
  assert(view.contentDOM.querySelector(".cm-diff-word")?.textContent === "@param", "word diff lost its source range");
  view.focus();
  await settle();
  Vim.handleKey(getCM(view)!, "j", "user");
  equal(view.state.doc.lineAt(view.state.selection.main.head).number, 2);
  Vim.handleKey(getCM(view)!, "V", "user");
  Vim.handleKey(getCM(view)!, "j", "user");
  equal(view.state.doc.lineAt(view.state.selection.main.from).number, 2);
  equal(view.state.doc.lineAt(view.state.selection.main.to).number, 3);
  swiper(view);
  const request = useMinibufferStore.getState().request;
  if (request?.kind !== "swiper") throw new Error("Swiper did not open");
  request.onMove({ index: 1, spans: [[3, 9]] }, compileSwiper("@param"));
  await settle();
  equal(color(view, ".cm-swiper-current"), "rgb(0, 0, 0)");
  request.onCancel();
  useMinibufferStore.getState().close();
  equal(view.state.doc.toString(), doc);
  equal(text(view, "tag"), ["@param"]);
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
      useMinibufferStore.getState().close();
      errors.length = 0;
    }
  }
  const output = document.body.appendChild(document.createElement("pre"));
  output.id = "test-results";
  output.textContent = encodeURIComponent(JSON.stringify(results));
}
void run();
