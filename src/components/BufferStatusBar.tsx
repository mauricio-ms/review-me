import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";

export default function BufferStatusBar() {
  const repo = useRepoStore((s) => s.repo);
  const diff = useRepoStore((s) => s.diff);
  const activeBuffer = useUIStore((s) => s.activeBuffer);
  const vimMode = useUIStore((s) => s.vimMode);

  const fileCount = diff?.files.length ?? 0;

  return (
    <div className="status-bar">
      <span className="status-segment status-mode">{vimMode}</span>
      <span className="status-segment status-buffer">{activeBuffer}</span>
      {repo && (
        <>
          <span className="status-segment status-branch">
            ⎇ {repo.branch}
          </span>
          <span className="status-segment status-changes">
            {fileCount} changed
          </span>
        </>
      )}
      <span className="status-spacer" />
      <span className="status-segment status-hint">
        <kbd>Space</kbd> palette · <kbd>:</kbd> command
      </span>
    </div>
  );
}
