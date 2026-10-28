import { useMemo } from "react";

import { useCurrentFile } from "../lib/buffers";
import { reviewProgress } from "../lib/coverage";
import { changeAtLine, changeBlocks, changeForFile } from "../lib/project-diff";
import { timeAgo } from "../lib/time";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore } from "../state/ui";
import { isFileKey, selectedBuffer, useWindowStore } from "../state/windows";
import { comparisonLabel, shortOid, type Comparison } from "../types/diff";
import PathLabel from "./PathLabel";

/** Worktree, branch pair, single commit — each comparison mode gets its own mark. */
function comparisonGlyph(comparison: Comparison | undefined): string {
  switch (comparison?.kind) {
    case "branches":
      return "⇄";
    case "commit":
      return "⊙";
    default:
      return "⎇";
  }
}

/** The exact revisions behind the label, on hover. */
function comparisonTitle(comparison: Comparison | undefined): string | undefined {
  switch (comparison?.kind) {
    case "branches":
      return `merge-base ${shortOid(comparison.mergeBase)} → ${shortOid(
        comparison.targetOid,
      )}`;
    case "commit": {
      const range = comparison.parentOid
        ? `${shortOid(comparison.parentOid)} → ${comparison.shortOid}`
        : `root commit ${comparison.shortOid}`;
      const where = comparison.branchName ? ` on ${comparison.branchName}` : "";
      return `${range}${where} · ${comparison.summary} (${
        comparison.authorName
      }, ${timeAgo(comparison.timestamp)})`;
    }
    default:
      return undefined;
  }
}

export default function BufferStatusBar() {
  const repo = useRepoStore((s) => s.repo);
  const reviewBranch = useRepoStore((s) => s.reviewBranch);
  const diff = useRepoStore((s) => s.diff);
  const comparison = diff?.comparison;
  const reviewed = useTagsStore((s) => s.reviewed);
  const flags = useTagsStore((s) => s.flags);
  const ignored = useTagsStore((s) => s.ignored);
  // The mode line describes the selected window (the tree being only a way into it).
  const shown = useWindowStore(selectedBuffer);
  const treeFocused = useWindowStore((s) => s.treeFocused);
  const vimMode = useUIStore((s) => s.vimMode);
  const diffCursor = useUIStore((s) => s.diffCursor);
  const file = useCurrentFile();
  const selected = useWindowStore((s) => s.selected);
  const line = useUIStore((s) => s.fileLines[selected] ?? null);
  // Where the cursor is among the file's changes: `change 2/5`, or how many there are.
  const blocks = useMemo(() => {
    const change = file ? changeForFile(diff, file.source, file.path) : null;
    return change ? changeBlocks(change) : null;
  }, [diff, file]);
  const onChange = blocks && line != null ? changeAtLine(blocks, line) : -1;

  const files = diff?.files ?? [];
  // The file you're on, named in full at the right edge, as Emacs's mode line names the
  // buffer: the diff's cursor row, or the window's file.
  const here =
    shown === "diff" && diffCursor
      ? diffCursor
      : file
        ? { path: file.path, line }
        : null;
  const bufferLabel = treeFocused ? "tree" : isFileKey(shown) ? "file" : shown;
  const { done, total } = reviewProgress(files, reviewed);

  return (
    <div className="status-bar">
      <span className="status-segment status-mode">{vimMode}</span>
      <span className="status-segment status-buffer">{bufferLabel}</span>
      {repo && (
        <>
          <span className="status-segment status-repo" title={repo.root}>
            {repo.root.split("/").filter(Boolean).pop() ?? repo.root}
          </span>
          {reviewBranch && (
            <span
              className={`status-segment status-review-branch${
                reviewBranch.display === repo.branch ? "" : " is-elsewhere"
              }`}
              title={
                reviewBranch.display === repo.branch
                  ? `reviewing ${reviewBranch.ref} (also the checkout)`
                  : `reviewing ${reviewBranch.ref} — the working tree is on ${repo.branch}`
              }
            >
              review: {reviewBranch.display}
            </span>
          )}
          <span
            className={`status-segment status-branch${
              comparison && comparison.kind !== "worktree" ? " is-comparing" : ""
            }`}
            title={comparisonTitle(comparison)}
          >
            {comparisonGlyph(comparison)}{" "}
            {comparison ? comparisonLabel(comparison) : repo.branch}
          </span>
          <span className="status-segment status-changes">
            {files.length} changed
          </span>
          {shown === "diff" && total > 0 && (
            <span className="status-segment status-reviewed">
              ✓ {done}/{total} units
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
      {file && !treeFocused && blocks && blocks.length > 0 && (
        <span className="status-segment status-change" title="] c / [ c move between them">
          {onChange >= 0
            ? `change ${onChange + 1}/${blocks.length}`
            : `${blocks.length} change${blocks.length === 1 ? "" : "s"}`}
        </span>
      )}
      {here && (
        <span className="status-segment status-here">
          <PathLabel path={here.path} mode="elide" />
          {here.line != null && <span className="status-line">:{here.line}</span>}
        </span>
      )}
    </div>
  );
}
