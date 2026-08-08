import { useJumpStore } from "../state/jumps";
import { useProjectStore } from "../state/project";
import { projectCursor } from "./project-view";

/**
 * Remember where the viewer is, so `M-,` can come back to it.
 *
 * Called from the navigation gestures themselves (`navigateTo`, the fuzzy finder,
 * activating a tree row) rather than from `openProjectFile`, which they all share —
 * that way `jumpBack` can reuse the same open path without recording the position it
 * is leaving, which would turn `M-,` into a ping-pong between two lines.
 *
 * This module deliberately depends only on the stores and the view handle: `lib/xref`
 * and `lib/project` both need it, and putting it in either would make them circular.
 */
export function recordJump(): void {
  const { openPath } = useProjectStore.getState();
  const cursor = projectCursor();
  if (!openPath || !cursor) return;
  useJumpStore.getState().push({
    file: openPath,
    line: cursor.line,
    col: cursor.col,
  });
}
