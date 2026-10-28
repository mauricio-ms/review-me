import { useJumpStore } from "../state/jumps";
import { currentFile } from "./buffers";
import { projectCursor } from "./project-view";

/**
 * Remember where the selected window's file is, so `M-,` can come back to it.
 *
 * Called from the navigation gestures themselves (`navigateTo`, the fuzzy finder,
 * activating a tree row) rather than from `visitFile`, which they all share — that way
 * `jumpBack` can reuse the same open path without recording the position it is
 * leaving, which would turn `M-,` into a ping-pong between two lines.
 *
 * This module deliberately depends only on the stores and the view handles: `lib/xref`
 * and `lib/project` both need it, and putting it in either would make them circular.
 */
export function recordJump(): void {
  const file = currentFile();
  const cursor = projectCursor();
  if (!file || !cursor) return;
  useJumpStore.getState().push({
    file: file.path,
    choice: { source: file.source, label: file.sourceLabel },
    line: cursor.line,
    col: cursor.col,
  });
}
