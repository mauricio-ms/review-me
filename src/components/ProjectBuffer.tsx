import { useEffect, useRef } from "react";

import { useUIStore } from "../state/ui";

/**
 * Project mode: an IDE-style file tree + viewer for navigating ALL files,
 * regardless of change status. Full implementation arrives in M3; for now this is
 * a focusable placeholder so buffer switching works end to end.
 */
export default function ProjectBuffer() {
  const activeBuffer = useUIStore((s) => s.activeBuffer);
  const focusRequest = useUIStore((s) => s.focusRequest);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (activeBuffer === "project") {
      rootRef.current?.focus({ preventScroll: true });
    }
  }, [activeBuffer, focusRequest]);

  return (
    <div ref={rootRef} className="buffer is-empty project-buffer" tabIndex={0}>
      <div className="empty-state">
        <div className="empty-title">project mode</div>
        <div className="empty-hint">
          Browse every file in the repository here. Coming in a later milestone.
          <br />
          Press <kbd>Space</kbd> for commands, or <kbd>b</kbd> <kbd>d</kbd> to
          return to the diff.
        </div>
      </div>
    </div>
  );
}
