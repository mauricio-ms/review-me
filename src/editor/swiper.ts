import { type Extension, type Range, StateEffect, StateField } from "@codemirror/state";
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
import { listSwiper } from "../lib/swiper-list";
import { useMinibufferStore } from "../state/minibuffer";
import { useUIStore } from "../state/ui";
import { activeBuffer, useWindowStore } from "../state/windows";

/** What a running search shows in the file: its matches, and the selected line. */
type Shown = { matcher: SwiperMatcher | null; line: number | null };

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

const swiperMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = marks(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.startState.field(swiperField) !== update.state.field(swiperField)
      ) {
        this.decorations = marks(update.view);
      }
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

/**
 * `C-s`: Swiper over the file in `view`. The minibuffer lists the lines that match as
 * you type; the file follows the selected one — the cursor on its first match,
 * recentered only when it's off screen — with every match in view lit. `RET` stays
 * there (a jump `M-,` comes back from); `C-g` puts the cursor and the scroll back.
 */
export function swiper(view: EditorView): void {
  const { state } = view;
  const from = currentPlace();
  const selection = state.selection.main;
  const scroll = view.scrollSnapshot();
  const word = state.wordAt(selection.head);

  // A refresh can re-read the file under the search: nothing below may outlive it.
  const alive = () => view.dom.isConnected;
  const show = (shown: Shown | null) => {
    if (alive()) view.dispatch({ effects: setSwiper.of(shown) });
  };
  const goto = (hit: SwiperHit) => {
    const { doc } = view.state;
    if (!alive() || hit.index >= doc.lines) return;
    const line = doc.line(hit.index + 1);
    const at = Math.min(line.from + (hit.spans[0]?.[0] ?? 0), line.to);
    view.dispatch({
      selection: { anchor: at },
      effects: onScreen(view, at) ? [] : EditorView.scrollIntoView(at, { y: "center" }),
    });
  };

  useMinibufferStore.getState().open({
    kind: "swiper",
    lines: state.doc.toJSON(),
    start: state.doc.lineAt(selection.head).number - 1,
    atPoint: word ? state.sliceDoc(word.from, word.to) : null,
    onMove: (hit, matcher) => {
      if (hit) goto(hit);
      show({ matcher, line: hit ? hit.index + 1 : null });
    },
    onAccept: (hit) => {
      show(null);
      goto(hit);
      recordJump(from);
    },
    onCancel: () => {
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
