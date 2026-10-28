import { useHistoryStore, type Place } from "../state/history";
import { useUIStore } from "../state/ui";
import { useWindowStore, windowShowing } from "../state/windows";
import { findFileBuffer, showBuffer } from "./buffers";
import { moveDiffCursor } from "./diff-view";
import { currentPlace } from "./jumps";
import { moveLogCursor } from "./log";
import { visitFile } from "./project";
import { placeCursor } from "./project-view";
import { selectWindow } from "./windows";

/**
 * Go to a place. A file already open in another window is gone back to *there* — after
 * `C-x 4 .` from a test, `M-,` returns to the test's window rather than replacing the
 * code beside it — else it shows in the selected window, reopened if it was killed.
 */
function visitPlace(place: Place): void {
  switch (place.kind) {
    case "file": {
      const ws = useWindowStore.getState();
      const open = findFileBuffer(place.choice.source, place.path);
      const elsewhere =
        open && ws.shown[ws.selected] !== open.id ? windowShowing(ws, open.id) : null;
      if (open && elsewhere != null) {
        placeCursor(elsewhere, open.id, place.line, place.col);
        selectWindow(elsewhere);
      } else {
        visitFile(place.path, place.choice, { line: place.line, col: place.col });
      }
      return;
    }
    case "diff":
      showBuffer("diff");
      moveDiffCursor(place.path, place.line);
      return;
    case "log":
      showBuffer("log");
      if (place.oid) moveLogCursor(place.oid);
      return;
  }
}

/** `M-,`: back to where the last move came from (the place left goes on ahead). */
export function goBack(): void {
  const place = useHistoryStore.getState().stepBack(currentPlace());
  if (place) visitPlace(place);
  else useUIStore.getState().showFlash("Nowhere further back");
}

/** `C-M-,`: forward again, to where `M-,` came back from. */
export function goForward(): void {
  const place = useHistoryStore.getState().stepForward(currentPlace());
  if (place) visitPlace(place);
  else useUIStore.getState().showFlash("Nowhere further forward");
}
