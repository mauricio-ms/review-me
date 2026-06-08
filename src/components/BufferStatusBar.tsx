import { reviewProgress } from "../lib/coverage";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore } from "../state/ui";

export default function BufferStatusBar() {
  const repo = useRepoStore((s) => s.repo);
  const diff = useRepoStore((s) => s.diff);
  const reviewed = useTagsStore((s) => s.reviewed);
  const flags = useTagsStore((s) => s.flags);
  const ignored = useTagsStore((s) => s.ignored);
  const activeBuffer = useUIStore((s) => s.activeBuffer);
  const vimMode = useUIStore((s) => s.vimMode);

  const files = diff?.files ?? [];
  const { done, total } = reviewProgress(files, reviewed);

  return (
    <div className="status-bar">
      <span className="status-segment status-mode">{vimMode}</span>
      <span className="status-segment status-buffer">{activeBuffer}</span>
      {repo && (
        <>
          <span className="status-segment status-branch">⎇ {repo.branch}</span>
          <span className="status-segment status-changes">
            {files.length} changed
          </span>
          {activeBuffer === "diff" && total > 0 && (
            <span className="status-segment status-reviewed">
              ✓ {done}/{total} hunks
            </span>
          )}
          {flags.length > 0 && (
            <span className="status-segment status-flagged">
              ⚑ {flags.length}
            </span>
          )}
          {ignored.length > 0 && (
            <span className="status-segment status-ignored">
              ⊘ {ignored.length}
            </span>
          )}
        </>
      )}
      <span className="status-spacer" />
      <span className="status-segment status-hint">
        <kbd>r</kbd> review · <kbd>f</kbd> flag · <kbd>i</kbd> ignore ·{" "}
        <kbd>u</kbd> unmark · <kbd>Space</kbd> palette
      </span>
    </div>
  );
}
