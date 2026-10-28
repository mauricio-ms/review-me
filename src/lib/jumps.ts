import { useHistoryStore, type Place } from "../state/history";
import { useUIStore } from "../state/ui";
import { isFileKey, selectedBuffer, useWindowStore } from "../state/windows";
import { currentFile } from "./buffers";
import { logCursor } from "./log";
import { projectCursor } from "./project-view";

/**
 * Where the selected window is: a spot in its file, the diff's row, or the log's
 * commit. Help is nowhere worth coming back to.
 */
export function currentPlace(): Place | null {
  const key = selectedBuffer(useWindowStore.getState());
  if (isFileKey(key)) {
    const file = currentFile();
    const cursor = projectCursor();
    if (!file || !cursor) return null;
    return {
      kind: "file",
      path: file.path,
      choice: { source: file.source, label: file.sourceLabel },
      line: cursor.line,
      col: cursor.col,
    };
  }
  if (key === "diff") {
    const cursor = useUIStore.getState().diffCursor;
    return { kind: "diff", path: cursor?.path ?? null, line: cursor?.line ?? null };
  }
  if (key === "log") return { kind: "log", oid: logCursor() };
  return null;
}

/**
 * Remember where the selected window is, so `M-,` can come back to it.
 *
 * Called from the navigation gestures themselves (`navigateTo`, opening from the
 * finder, the tree or the diff, `C-x b`, …) rather than from `visitFile` or
 * `showBuffer`, which they share — that way going back and forth can reuse the same
 * paths without recording the place it is leaving, which `M-,` / `C-M-,` do themselves.
 *
 * This module deliberately depends only on the stores and the view handles: `lib/xref`
 * and `lib/project` both need it, and putting it in either would make them circular.
 */
export function recordJump(): void {
  const place = currentPlace();
  if (place) useHistoryStore.getState().record(place);
}
