import {
  type EditorState,
  type Extension,
  type Range,
  type Text,
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
import { getCM } from "@replit/codemirror-vim";

import { currentPlace, recordJump } from "../lib/jumps";
import { activeView } from "../lib/project-view";
import { clearNativeSearchHighlights, registerSearchView, repeatSearch } from "../lib/search";
import { indexSwiper, type SearchRepeat, type SwiperHit, type SwiperMatcher } from "../lib/swiper";
import { listSwiper, markMatches } from "../lib/swiper-list";
import { useMinibufferStore } from "../state/minibuffer";
import { useUIStore } from "../state/ui";
import { useSearchStore } from "../state/search";
import { activeBuffer, useWindowStore } from "../state/windows";
import { markedBlocks, removedLineElements, type ShownBlock } from "./diff-marks";
import { inVimInsertMode } from "./cm-shared";

/** A line a change took out: the `index`th of its block's removed lines. */
type RemovedLine = { block: string; index: number };

/**
 * What a running search shows in the file: its matches, and the selected line — one of
 * the document's, or a removed one.
 */
type Shown = { matcher: SwiperMatcher | null; line: number | null; removed: RemovedLine | null };

const setSwiper = StateEffect.define<Shown | null>();
const setMatcher = StateEffect.define<SwiperMatcher | null>();
const savedMatcher = () => {
  const { visible, matcher } = useSearchStore.getState();
  return visible ? matcher : null;
};
const matcherField = StateField.define<SwiperMatcher | null>({
  create: savedMatcher,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setMatcher)) return effect.value;
    return value;
  },
});

// Removed text has no document position of its own. Keep its actual search position
// until an ordinary cursor move or document replacement invalidates it.
const setLocation = StateEffect.define<{ entry: Searched; column: number } | null>();
const locationField = StateField.define<{ entry: Searched; column: number } | null>({
  create: () => null,
  update(value, tr) {
    if (tr.docChanged || tr.selection) value = null;
    for (const effect of tr.effects) if (effect.is(setLocation)) value = effect.value;
    return value;
  },
});

const swiperField = StateField.define<Shown | null>({
  create: () => null,
  update(shown, tr) {
    for (const e of tr.effects) if (e.is(setSwiper)) return e.value;
    return shown;
  },
});

/** The source line Swiper is displaying, even while the minibuffer has focus. */
export function swiperLine(state: EditorState): number | null {
  return state.field(swiperField, false)?.line ?? null;
}

const matchMark = Decoration.mark({ class: "cm-swiper-match" });
const currentMark = Decoration.mark({ class: "cm-swiper-match cm-swiper-current" });
const currentLine = Decoration.line({ class: "cm-swiper-line" });

