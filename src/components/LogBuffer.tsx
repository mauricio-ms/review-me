import { useEffect, useRef, useState } from "react";

import type { ShowOptions } from "../lib/buffers";
import { dispatchKey, type KeyHandler } from "../lib/key-dispatch";
import { KEYMAP, type LogAction } from "../lib/keymap";
import { loadMoreLog } from "../lib/log";
import { enterCommit, enterLogRange } from "../lib/open-repo";
import { timeAgo } from "../lib/time";
import { useLogStore } from "../state/log";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import { hasKeyboard, isShown, useWindowStore } from "../state/windows";
import type { CommitInfo, CommitReview, Decoration, LogRange } from "../types/repo";

/** Start paging in more history once the cursor is this many rows from the end. */
const PREFETCH_ROWS = 30;
/** The same for mouse scrolling: this many pixels from the bottom. */
const PREFETCH_PX = 600;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A commit's review at a glance: `✓` when every change is reviewed or ignored,
 * otherwise `done/total`, plus its flags and notes. Untouched commits show nothing.
 */
function ReviewBadges({ review }: { review: CommitReview | undefined }) {
  if (!review) return null;
  const { total, reviewed, ignored, flagged } = review.coverage;
  const done = reviewed + ignored;
  return (
    <span className="log-review">
      {total > 0 && flagged === 0 && done === total ? (
        <span className="mark-reviewed" title="every change reviewed">
          ✓
        </span>
      ) : (
        total > 0 && (
          <span
            className="log-progress"
            title={`${done} of ${total} changes reviewed or ignored`}
          >
            {done}/{total}
          </span>
        )
      )}
      {review.flags > 0 && (
        <span className="mark-flagged" title={`${review.flags} flagged`}>
          ⚑ {review.flags}
        </span>
      )}
      {review.notes > 0 && (
        <span className="log-notes" title={`${review.notes} with a note`}>
          ✎ {review.notes}
        </span>
      )}
    </span>
  );
}

/** A ref decoration; the branch under review is boxed, as magit boxes the current one. */
function RefLabel({ decoration, current }: { decoration: Decoration; current: boolean }) {
  return (
    <span
      className={`log-ref is-${decoration.kind}${current ? " is-current" : ""}`}
      title={decoration.name}
    >
      {decoration.name}
    </span>
  );
}

/** The commits section's title, magit-style, for the range the log lists. */
function rangeTitle(range: LogRange | null): string {
  switch (range?.kind) {
    case "unmerged":
      return `Unmerged into ${range.baseName}`;
    case "unpushed":
      return `Unpushed to ${range.upstreamName}`;
    default:
      return "Recent commits";
  }
}

/** Style a status-line ref by where it lives: a local branch or a remote-tracking one. */
function refKind(ref: string): "local" | "remote" {
  return ref.startsWith("refs/remotes/") ? "remote" : "local";
}

/**
 * The commits buffer: the commits the review branch introduced over its base — its
 * unpushed ones when it is its own base, else its whole history — as a magit-style
 * list. `Enter` opens the commit under the cursor in the diff buffer (against its first
 * parent), `b` the whole listed range as one `base...branch` diff, and `q` there comes
 * back here. Stays mounted while no window shows it, so the cursor is still on the
 * commit you left.
 * It is also where a clean checkout opens, having no changes to show.
 */
