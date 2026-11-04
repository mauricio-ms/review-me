import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range, Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

import { linkHref } from "../lib/markdown";
import { shownChangeLines } from "./diff-marks";

/** Text drawn in place of markup: an image's tag, an alert's name. */
class TextWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly cls: string,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof TextWidget && other.text === this.text && other.cls === this.cls;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = this.cls;
    el.textContent = this.text;
    return el;
  }

  // A click on it places the cursor, as on the text it stands for.
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * A list item's marker — a bullet, its number, or a task's box — in a box as wide as its
 * nesting, which the item's wrapped lines hang under. With no marker, the indent of the
 * item's lines below its first.
 */
class ListMarker extends WidgetType {
  constructor(
    readonly width: number,
    readonly mark: string,
    readonly task: "open" | "done" | null,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof ListMarker &&
      other.width === this.width &&
      other.mark === this.mark &&
      other.task === this.task
    );
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-md-list-mark";
    el.style.width = `${this.width}em`;
    if (this.task) {
      const box = document.createElement("span");
      box.className = `cm-md-task${this.task === "done" ? " is-done" : ""}`;
      el.appendChild(box);
    } else {
      el.textContent = this.mark;
    }
    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * The text a table row is padded with so its columns line up: spaces, the pipes a row
 * left out, and — for the delimiter row — the rule under the header.
 */
class TableFill extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof TableFill && other.text === this.text;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    for (const run of this.text.match(/\|+|─+| +/g) ?? []) {
      if (run[0] === " ") {
        el.appendChild(document.createTextNode(run));
      } else {
        const span = document.createElement("span");
        span.className = run[0] === "|" ? "cm-md-table-pipe" : "cm-md-table-rule";
        span.textContent = run;
        el.appendChild(span);
      }
    }
    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** A thematic break (`---`): a rule across the line. */
class RuleWidget extends WidgetType {
  eq(other: WidgetType): boolean {
    return other instanceof RuleWidget;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-md-hr";
    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const HIDE = Decoration.replace({});
const RULE = new RuleWidget();
const IMAGE_TAG = new TextWidget("image", "cm-md-image-tag");
const CODE = Decoration.mark({ class: "cm-md-code" });
const CODE_INFO = Decoration.mark({ class: "cm-md-code-info" });
const STRIKE = Decoration.mark({ class: "cm-md-strike" });
const LINK = Decoration.mark({ class: "cm-md-link" });
const PIPE = Decoration.mark({ class: "cm-md-table-pipe" });
const PLAIN = Decoration.mark({ class: "cm-md-plain" });
const BULLETS = ["•", "◦", "▪"];
/** How far each level of a bulleted list is indented, in em. */
const LIST_STEP = 1.5;
/** About how wide a numbered list's marker is, per character, in em. */
const DIGIT_WIDTH = 0.62;
/** How far each level of a quote is indented, in em. */
const QUOTE_STEP = 0.9;

const ALERTS: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

/** Where decorations go: the view's, or a count of what they'd hide (a table's widths). */
interface Sink {
  readonly state: EditorState;
  /**
   * Hide `from`–`to` (within a line), or draw `widget` instead of it — before what's at
   * `from` (`side` -1) or after it, when the range is empty.
   */
  hide(from: number, to: number, widget?: WidgetType, side?: -1 | 1): void;
  mark(from: number, to: number, deco: Decoration): void;
}

type LineStyle = { classes: string[]; quote: number; hang: number };

const lineDecos = new Map<string, Decoration>();

/** The decorations for the lines on screen, markup kept wherever a line is `revealed`. */
class Builder implements Sink {
  readonly decos: Range<Decoration>[] = [];
  private readonly lines = new Map<number, LineStyle>();
  /** Each numbered list's marker width, by where the list starts. */
  readonly markerWidths = new Map<number, number>();

  constructor(
    readonly state: EditorState,
    readonly revealed: ReadonlySet<number>,
    private readonly first: number,
    private readonly last: number,
  ) {}

  inView(line: number): boolean {
    return line >= this.first && line <= this.last;
  }

  hide(from: number, to: number, widget?: WidgetType, side: -1 | 1 = 1): void {
    const line = this.state.doc.lineAt(from);
    // A view plugin may not replace a line break.
    if (to < from || to > line.to || this.revealed.has(line.number)) return;
    if (from === to) {
      if (widget) this.decos.push(Decoration.widget({ widget, side }).range(from));
    } else {
      this.decos.push((widget ? Decoration.replace({ widget }) : HIDE).range(from, to));
    }
  }

  mark(from: number, to: number, deco: Decoration): void {
    if (from < to) this.decos.push(deco.range(from, to));
  }

  style(line: number): LineStyle {
    let style = this.lines.get(line);
    if (!style) {
      style = { classes: [], quote: 0, hang: 0 };
      this.lines.set(line, style);
    }
    return style;
  }

  /** Give every line on screen from `from`'s to `to`'s a class. */
  addClass(from: number, to: number, cls: string): void {
    const { doc } = this.state;
    const a = Math.max(doc.lineAt(from).number, this.first);
    const b = Math.min(doc.lineAt(to).number, this.last);
    for (let n = a; n <= b; n++) this.style(n).classes.push(cls);
  }

  finish(): DecorationSet {
    for (const [n, { classes, quote, hang }] of this.lines) {
      const key = `${classes.join(" ")}|${quote}|${hang}`;
      let deco = lineDecos.get(key);
      if (!deco) {
        const indent = quote * QUOTE_STEP + hang;
        const style = indent
          ? `padding-left: calc(6px + ${indent}em);${hang ? ` text-indent: -${hang}em;` : ""}`
          : null;
        deco = Decoration.line({
          class: classes.join(" "),
          attributes: style ? { style } : undefined,
        });
        lineDecos.set(key, deco);
      }
      this.decos.push(deco.range(this.state.doc.line(n).from));
    }
    return Decoration.set(this.decos, true);
  }
}

/** Counts what inline markup hides, so a table cell's width is its width as shown. */
class Measure implements Sink {
  hidden = 0;

  constructor(readonly state: EditorState) {}

  hide(from: number, to: number, widget?: WidgetType): void {
    this.hidden += to - from - (widget instanceof TextWidget ? widget.text.length : 0);
  }

  mark(): void {}
}

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) out.push(child);
  return out;
}

/** How many characters of `text` from `at` are spaces or tabs. */
function blanks(text: string, at: number): number {
  let n = 0;
  while (at + n < text.length && (text[at + n] === " " || text[at + n] === "\t")) n++;
  return n;
}

/** The length of a line's blockquote markers (`> > `), which aren't a list's indent. */
function quotePrefix(text: string): number {
  return /^(?:[ \t]*>[ \t]?)*/.exec(text)?.[0].length ?? 0;
}

/** Hide a `>` and the space after it. */
function quoteMark(sink: Sink, mark: SyntaxNode): void {
  const next = sink.state.sliceDoc(mark.to, mark.to + 1);
  sink.hide(mark.from, next === " " ? mark.to + 1 : mark.to);
}

/** A leaf block's inline markup: emphasis, code, links, escapes. */
function inline(sink: Sink, node: SyntaxNode): void {
  inlineNodes(sink, children(node));
}

function inlineNodes(sink: Sink, nodes: SyntaxNode[]): void {
  for (const node of nodes) {
    switch (node.name) {
      case "EmphasisMark":
      case "StrikethroughMark":
        sink.hide(node.from, node.to);
        break;
      case "Strikethrough":
        sink.mark(node.from, node.to, STRIKE);
        inline(sink, node);
        break;
      case "InlineCode": {
        const marks = node.getChildren("CodeMark");
        if (marks.length === 2) {
          sink.hide(marks[0].from, marks[0].to);
          sink.hide(marks[1].from, marks[1].to);
          sink.mark(marks[0].to, marks[1].from, CODE);
        }
        break;
      }
      case "Link":
      case "Image":
        link(sink, node);
        break;
      case "Autolink": {
        for (const mark of node.getChildren("LinkMark")) sink.hide(mark.from, mark.to);
        const url = node.getChild("URL");
        if (url) sink.mark(url.from, url.to, LINK);
        break;
      }
      case "URL":
        sink.mark(node.from, node.to, LINK);
        break;
      case "Escape":
        sink.hide(node.from, node.from + 1);
        sink.mark(node.from + 1, node.to, PLAIN);
        break;
      case "QuoteMark":
        quoteMark(sink, node);
        break;
      case "TaskMarker":
        // Drawn by its list item.
        break;
      default:
        inline(sink, node);
    }
  }
}

/** A link as its text alone, the address in a tooltip — when it's a link at all. */
function link(sink: Sink, node: SyntaxNode): void {
  const href = linkHref(sink.state, node);
  const [open, close] = node.getChildren("LinkMark");
  // The link's text, which may hold emphasis or code of its own.
  const text = children(node).filter(
    (c) => open && close && c.from >= open.to && c.to <= close.from,
  );
  // Brackets with no definition behind them (`[WIP]`), or a link with no text, stay as
  // written.
  if (href == null || !open || !close || close.from <= open.to) {
    sink.mark(node.from, node.to, PLAIN);
    inlineNodes(sink, text);
    return;
  }
  const image = node.name === "Image";
  sink.hide(open.from, open.to, image ? IMAGE_TAG : undefined);
  sink.mark(
    open.to,
    close.from,
    Decoration.mark({ class: image ? "cm-md-image" : "cm-md-link", attributes: { title: href } }),
  );
  sink.hide(close.from, node.to);
  inlineNodes(sink, text);
}

function heading(b: Builder, node: SyntaxNode, level: number): void {
  b.addClass(node.from, node.to, `cm-md-h cm-md-h${level}`);
  const { doc } = b.state;
  node.getChildren("HeaderMark").forEach((mark, i) => {
    const line = doc.lineAt(mark.from);
    if (i === 0 && mark.from === node.from) {
      b.hide(mark.from, mark.to + blanks(line.text, mark.to - line.from));
    } else {
      // A closing run of `#`, and the space before it.
      let start = mark.from;
      while (start > line.from && /[ \t]/.test(line.text[start - 1 - line.from])) start--;
      b.hide(start, mark.to);
    }
  });
  inline(b, node);
}

function setextHeading(b: Builder, node: SyntaxNode, level: number): void {
  const mark = node.getChild("HeaderMark");
  b.addClass(node.from, mark ? mark.from - 1 : node.to, `cm-md-h cm-md-h${level}`);
  if (mark) b.hide(mark.from, mark.to);
  inline(b, node);
}

function codeBlock(b: Builder, node: SyntaxNode): void {
  b.addClass(node.from, node.to, "cm-md-codeblock");
  b.addClass(node.from, node.from, "cm-md-codeblock-first");
  b.addClass(node.to, node.to, "cm-md-codeblock-last");
  for (const mark of node.getChildren("CodeMark")) b.hide(mark.from, mark.to);
  const info = node.getChild("CodeInfo");
  if (info) b.mark(info.from, info.to, CODE_INFO);
}

function blockquote(b: Builder, node: SyntaxNode): void {
  const { doc } = b.state;
  const first = doc.lineAt(node.from).number;
  const last = doc.lineAt(node.to).number;
  for (let n = first; n <= last; n++) if (b.inView(n)) b.style(n).quote++;
  b.addClass(node.from, node.to, "cm-md-quote");
  // GitHub's alerts: `> [!WARNING]` on a quote's first line names its kind.
  if (node.parent?.name === "Blockquote") return;
  const line = doc.lineAt(node.from);
  const alert = /^((?:[ \t]*>[ \t]?)+)\[!(\w+)\][ \t]*$/.exec(line.text);
  const kind = alert ? alert[2].toLowerCase() : null;
  if (!alert || !kind || !(kind in ALERTS)) return;
  b.addClass(node.from, node.to, `cm-md-alert cm-md-alert-${kind}`);
  const at = line.from + alert[1].length;
  b.hide(at, line.to, new TextWidget(ALERTS[kind], "cm-md-alert-label"));
}

/** How wide an item's own marker box is: a bullet's, or its list's widest number. */
function markerWidth(b: Builder, item: SyntaxNode): number {
  const list = item.parent;
  if (list?.name !== "OrderedList") return LIST_STEP;
  let width = b.markerWidths.get(list.from);
  if (width == null) {
    let widest = 0;
    for (const it of list.getChildren("ListItem")) {
      const mark = it.getChild("ListMark");
      if (mark) widest = Math.max(widest, mark.to - mark.from);
    }
    width = Math.max(LIST_STEP, widest * DIGIT_WIDTH + 0.5);
    b.markerWidths.set(list.from, width);
  }
  return width;
}

function listItem(b: Builder, node: SyntaxNode): void {
  const mark = node.getChild("ListMark");
  if (!mark) return;
  const { doc } = b.state;
  // Its own marker's box, after those of the items it's nested in.
  let level = 0;
  let width = 0;
  for (let n: SyntaxNode | null = node; n; n = n.parent) {
    if (n.name !== "ListItem") continue;
    level++;
    width += markerWidth(b, n);
  }
  width = Math.round(width * 100) / 100;
  const line = doc.lineAt(mark.from);
  const taskNode = node.getChild("Task");
  const task = taskNode?.getChild("TaskMarker");
  const onLine = task && doc.lineAt(task.from).number === line.number ? task : null;
  const end = onLine ? onLine.to : mark.to;
  if (b.inView(line.number) && !b.revealed.has(line.number)) {
    const text =
      node.parent?.name === "OrderedList"
        ? doc.sliceString(mark.from, mark.to)
        : BULLETS[(level - 1) % BULLETS.length];
    const state = onLine ? (/x/i.test(doc.sliceString(onLine.from, onLine.to)) ? "done" : "open") : null;
    b.hide(
      line.from + quotePrefix(line.text),
      end + blanks(line.text, end - line.from),
      new ListMarker(width, text, state),
    );
    b.style(line.number).hang = width;
  }
  // The item's lines below its first: its paragraphs, hung under its text.
  for (const child of children(node)) {
    if (child.name !== "Paragraph" && child.name !== "Task") continue;
    const last = doc.lineAt(child.to).number;
    for (let n = doc.lineAt(child.from).number; n <= last; n++) {
      if (n === line.number || !b.inView(n) || b.revealed.has(n)) continue;
      const l = doc.line(n);
      const start = l.from + quotePrefix(l.text);
      b.hide(start, start + blanks(l.text, start - l.from), new ListMarker(width, "", null));
      b.style(n).hang = width;
    }
  }
}

type Segment = { from: number; to: number; cell: SyntaxNode | null };
type Row = { node: SyntaxNode; segments: Segment[]; lead: boolean; trail: boolean };

/** A table row's cells by the pipes around them — an empty cell has no node. */
function tableRow(node: SyntaxNode): Row {
  const parts = children(node);
  const pipes = parts.filter((p) => p.name === "TableDelimiter");
  const cells = parts.filter((p) => p.name === "TableCell");
  const lead = pipes.length > 0 && pipes[0].from === node.from;
  const segments: Segment[] = [];
  const edges = [node.from, ...pipes.flatMap((p) => [p.from, p.to]), node.to];
  for (let i = lead ? 2 : 0; i + 1 < edges.length; i += 2) {
    const from = edges[i];
    const to = edges[i + 1];
    segments.push({ from, to, cell: cells.find((c) => c.from >= from && c.to <= to) ?? null });
  }
  // What follows the last pipe is a cell only if it holds something.
  const trail = segments.length > 0 && segments[segments.length - 1].cell == null && pipes.length > 0;
  if (trail) segments.pop();
  return { node, segments, lead, trail };
}

/** Line a table's columns up: monospaced, padded to each column's widest cell as shown. */
function table(b: Builder, node: SyntaxNode): void {
  const { state } = b;
  const { doc } = state;
  const rows = children(node)
    .filter((c) => c.name === "TableHeader" || c.name === "TableRow")
    .map(tableRow);
  const delimiter = children(node).find((c) => c.name === "TableDelimiter");
  const align = (delimiter ? state.sliceDoc(delimiter.from, delimiter.to) : "")
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((d) => {
      const t = d.trim();
      return t.startsWith(":") && t.endsWith(":") ? "center" : t.endsWith(":") ? "right" : "left";
    });
  const shown = (cell: SyntaxNode | null) => {
    if (!cell) return 0;
    const measure = new Measure(state);
    inline(measure, cell);
    return cell.to - cell.from - measure.hidden;
  };
  const widths: number[] = [];
  const cellWidths = rows.map((row) =>
    row.segments.map((seg, i) => {
      const w = shown(seg.cell);
      widths[i] = Math.max(widths[i] ?? 1, w);
      return w;
    }),
  );
  const columns = Math.max(widths.length, align.length);
  for (let i = 0; i < columns; i++) widths[i] = widths[i] ?? 1;
  const pad = (n: number) => " ".repeat(Math.max(0, n));

  rows.forEach((row, r) => {
    const line = doc.lineAt(row.node.from);
    if (!b.inView(line.number)) return;
    b.addClass(row.node.from, row.node.from, r === 0 ? "cm-md-table cm-md-table-head" : "cm-md-table");
    for (const p of children(row.node)) if (p.name === "TableDelimiter") b.mark(p.from, p.to, PIPE);
    const missing = widths
      .slice(row.segments.length)
      .map((w) => `${pad(w + 2)}|`)
      .join("");
    row.segments.forEach((seg, i) => {
      const extra = widths[i] - cellWidths[r][i];
      const left = align[i] === "right" ? extra : align[i] === "center" ? Math.floor(extra / 2) : 0;
      const before = (i === 0 && !row.lead ? "|" : "") + pad(1 + left);
      const after =
        pad(1 + extra - left) + (i === row.segments.length - 1 ? (row.trail ? "" : "|") + missing : "");
      if (seg.cell) {
        b.hide(seg.from, seg.cell.from, new TableFill(before), -1);
        b.hide(seg.cell.to, seg.to, new TableFill(after));
      } else {
        b.hide(seg.from, seg.to, new TableFill(before + after));
      }
    });
  });

  if (delimiter && b.inView(doc.lineAt(delimiter.from).number)) {
    b.addClass(delimiter.from, delimiter.from, "cm-md-table");
    const rule = `|${widths.map((w) => "─".repeat(w + 2)).join("|")}|`;
    b.hide(delimiter.from, delimiter.to, new TableFill(rule));
  }
}

/**
 * Where a leading YAML frontmatter block (`---`, `key: value`… `---`) ends, if the file
 * has one — the parser would read it as a rule and a heading.
 */
function frontmatter(doc: Text): number | null {
  if (doc.lines < 3 || doc.line(1).text.trimEnd() !== "---") return null;
  if (!/^[\w-]+[ \t]*:/.test(doc.line(2).text)) return null;
  for (let n = 2; n <= Math.min(doc.lines, 500); n++) {
    const text = doc.line(n).text.trimEnd();
    if (text === "---" || text === "...") return doc.line(n).to;
  }
  return null;
}

/**
 * The lines that show their markup: the cursor's, or the selection's, while the editor
 * has the keyboard — what the file says is right there where you are, and a selection
 * for a note is of real lines — and the lines of a change whose diff is shown, so a
 * change that only touched markup is never out of sight.
 */
function revealedLines(view: EditorView): Set<number> {
  const { state } = view;
  const lines = shownChangeLines(state);
  // Not `view.hasFocus`, which also asks the window: leaving the app for another and
  // coming back mustn't flip every line on screen.
  if (view.root.activeElement !== view.contentDOM) return lines;
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    // A selection of whole lines ends at the start of the next.
    if (range.to > range.from && state.doc.line(last).from === range.to) last--;
    for (let n = first; n <= Math.max(first, last); n++) lines.add(n);
  }
  return lines;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const { from, to } = view.viewport;
  const b = new Builder(
    state,
    revealedLines(view),
    state.doc.lineAt(from).number,
    state.doc.lineAt(to).number,
  );
  const front = frontmatter(state.doc);
  if (front != null) b.addClass(0, front, "cm-md-frontmatter");
  const tables: SyntaxNode[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (ref) => {
      if (front != null && ref.from <= front && ref.name !== "Document") return false;
      const node = ref.node;
      switch (ref.name) {
        case "ATXHeading1":
        case "ATXHeading2":
        case "ATXHeading3":
        case "ATXHeading4":
        case "ATXHeading5":
        case "ATXHeading6":
          heading(b, node, Number(ref.name.slice(-1)));
          return false;
        case "SetextHeading1":
        case "SetextHeading2":
          setextHeading(b, node, Number(ref.name.slice(-1)));
          return false;
        case "FencedCode":
        case "CodeBlock":
          codeBlock(b, node);
          return false;
        case "Blockquote":
          blockquote(b, node);
          return true;
        case "QuoteMark":
          quoteMark(b, node);
          return false;
        case "ListItem":
          listItem(b, node);
          return true;
        case "Paragraph":
        case "Task":
        case "TableCell":
          inline(b, node);
          return false;
        case "Table":
          tables.push(node);
          return true;
        case "HorizontalRule":
          b.addClass(ref.from, ref.from, "cm-md-hr-line");
          b.hide(ref.from, ref.to, RULE);
          return false;
        case "LinkReference":
          b.addClass(ref.from, ref.to, "cm-md-linkdef");
          return false;
        case "ListMark":
        case "TableDelimiter":
        case "HTMLBlock":
        case "CommentBlock":
          return false;
        default:
          return true;
      }
    },
  });
  for (const node of tables) table(b, node);
  return b.finish();
}

/**
 * A Markdown file read the way it renders, in place: the document stays the file's text
 * — line 42 is still line 42, so change marks, flags, notes, Swiper and vim work as in
 * any file — while decorations hide the markup and draw what it means: headings,
 * emphasis, code, links by their text, bullets and task boxes with wrapped lines hung
 * under them, quotes and GitHub's alerts, tables lined up, rules. Prose reads in a
 * proportional face; code and tables stay monospaced.
 *
 * Only what's on screen is decorated, from the syntax tree, so it's a view plugin: it
 * neither replaces a line break nor draws a block widget, which only a state field may.
 */
export const markdownView: Extension = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = build(view);
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.focusChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state) ||
          update.transactions.some((tr) => tr.effects.length > 0)
        ) {
          this.decorations = build(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  ),
  EditorView.contentAttributes.of({ class: "cm-md" }),
];
