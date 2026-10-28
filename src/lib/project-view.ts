import { EditorView } from "@codemirror/view";

import {
  useWindowStore,
  type FileBufferId,
  type WindowId,
} from "../state/windows";

// Module-level handles on each window's CodeMirror view, so commands (`M-x flag`, xref)
// can read the selected window's cursor without prop-drilling.
const views = new Map<WindowId, { buffer: FileBufferId; view: EditorView }>();

export function registerFileView(
  win: WindowId,
  buffer: FileBufferId,
  view: EditorView | null,
): void {
  if (view) views.set(win, { buffer, view });
  else if (views.get(win)?.buffer === buffer) views.delete(win);
}

/** The view of the file in the selected window, if it shows one. */
function activeView(): EditorView | null {
  const s = useWindowStore.getState();
  const entry = views.get(s.selected);
  return entry && entry.buffer === s.shown[s.selected] ? entry.view : null;
}

/** 1-based [lo, hi] line range of the current selection (or cursor line). */
export function projectSelectionRange(): { lo: number; hi: number } | null {
  const view = activeView();
  if (!view) return null;
  const { state } = view;
  const sel = state.selection.main;
  return {
    lo: state.doc.lineAt(sel.from).number,
    hi: state.doc.lineAt(sel.to).number,
  };
}

/** Cursor position as 1-based line + 0-based column. */
export function projectCursor(): { line: number; col: number } | null {
  const view = activeView();
  if (!view) return null;
  const { state } = view;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, col: head - line.from };
}

/**
 * Move the selected window's cursor to a 1-based line / 0-based col and scroll to it —
 * to the middle of the view with `center`, as a jump does.
 */
export function setProjectCursor(line: number, col = 0, center = false): void {
  const view = activeView();
  if (!view) return;
  applyPosition(view, { line, col, center });
  view.focus();
}

// ---------- positions ----------

/**
 * Where a window's view of a file stands: the cursor, and the line at the top of the
 * view. `center` asks for the cursor mid-screen instead (a jump to it).
 */
export type ViewPos = { line: number; col: number; top?: number; center?: boolean };

/** Per window, per buffer — so a file shown in two windows keeps two places. */
const positions = new Map<string, ViewPos>();

const posKey = (win: WindowId, buffer: FileBufferId) => `${win}|${buffer}`;

/** Where window `win` left `buffer` (or was asked to put it). */
export function positionOf(win: WindowId, buffer: FileBufferId): ViewPos | undefined {
  return positions.get(posKey(win, buffer));
}

export function savePosition(win: WindowId, buffer: FileBufferId, pos: ViewPos): void {
  positions.set(posKey(win, buffer), pos);
}

/** Forget every window's place in buffers that were killed. */
export function forgetPositions(buffers: FileBufferId[]): void {
  const gone = new Set<string>(buffers);
  for (const key of positions.keys()) {
    if (gone.has(key.slice(key.indexOf("|") + 1))) positions.delete(key);
  }
}

/**
 * Put window `win`'s view of `buffer` at a line: now, when the window already shows it,
 * else as soon as it does — no waiting for the view to mount.
 */
export function placeCursor(
  win: WindowId,
  buffer: FileBufferId,
  line: number,
  col = 0,
): void {
  const pos = { line, col, center: true };
  const entry = views.get(win);
  if (entry?.buffer === buffer) applyPosition(entry.view, pos);
  else savePosition(win, buffer, pos);
}

/** Move a view's cursor (and scroll) to `pos`, clamped to the document. */
export function applyPosition(view: EditorView, pos: ViewPos): void {
  const { doc } = view.state;
  const clampLine = (n: number) => Math.min(Math.max(1, n), doc.lines);
  const line = doc.line(clampLine(pos.line));
  const at = Math.min(line.from + Math.max(0, pos.col), line.to);
  view.dispatch({
    selection: { anchor: at, head: at },
    effects:
      pos.top != null && !pos.center
        ? EditorView.scrollIntoView(doc.line(clampLine(pos.top)).from, { y: "start" })
        : EditorView.scrollIntoView(at, { y: pos.center ? "center" : "nearest" }),
  });
}

/** The first line visible at the top of a view. */
export function topLine(view: EditorView): number {
  const height = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
  const block = view.lineBlockAtHeight(Math.max(0, height));
  return view.state.doc.lineAt(block.from).number;
}
