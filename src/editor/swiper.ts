import {
  type EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

import { currentPlace, recordJump } from "../lib/jumps";
import { activeView } from "../lib/project-view";
import type { SwiperHit, SwiperMatcher } from "../lib/swiper";
import { listSwiper, markMatches } from "../lib/swiper-list";
import { useMinibufferStore } from "../state/minibuffer";
import { useUIStore } from "../state/ui";
import { activeBuffer, useWindowStore } from "../state/windows";
import { markedBlocks, removedLineElements, type ShownBlock } from "./diff-marks";

/** A line a change took out: the `index`th of its block's removed lines. */
type RemovedLine = { block: string; index: number };

/**
 * What a running search shows in the file: its matches, and the selected line — one of
 * the document's, or a removed one.
 */
type Shown = { matcher: SwiperMatcher | null; line: number | null; removed: RemovedLine | null };

const setSwiper = StateEffect.define<Shown | null>();

const swiperField = StateField.define<Shown | null>({
  create: () => null,
  update(shown, tr) {
    for (const e of tr.effects) if (e.is(setSwiper)) return e.value;
    return shown;
  },
});

const matchMark = Decoration.mark({ class: "cm-swiper-match" });
const currentMark = Decoration.mark({ class: "cm-swiper-match cm-swiper-current" });
const currentLine = Decoration.line({ class: "cm-swiper-line" });

/** The matches on the lines in view — a search can match every line of a long file. */
function marks(view: EditorView): DecorationSet {
  const shown = view.state.field(swiperField);
  if (!shown) return Decoration.none;
  const { doc } = view.state;
  const out: Range<Decoration>[] = [];
  let last = 0;
  for (const { from, to } of view.visibleRanges) {
    const end = doc.lineAt(to).number;
    for (let n = Math.max(last + 1, doc.lineAt(from).number); n <= end; n++) {
      const line = doc.line(n);
      const current = n === shown.line;
      if (current) out.push(currentLine.range(line.from));
      for (const [a, b] of shown.matcher?.match(line.text) ?? []) {
        out.push((current ? currentMark : matchMark).range(line.from + a, line.from + b));
      }
      last = n;
    }
  }
  return Decoration.set(out, true);
}

/**
 * The removed lines on screen are a widget's DOM, not the document's text, so their
 * matches light as the diff's rows' do (CSS highlights), and the selected one wears the
 * line's class itself — CodeMirror leaves a widget's insides alone.
 */
function lightRemoved(view: EditorView): void {
  const shown = view.state.field(swiperField);
  const lines = removedLineElements(view);
  const current = shown?.removed
    ? (removedLineElements(view, shown.removed.block)[shown.removed.index] ?? null)
    : null;
  for (const line of lines) line.classList.toggle("cm-swiper-line", line === current);
  markMatches(lines, current, shown?.matcher ?? null);
}

const swiperMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    /** Whether removed lines may be lit — cleared once, so another search keeps its marks. */
    lit = false;
    constructor(view: EditorView) {
      this.decorations = marks(view);
    }
    update(update: ViewUpdate) {
      const shown = update.state.field(swiperField);
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.startState.field(swiperField) !== shown
      ) {
        this.decorations = marks(update.view);
      }
      // Any update can redraw a widget, which drops its marks: light them again once
      // the DOM is drawn.
      if (shown || this.lit) {
        this.lit = !!shown;
        update.view.requestMeasure({ key: this, read: () => null, write: (_, view) => lightRemoved(view) });
      }
    }
    destroy() {
      if (this.lit) markMatches([], null, null);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** The viewer's part of a Swiper search: every match in view, the selected line lit. */
export const swiperHighlight: Extension = [swiperField, swiperMarks];

/** Whether `pos`'s line is wholly on screen, so going there needn't scroll. */
function onScreen(view: EditorView, pos: number): boolean {
  const rect = view.scrollDOM.getBoundingClientRect();
  const block = view.lineBlockAt(pos);
  const top = view.documentTop + block.top;
  return top >= rect.top && top + block.height <= rect.bottom;
}

/** A removed line drawn in `view`, centered unless it's wholly on screen already. */
function scrollToRemoved(view: EditorView, { block, index }: RemovedLine): void {
  const line = removedLineElements(view, block)[index];
  if (!line) return;
  const box = view.scrollDOM.getBoundingClientRect();
  const rect = line.getBoundingClientRect();
  if (rect.top >= box.top && rect.bottom <= box.bottom) return;
  view.scrollDOM.scrollTop += rect.top + rect.height / 2 - (box.top + box.height / 2);
}

/** A line Swiper reads in a file: the document's (1-based), or one a change took out. */
type Searched = { line: number } | RemovedLine;

/**
 * The lines a search reads in `state`, in the order they read: the document's, with
 * each change's visible removed lines just above where they went. Labelled
 * (removed ones by their old number) only when there are removed lines among them.
 */
function searchedLines(state: EditorState, cursorLine: number) {
  const { doc } = state;
  const above = new Map<number, ShownBlock[]>();
  for (const block of markedBlocks(state)) {
    if (!block.showRemoved || block.removed.length === 0) continue;
    const at = Math.min(Math.max(1, block.removedAt), doc.lines + 1);
    above.set(at, [...(above.get(at) ?? []), block]);
  }
  const searched: Searched[] = [];
  const lines: string[] = [];
  const labels: string[] = [];
  let start = 0;
  for (let n = 1; n <= doc.lines + 1; n++) {
    for (const block of above.get(n) ?? []) {
      block.removed.forEach((line, index) => {
        searched.push({ block: block.id, index });
        lines.push(line.content);
        labels.push(`${line.oldLine ?? ""} −`);
      });
    }
    if (n > doc.lines) break;
    if (n === cursorLine) start = searched.length;
    searched.push({ line: n });
    lines.push(doc.line(n).text);
    // Room for the removed lines' mark, so the numbers line up.
    labels.push(`${n}\u00a0\u00a0`);
  }
  return { searched, lines, labels: above.size > 0 ? labels : undefined, start };
}

/**
 * `C-s`: Swiper over the file in `view`. The minibuffer lists the lines that match as
 * you type, including deleted lines only while `changed` is on. The file follows the
 * selected one: the cursor on its first match, recentered only when it's off screen,
 * with every match in view lit. `RET` stays there (a jump `M-,` comes back from);
 * `C-g` puts the cursor and the scroll back. Search never changes deleted-line visibility.
 */
export function swiper(view: EditorView): void {
  const { state } = view;
  const from = currentPlace();
  const selection = state.selection.main;
  const scroll = view.scrollSnapshot();
  const word = state.wordAt(selection.head);
  const { searched, lines, labels, start } = searchedLines(
    state,
    state.doc.lineAt(selection.head).number,
  );

  // A refresh can re-read the file under the search: nothing below may outlive it.
  const alive = () => view.dom.isConnected;
  const show = (shown: Shown | null) => {
    if (alive()) view.dispatch({ effects: setSwiper.of(shown) });
  };
  // Bumped per move, so a removed line's late scroll can't follow a newer one.
  let moves = 0;
  const goto = (hit: SwiperHit) => {
    const entry = searched[hit.index];
    const { doc } = view.state;
    moves++;
    if (!alive() || !entry) return;
    if ("line" in entry) {
      if (entry.line > doc.lines) return;
      const line = doc.line(entry.line);
      const at = Math.min(line.from + (hit.spans[0]?.[0] ?? 0), line.to);
      view.dispatch({
        selection: { anchor: at },
        effects: onScreen(view, at) ? [] : [EditorView.scrollIntoView(at, { y: "center" })],
      });
      return;
    }
    // The cursor goes to the line the removed ones sat above.
    const block = markedBlocks(view.state).find((b) => b.id === entry.block);
    if (!block?.showRemoved) return;
    const at = block.removedAt > doc.lines ? doc.length : doc.line(Math.max(1, block.removedAt)).from;
    const near = at >= view.viewport.from && at <= view.viewport.to;
    view.dispatch({
      selection: { anchor: at },
      effects: near ? [] : [EditorView.scrollIntoView(at, { y: "center" })],
    });
    // The widget is drawn by the next frame, scrolled to if it was far: then the line.
    const move = moves;
    requestAnimationFrame(() => {
      if (move === moves && alive()) scrollToRemoved(view, entry);
    });
  };

  useMinibufferStore.getState().open({
    kind: "swiper",
    lines,
    labels,
    start,
    atPoint: word ? state.sliceDoc(word.from, word.to) : null,
    onMove: (hit, matcher) => {
      if (hit) goto(hit);
      const entry = hit ? searched[hit.index] : undefined;
      show({
        matcher,
        line: entry && "line" in entry ? entry.line : null,
        removed: entry && !("line" in entry) ? entry : null,
      });
    },
    onAccept: (hit) => {
      show(null);
      goto(hit);
      recordJump(from);
    },
    onCancel: () => {
      moves++;
      show(null);
      if (!alive()) return;
      const end = view.state.doc.length;
      view.dispatch({
        selection: { anchor: Math.min(selection.anchor, end), head: Math.min(selection.head, end) },
        effects: scroll,
      });
    },
  });
}

/**
 * `M-x swiper` (and the viewer's `C-s`): Swiper over whatever has the keyboard — the
 * diff's rows, the log's commits (`lib/swiper-list.ts`), or the selected window's file.
 */
export function swiperHere(): void {
  const buffer = activeBuffer(useWindowStore.getState());
  const list = buffer === "diff" || buffer === "log" ? listSwiper(buffer) : null;
  const view = buffer === "project" ? activeView() : null;
  if (list) list();
  else if (view) swiper(view);
  else useUIStore.getState().showFlash("Nothing here to search");
}
