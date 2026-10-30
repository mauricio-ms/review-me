import { useMinibufferStore } from "../state/minibuffer";
import { currentPlace, recordJump } from "./jumps";
import type { Span, SwiperMatcher } from "./swiper";

/**
 * Swiper over the diff buffer's and the log's rows — the twin of `editor/swiper.ts`,
 * which searches a file in CodeMirror. These buffers are lists of rows rather than a
 * document, so each one hands over its rows as lines and moves its own cursor; this
 * module opens the minibuffer for them and lights the matches on screen.
 */

/** The buffers that search their rows; each registers how while it's mounted. */
export type ListBuffer = "diff" | "log";

const starters = new Map<ListBuffer, () => void>();

export function setListSwiper(buffer: ListBuffer, start: (() => void) | null): void {
  if (start) starters.set(buffer, start);
  else starters.delete(buffer);
}

/** How `buffer` starts a search, if it is mounted. */
export function listSwiper(buffer: ListBuffer): (() => void) | null {
  return starters.get(buffer) ?? null;
}

export type ListSearch = {
  /** Each row's searched text. */
  lines: string[];
  /** Each row's where, shown beside it (a line number, a short oid). */
  labels: string[];
  /** The row the cursor is on, or the first one after it. */
  start: number;
  /**
   * Put the cursor on row `index` (null: leave it) and light `matcher`'s matches (null:
   * none) — revealing the row first if it's folded away.
   */
  show: (index: number | null, matcher: SwiperMatcher | null) => void;
  /** Put the cursor back — and whatever `show` unfolded, and the scroll. */
  restore: () => void;
};

/**
 * Swiper over a list buffer: the buffer follows the selected row; `RET` stays there (a
 * jump `M-,` comes back from), `C-g` puts it back.
 */
export function swipeList(search: ListSearch): void {
  const from = currentPlace();
  useMinibufferStore.getState().open({
    kind: "swiper",
    lines: search.lines,
    labels: search.labels,
    start: search.start,
    atPoint: null,
    onMove: (hit, matcher) => search.show(hit ? hit.index : null, matcher),
    onAccept: (hit) => {
      search.show(hit.index, null);
      recordJump(from);
    },
    onCancel: () => {
      search.show(null, null);
      search.restore();
    },
  });
}

// ---------- marks ----------

/**
 * The matches light up through CSS custom highlights (`::highlight(swiper-match)` in
 * styles.css), which mark text ranges without touching the rows' markup — a row's text
 * is split into word-diff spans, path folders and the like. Without the API (an older
 * WebKit) only the minibuffer marks them.
 */
const registry = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;

/** DOM ranges over `element`'s text for `spans` of its `textContent`. */
function rangesOf(element: HTMLElement, spans: Span[]): Range[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  const out: Range[] = [];
  for (const [from, to] of spans) {
    const range = document.createRange();
    let offset = 0;
    let started = false;
    for (const node of nodes) {
      const end = offset + node.length;
      if (!started && from < end) {
        range.setStart(node, from - offset);
        started = true;
      }
      if (started && to <= end) {
        range.setEnd(node, to - offset);
        out.push(range);
        break;
      }
      offset = end;
    }
  }
  return out;
}

/**
 * Light `matcher`'s matches in `targets` — the text of each row on screen that a search
 * reads — and those in `current`, the selected row's, brighter. A null matcher clears
 * them.
 */
export function markMatches(
  targets: Iterable<HTMLElement>,
  current: HTMLElement | null,
  matcher: SwiperMatcher | null,
): void {
  if (!registry) return;
  // Always delete first: WebKitGTK repaints a highlight when its name is added to the
  // registry, not when the name is set to a new one — so a set alone leaves the old
  // marks on screen and the new ones unpainted.
  registry.delete("swiper-match");
  registry.delete("swiper-current");
  if (!matcher) return;
  const matches: Range[] = [];
  const selected: Range[] = [];
  for (const element of targets) {
    const spans = matcher.match(element.textContent ?? "");
    if (spans?.length) (element === current ? selected : matches).push(...rangesOf(element, spans));
  }
  registry.set("swiper-match", new Highlight(...matches));
  registry.set("swiper-current", new Highlight(...selected));
}
