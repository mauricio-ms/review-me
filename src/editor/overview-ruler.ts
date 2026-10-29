import { type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import { blockStart } from "../lib/project-diff";
import { applyPosition } from "../lib/project-view";
import { markedBlocks, setDiffMarks } from "./diff-marks";
import { flaggedLines, setFlagLines } from "./flag-decorations";

/** A mark on the ruler: a span of the file, as fractions of its whole height. */
type Mark = {
  cls: string;
  top: number;
  height: number;
  /** Where a click on it puts the cursor. */
  line: number;
  title: string;
};

type Layout = {
  marks: Mark[];
  /** The part of the file on screen; null when all of it is. */
  view: { top: number; height: number } | null;
  cursor: number;
};

/** Whether the viewer has anything the ruler would mark. */
function hasMarks(state: EditorState): boolean {
  return markedBlocks(state).length > 0 || flaggedLines(state).length > 0;
}

/** Runs of consecutive line numbers, as `[first, last]`. */
function runs(lines: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const ln of lines) {
    const last = out[out.length - 1];
    if (last && ln === last[1] + 1) last[1] = ln;
    else out.push([ln, ln]);
  }
  return out;
}

/**
 * Read where everything sits, as fractions of the scrolled height: a line's place in
 * the document plus the document's own offset inside the scroller. Off-screen lines
 * are CodeMirror's height estimates, which is all a ruler needs.
 */
function measure(view: EditorView): Layout | null {
  const { state } = view;
  if (!hasMarks(state)) return null;
  const scroller = view.scrollDOM;
  const total = scroller.scrollHeight || 1;
  const offset = view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop;
  const doc = state.doc;
  const clamp = (ln: number) => Math.min(Math.max(1, ln), doc.lines);
  const top = (ln: number) => (offset + view.lineBlockAt(doc.line(clamp(ln)).from).top) / total;
  const bottom = (ln: number) =>
    (offset + view.lineBlockAt(doc.line(clamp(ln)).from).bottom) / total;

  const marks: Mark[] = [];
  const blocks = [...markedBlocks(state)].sort((a, b) => blockStart(a) - blockStart(b));
  blocks.forEach((block, i) => {
    const written = [...block.modified, ...block.added].sort((a, b) => a - b);
    const counts = `+${written.length} −${block.removed.length}`;
    const title = `change ${i + 1}/${blocks.length} · ${counts}`;
    if (written.length > 0) {
      const from = top(written[0]);
      marks.push({
        cls: block.modified.length > 0 ? "is-modified" : "is-added",
        top: from,
        height: bottom(written[written.length - 1]) - from,
        line: blockStart(block),
        title,
      });
    } else {
      const at = block.removedAt > doc.lines ? bottom(doc.lines) : top(block.removedAt);
      marks.push({ cls: "is-removed", top: at, height: 0, line: blockStart(block), title });
    }
  });
  for (const [lo, hi] of runs(flaggedLines(state))) {
    const from = top(lo);
    marks.push({
      cls: "is-flag",
      top: from,
      height: bottom(hi) - from,
      line: lo,
      title: lo === hi ? `flagged: line ${lo}` : `flagged: lines ${lo}–${hi}`,
    });
  }

  const shown = scroller.clientHeight / total;
  return {
    marks,
    view: shown >= 0.99 ? null : { top: scroller.scrollTop / total, height: shown },
    cursor: top(doc.lineAt(state.selection.main.head).number),
  };
}

const pct = (f: number) => `${(Math.min(Math.max(f, 0), 1) * 100).toFixed(3)}%`;

/**
 * The overview ruler: a strip at the viewer's right edge, beside the scrollbar, that
 * shows the whole file at once — its changes (the gutter signs' colours) and flags,
 * the part on screen, and the cursor — so a change out of sight is still in view. A
 * click on a mark goes to it, as `] c` would; anywhere else, to the line there. It
 * shows only while the file has something to mark.
 */
const rulerPlugin = ViewPlugin.fromClass(
  class {
    readonly dom: HTMLElement;
    readonly band: HTMLElement;
    readonly caret: HTMLElement;
    readonly marks: HTMLElement;
    frame: number | null = null;

    constructor(readonly view: EditorView) {
      this.dom = document.createElement("div");
      this.dom.className = "cm-overview-ruler";
      this.band = this.dom.appendChild(document.createElement("div"));
      this.band.className = "cm-ruler-view";
      this.marks = this.dom.appendChild(document.createElement("div"));
      this.caret = this.dom.appendChild(document.createElement("div"));
      this.caret.className = "cm-ruler-cursor";
      this.dom.addEventListener("mousedown", this.onMouseDown);
      view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
      view.dom.appendChild(this.dom);
      this.schedule();
    }

    update(update: ViewUpdate) {
      const marked = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setDiffMarks) || e.is(setFlagLines)),
      );
      if (
        marked ||
        update.docChanged ||
        update.selectionSet ||
        update.heightChanged ||
        update.geometryChanged ||
        update.viewportChanged
      ) {
        this.schedule();
      }
    }

    destroy() {
      if (this.frame != null) cancelAnimationFrame(this.frame);
      this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
      this.dom.remove();
    }

    schedule() {
      this.view.requestMeasure({
        key: this,
        read: (view) => measure(view),
        write: (layout) => this.draw(layout),
      });
    }

    // Scrolling moves only the band; one redraw per frame keeps up with it.
    onScroll = () => {
      if (this.frame != null) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        this.schedule();
      });
    };

    draw(layout: Layout | null) {
      this.dom.hidden = layout == null;
      if (!layout) return;
      this.band.hidden = layout.view == null;
      if (layout.view) {
        this.band.style.top = pct(layout.view.top);
        this.band.style.height = pct(layout.view.height);
      }
      this.caret.style.top = pct(layout.cursor);
      this.marks.replaceChildren(
        ...layout.marks.map((m) => {
          const el = document.createElement("div");
          el.className = `cm-ruler-mark ${m.cls}`;
          el.style.top = pct(m.top);
          el.style.height = pct(m.height);
          el.dataset.line = String(m.line);
          el.title = m.title;
          return el;
        }),
      );
    }

    onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const view = this.view;
      const mark = (event.target as HTMLElement).closest<HTMLElement>(".cm-ruler-mark");
      let line = Number(mark?.dataset.line);
      if (!mark) {
        const rect = this.dom.getBoundingClientRect();
        const scroller = view.scrollDOM;
        const offset =
          view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop;
        const at = ((event.clientY - rect.top) / rect.height) * scroller.scrollHeight - offset;
        line = view.state.doc.lineAt(view.lineBlockAtHeight(Math.max(0, at)).from).number;
      }
      // Focus first: it selects the window (and opens a preview), as a click in it would.
      view.focus();
      applyPosition(view, { line, col: 0, center: true });
    };
  },
);

export const overviewRuler: Extension = [
  rulerPlugin,
  // Room for the ruler beside the scroller — set through CodeMirror, which owns the
  // editor's classes.
  EditorView.editorAttributes.of((view) =>
    hasMarks(view.state) ? { class: "has-overview-ruler" } : null,
  ),
];