export default function LogBuffer() {
  const repo = useRepoStore((s) => s.repo);
  const reviewBranch = useRepoStore((s) => s.reviewBranch);
  const uncommitted = useRepoStore((s) =>
    s.comparison.kind === "worktree" ? (s.diff?.files.length ?? 0) : 0,
  );
  const range = useLogStore((s) => s.range);
  const commits = useLogStore((s) => s.commits);
  const reviews = useLogStore((s) => s.reviews);
  const loading = useLogStore((s) => s.loading);
  const error = useLogStore((s) => s.error);
  const complete = useLogStore((s) => s.complete);
  const visible = useWindowStore((s) => isShown(s, "log"));
  const focused = useWindowStore((s) => hasKeyboard(s, "log"));
  const focusRequest = useUIStore((s) => s.focusRequest);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  // Tracked by oid, not index, so a reload (the branch moved, a page arrived) keeps
  // the cursor on the same commit.
  const [cursorOid, setCursorOid] = useState<string | null>(null);
  // What is being opened, for the header: a short oid or `base...branch`.
  const [entering, setEntering] = useState<string | null>(null);
  const [enterError, setEnterError] = useState<string | null>(null);

  const found = cursorOid ? commits.findIndex((c) => c.oid === cursorOid) : -1;
  const cursor = found >= 0 ? found : 0;

  useEffect(() => {
    if (focused) rootRef.current?.focus({ preventScroll: true });
  }, [focused, focusRequest]);

  useEffect(() => {
    if (!visible) return;
    const oid = commits[cursor]?.oid;
    if (oid) rowRefs.current.get(oid)?.scrollIntoView({ block: "nearest" });
  }, [commits, cursor, visible]);

  useEffect(() => {
    if (!complete && commits.length > 0 && cursor >= commits.length - PREFETCH_ROWS) {
      void loadMoreLog();
    }
  }, [commits.length, complete, cursor]);

  const moveTo = (index: number) => {
    const commit = commits[Math.min(Math.max(0, index), commits.length - 1)];
    if (commit) setCursorOid(commit.oid);
  };

  const opening = async (label: string, open: () => Promise<void>) => {
    if (entering) return;
    setEntering(label);
    setEnterError(null);
    try {
      await open();
    } catch (e) {
      setEnterError(errorMessage(e));
    } finally {
      setEntering(null);
    }
  };

  const enter = (commit: CommitInfo | undefined, options: ShowOptions = {}) => {
    if (!commit || entering) return;
    setCursorOid(commit.oid);
    void opening(commit.shortOid, () => enterCommit(commit.oid, options));
  };

  const rangeBase =
    range?.kind === "unmerged"
      ? { ref: range.baseRef, name: range.baseName }
      : range?.kind === "unpushed"
        ? { ref: range.upstreamRef, name: range.upstreamName }
        : null;
  const branchName = reviewBranch?.display ?? repo?.branch ?? "HEAD";
  const listed = `${commits.length}${complete ? "" : "+"}`;
  const plural = commits.length === 1 ? "" : "s";

  // The whole listed range as one diff — only when there is a base to diff against.
  const enterRange = () => {
    if (!rangeBase) return;
    void opening(`${rangeBase.name}...${branchName}`, enterLogRange);
  };

  const handlers: Record<LogAction, KeyHandler> = {
    down: () => moveTo(cursor + 1),
    up: () => moveTo(cursor - 1),
    first: () => moveTo(0),
    last: () => moveTo(commits.length - 1),
    open: () => enter(commits[cursor]),
    // magit's way: the log stays, the commit opens beside it.
    "open-other": () => enter(commits[cursor], { other: true }),
    range: enterRange,
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    dispatchKey("log", e, KEYMAP.log, handlers);
  };

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < PREFETCH_PX) {
      void loadMoreLog();
    }
  };

  if (!repo) return null;

  const isCurrent = (d: Decoration) =>
    d.kind !== "tag" && reviewBranch != null && d.name === reviewBranch.display;
  const headCommit = commits.find((c) => c.isHead);
  // The log lists the review branch, so its first row is that branch's tip.
  const reviewingElsewhere = reviewBranch != null && reviewBranch.display !== repo.branch;
  const shownError = enterError ?? error;

  return (
    <div
      ref={rootRef}
      className="buffer log-buffer"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="diff-header">
        <span className="diff-header-branch">
          {reviewBranch?.display ?? repo.branch}
        </span>
        <span className="diff-header-count">
          {listed} commit{plural}
        </span>
        {entering && <span className="diff-header-status">opening {entering}…</span>}
        {loading && !entering && <span className="diff-header-status">loading…</span>}
        {shownError && <span className="diff-header-error">{shownError}</span>}
      </div>

      <div className="log-list" onScroll={onScroll}>
        <div className="log-status">
          <div className="log-status-line">
            <span className="log-status-label">Head:</span>
            <span className="log-ref is-local">{repo.branch}</span>
            <span className="log-status-text">{headCommit?.summary ?? repo.head}</span>
          </div>
          {reviewingElsewhere && (
            <div className="log-status-line">
              <span className="log-status-label">Review:</span>
              <span className="log-ref is-local is-current">{reviewBranch.display}</span>
              <span className="log-status-text">{commits[0]?.summary ?? ""}</span>
            </div>
          )}
          {rangeBase && (
            <div className="log-status-line">
              <span className="log-status-label">
                {range?.kind === "unpushed" ? "Upstream:" : "Base:"}
              </span>
              <span className={`log-ref is-${refKind(rangeBase.ref)}`}>{rangeBase.name}</span>
              <span className="log-status-text">
                {range?.kind === "unpushed"
                  ? `${listed} unpushed commit${plural}`
                  : `${listed} commit${plural} introduced by ${branchName}`}
              </span>
              <span className="log-status-hint">
                b {range?.kind === "unpushed" ? "all unpushed" : "whole branch"}
              </span>
            </div>
          )}
          {uncommitted > 0 && (
            <div className="log-status-line">
              <span className="log-status-label">Changes:</span>
              <span className="log-status-text">
                {uncommitted} uncommitted file{uncommitted === 1 ? "" : "s"}
              </span>
              <span className="log-status-hint">C-x b diff</span>
            </div>
          )}
        </div>

        <div className="diff-row diff-section-header log-section-header">
          <span className="diff-section-label">{rangeTitle(range)}</span>
          <span className="diff-section-count">{listed}</span>
        </div>

        {commits.map((commit, index) => (
          <div
            key={commit.oid}
            ref={(el) => {
              if (el) rowRefs.current.set(commit.oid, el);
              else rowRefs.current.delete(commit.oid);
            }}
            className={`diff-row log-row${index === cursor ? " is-selected" : ""}`}
            onClick={() => setCursorOid(commit.oid)}
            onDoubleClick={() => enter(commit)}
          >
            <span className="log-oid">{commit.shortOid}</span>
            {commit.refs.map((d) => (
              <RefLabel key={`${d.kind}:${d.name}`} decoration={d} current={isCurrent(d)} />
            ))}
            <span className="log-summary">{commit.summary}</span>
            <ReviewBadges review={reviews[commit.oid]} />
            <span className="log-meta">
              {commit.isMerge && <span className="commit-badge is-merge">merge</span>}
              <span className="log-author">{commit.authorName}</span>
              <span className="log-when">{timeAgo(commit.timestamp)}</span>
            </span>
          </div>
        ))}

        {commits.length === 0 && !loading && (
          <div className="log-empty">
            {error
              ? "no history to show"
              : range?.kind === "unmerged"
                ? `${branchName} has no commits beyond ${range.baseName}`
                : "no commits yet"}
          </div>
        )}
        {!complete && commits.length > 0 && (
          <div className="log-empty">{loading ? "loading more…" : "…"}</div>
        )}
      </div>
    </div>
  );
}
