import type { EditorView } from "@codemirror/view";

// Module-level handle on the project viewer's CodeMirror view, so commands (e.g.
// "flag line") can read the current selection without prop-drilling.
let activeView: EditorView | null = null;

export function setProjectView(view: EditorView | null): void {
  activeView = view;
}

/** 1-based [lo, hi] line range of the current selection (or cursor line). */
export function projectSelectionRange(): { lo: number; hi: number } | null {
  if (!activeView) return null;
  const { state } = activeView;
  const sel = state.selection.main;
  return {
    lo: state.doc.lineAt(sel.from).number,
    hi: state.doc.lineAt(sel.to).number,
  };
}

/** Cursor position as 1-based line + 0-based column. */
export function projectCursor(): { line: number; col: number } | null {
  if (!activeView) return null;
  const { state } = activeView;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, col: head - line.from };
}

/** Move the viewer cursor to a 1-based line / 0-based col and scroll to it. */
export function setProjectCursor(line: number, col = 0): void {
  const view = activeView;
  if (!view) return;
  const lineCount = view.state.doc.lines;
  const ln = Math.min(Math.max(1, line), lineCount);
  const lineObj = view.state.doc.line(ln);
  const pos = Math.min(lineObj.from + col, lineObj.to);
  view.dispatch({
    selection: { anchor: pos, head: pos },
    scrollIntoView: true,
  });
  view.focus();
}
