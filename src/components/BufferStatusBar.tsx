import { reviewProgress } from "../lib/coverage";
import { timeAgo } from "../lib/time";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore } from "../state/ui";
import { comparisonLabel, shortOid, type Comparison } from "../types/diff";

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
          {activeBuffer === "diff" && total > 0 && (
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
    </div>
  );
}