/** The matches on the lines in view — a search can match every line of a long file. */
function marks(view: EditorView): DecorationSet {
  const shown = view.state.field(swiperField);
  const matcher = shown ? shown.matcher : view.state.field(matcherField);
  if (!shown && !matcher) return Decoration.none;
  const location = view.state.field(locationField)?.entry;
  const selectedLine = shown ? shown.line : location && !("line" in location)
    ? null : view.state.doc.lineAt(view.state.selection.main.head).number;
  const { doc } = view.state;
  const out: Range<Decoration>[] = [];
  let last = 0;
  for (const { from, to } of view.visibleRanges) {
    const end = doc.lineAt(to).number;
    for (let n = Math.max(last + 1, doc.lineAt(from).number); n <= end; n++) {
      const line = doc.line(n);
      const spans = matcher?.match(line.text) ?? null;
      const current = n === selectedLine && (!matcher || spans !== null);
      if (current) out.push(currentLine.range(line.from));
      for (const [a, b] of spans ?? []) {
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
  const location = view.state.field(locationField)?.entry;
  const removed = shown ? shown.removed : location && !("line" in location) ? location : null;
  const matcher = shown ? shown.matcher : view.state.field(matcherField);
  const lines = removedLineElements(view);
  const current = matcher && removed
    ? (removedLineElements(view, removed.block)[removed.index] ?? null)
    : null;
  for (const line of lines) line.classList.toggle("cm-swiper-line", line === current);
  markMatches(lines, current, matcher, view);
}

const swiperMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    /** Whether removed lines may be lit — cleared once, so another search keeps its marks. */
    lit = false;
    unsubscribe: () => void;
    unregister: () => void;
    nativePrompt = false;
    alive = true;
    adoptNative = () => {
      if (!this.alive) return;
      const search = getCM(this.view)?.state.vim?.searchState_;
      const pattern = search?.getQuery();
      const message = getCM(this.view)?.state.dialog?.querySelector(".cm-vim-message")?.textContent;
      const invalid = message?.startsWith("Invalid regex:") || message === "No word under cursor";
      if (pattern && !invalid) {
        useSearchStore.getState().acceptNative(pattern, !!search?.isReversed());
      }
      clearNativeSearchHighlights();
    };
    nativeSearch = (event: KeyboardEvent) => {
      const cm = getCM(this.view);
      if (this.nativePrompt && event.target instanceof HTMLInputElement && cm?.state.dialog?.contains(event.target)) {
        if (event.key === "Enter") {
          this.nativePrompt = false;
          queueMicrotask(this.adoptNative);
        } else if (event.key === "Escape" || (event.ctrlKey && ["[", "c"].includes(event.key))) {
          this.nativePrompt = false;
        }
        return;
      }
      if (!event.ctrlKey && !event.altKey && !event.metaKey &&
        ["/", "?", "*", "#"].includes(event.key) && !inVimInsertMode(this.view) &&
        !cm?.state.vim?.expectLiteralNext) {
        if (event.key === "/" || event.key === "?") this.nativePrompt = true;
        else queueMicrotask(this.adoptNative);
      }
    };
    constructor(readonly view: EditorView) {
      this.decorations = marks(view);
      this.unregister = registerSearchView(view);
      // Vim consumes its search keys before ordinary CodeMirror event handlers.
      view.dom.addEventListener("keydown", this.nativeSearch, true);
      this.unsubscribe = useSearchStore.subscribe(() => {
        const matcher = savedMatcher();
        if (view.state.field(matcherField) !== matcher) view.dispatch({ effects: setMatcher.of(matcher) });
      });
      // A new window can open while persistent highlights are already on.
      if (savedMatcher()) {
        this.lit = true;
        view.requestMeasure({ key: this, read: () => null, write: () => lightRemoved(view) });
      }
    }
    update(update: ViewUpdate) {
      // Native Vim paints matches on a delayed timer. Once accepted, only the shared
      // search owns highlighting; a late native paint must not resurrect cleared marks.
      const native = getCM(update.view)?.cm6Query as { forVim?: boolean } | undefined;
      if (!this.nativePrompt && native?.forVim) {
        queueMicrotask(() => {
          if (this.alive && !this.nativePrompt && native.forVim) clearNativeSearchHighlights();
        });
      }
      const shown = update.state.field(swiperField);
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.startState.field(matcherField) !== update.state.field(matcherField) ||
        update.startState.field(swiperField) !== shown
      ) {
        this.decorations = marks(update.view);
      }
      // Any update can redraw a widget, which drops its marks: light them again once
      // the DOM is drawn.
      if (shown || update.state.field(matcherField) || this.lit) {
        this.lit = !!shown || !!update.state.field(matcherField);
        update.view.requestMeasure({ key: this, read: () => null, write: (_, view) => lightRemoved(view) });
      }
    }
    destroy() {
      this.alive = false;
      this.unsubscribe();
      this.unregister();
      this.view.dom.removeEventListener("keydown", this.nativeSearch, true);
      markMatches([], null, null, this.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** The viewer's part of a Swiper search: every match in view, the selected line lit. */
export const swiperHighlight: Extension = [swiperField, matcherField, locationField, swiperMarks];

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
function searchedLines(state: EditorState, blocks: readonly ShownBlock[]) {
  const { doc } = state;
  const above = new Map<number, ShownBlock[]>();
  for (const block of blocks) {
    if (!block.showRemoved || block.removed.length === 0) continue;
    const at = Math.min(Math.max(1, block.removedAt), doc.lines + 1);
    above.set(at, [...(above.get(at) ?? []), block]);
  }
  const searched: Searched[] = [];
  const lines: string[] = [];
  const labels: string[] = [];
  const lineIndices: number[] = [];
  const removedIndices = new Map<string, number[]>();
  for (let n = 1; n <= doc.lines + 1; n++) {
    for (const block of above.get(n) ?? []) {
      block.removed.forEach((line, index) => {
        const indices = removedIndices.get(block.id) ?? [];
        indices[index] = searched.length;
        removedIndices.set(block.id, indices);
        searched.push({ block: block.id, index });
        lines.push(line.content);
        labels.push(`${line.oldLine ?? ""} −`);
      });
    }
    if (n > doc.lines) break;
    lineIndices[n] = searched.length;
    searched.push({ line: n });
    lines.push(doc.line(n).text);
    // Room for the removed lines' mark, so the numbers line up.
    labels.push(`${n}\u00a0\u00a0`);
  }
  return { searched, lines, labels: above.size > 0 ? labels : undefined, lineIndices, removedIndices };
}

type SearchIndex = ReturnType<typeof searchedLines> & {
  doc: Text;
  blocks: readonly ShownBlock[];
  matcher: SwiperMatcher | null;
  hits: SwiperHit[];
};
const searchIndexes = new WeakMap<EditorView, SearchIndex>();

function searchIndex(view: EditorView): SearchIndex {
  const { doc } = view.state;
  const blocks = markedBlocks(view.state);
  const cached = searchIndexes.get(view);
  if (cached?.doc === doc && cached.blocks === blocks) return cached;
  const index = { ...searchedLines(view.state, blocks), doc, blocks, matcher: null, hits: [] };
  searchIndexes.set(view, index);
  return index;
}

/**
 * `C-s`: Swiper over the file in `view`. The minibuffer lists the lines that match as
 * you type, including deleted lines only while `changed` is on. The file follows the
 * selected one: the cursor on its first match, recentered only when it's off screen,
 * with every match in view lit. `RET` stays there (a jump `M-,` comes back from);
 * `C-g` puts the cursor and the scroll back. Search never changes deleted-line visibility.
 */
export function swiper(view: EditorView, repeat?: SearchRepeat): void {
  const { state } = view;
  const selection = state.selection.main;
  const originLocation = state.field(locationField, false) ?? null;
  const scroll = view.scrollSnapshot();
  const word = state.wordAt(selection.head);
  const index = searchIndex(view);
  const { searched, lines, labels, lineIndices, removedIndices } = index;
  const start = lineIndices[state.doc.lineAt(selection.head).number];

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
        effects: [setLocation.of({ entry, column: hit.spans[0]?.[0] ?? 0 }),
          ...(onScreen(view, at) ? [] : [EditorView.scrollIntoView(at, { y: "center" })])],
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
      effects: [setLocation.of({ entry, column: hit.spans[0]?.[0] ?? 0 }),
        ...(near ? [] : [EditorView.scrollIntoView(at, { y: "center" })])],
    });
    // The widget is drawn by the next frame, scrolled to if it was far: then the line.
    const move = moves;
    requestAnimationFrame(() => {
      if (move === moves && alive() && view.state.field(locationField, false)?.entry === entry) {
        scrollToRemoved(view, entry);
      }
    });
  };

  if (repeat) {
    const location = state.field(locationField, false);
    const at = location ? "line" in location.entry ? lineIndices[location.entry.line]
      : removedIndices.get(location.entry.block)?.[location.entry.index] : undefined;
    const column = selection.head - state.doc.lineAt(selection.head).from;
    const { matcher } = useSearchStore.getState();
    if (matcher && index.matcher !== matcher) {
      index.matcher = matcher;
      index.hits = indexSwiper(lines, matcher, true);
    }
    const hit = repeatSearch(lines, { index: at ?? start, column: at == null ? column : location!.column }, repeat, true, index.hits);
    if (hit) goto(hit);
    return;
  }

  const from = currentPlace();
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
        effects: [scroll, setLocation.of(originLocation)],
      });
    },
  });
}

/**
 * `M-x swiper` (and the viewer's `C-s`): Swiper over whatever has the keyboard — the
 * diff's rows, the log's commits (`lib/swiper-list.ts`), or the selected window's file.
 */
export function swiperHere(repeat?: SearchRepeat): void {
  const windows = useWindowStore.getState();
  const buffer = activeBuffer(windows);
  const listBuffer = repeat && windows.treeFocused ? "tree"
    : buffer === "diff" || buffer === "log" || (repeat && buffer === "help") ? buffer : null;
  const list = listBuffer ? listSwiper(listBuffer) : null;
  const view = buffer === "project" ? activeView() : null;
  if (list) list(repeat);
  else if (view) swiper(view, repeat);
  else useUIStore.getState().showFlash("Nothing here to search");
}
