import { EditorView } from "@codemirror/view";

import { selectWindow } from "../lib/windows";
import { gotoDefinitionAt } from "../lib/xref";

/** True when the platform go-to-definition modifier (Ctrl, or Cmd on macOS) is held. */
function modHeld(e: MouseEvent): boolean {
  return e.metaKey || e.ctrlKey;
}

/**
 * Ctrl/Cmd+click on a symbol in the project viewer jumps to its definition —
 * the IDE convention, layered on top of the existing `gd` vim action. While the
 * modifier is held the content shows a pointer cursor so the affordance is
 * discoverable. Plain clicks are left untouched (cursor placement / selection).
 */
export const xrefClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !modHeld(event)) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    event.preventDefault();
    // The click doesn't focus (it's prevented), so select its window by hand: the
    // definition is resolved from the file in the selected window.
    const win = view.dom.closest<HTMLElement>("[data-window]")?.dataset.window;
    if (win) selectWindow(Number(win));
    const line = view.state.doc.lineAt(pos);
    void gotoDefinitionAt(line.number, pos - line.from);
    return true;
  },
  mousemove(event, view) {
    view.contentDOM.classList.toggle("xref-mod", modHeld(event));
    return false;
  },
  mouseleave(_event, view) {
    view.contentDOM.classList.remove("xref-mod");
    return false;
  },
});
