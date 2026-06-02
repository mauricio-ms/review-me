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
