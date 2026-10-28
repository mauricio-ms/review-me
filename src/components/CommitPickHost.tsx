import { useCallback, useEffect, useMemo, useState } from "react";

import { applyComparison } from "../lib/open-repo";
import { listCommits, resolveCommit } from "../lib/tauri";
import { timeAgo } from "../lib/time";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import type { DiffSpec } from "../types/diff";
import type { CommitInfo } from "../types/repo";
import NeoPicker from "./NeoPicker";

/**
 * How much history the picker offers. Deep enough for any review, shallow enough to
 * stay instant on a large repo; anything older is reachable by typing its sha, which
 * resolves against the whole object database.
 */
const HISTORY_LIMIT = 300;

/** A revision the reviewer typed that no listed commit matches. */
const REV_PATTERN = /^[0-9a-f]{4,40}$/i;

/** Rows: a commit from the review branch's history, or a typed sha to resolve. */
type CommitRow =
  | { kind: "commit"; commit: CommitInfo }
  | { kind: "resolve"; rev: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Picks one commit off the branch under review and diffs it against its first parent.
 * The branch comes from the app's review branch (`M-x checkout`), so this is a single
 * choice; nothing is fetched, checked out, or staged.
 *
 * Errors (an unknown revision, a commit outside this repo) are shown inline without
 * closing, so the reviewer can pick again.
 */
export default function CommitPickHost() {
  const open = useUIStore((s) => s.picker === "commitPick");
  const closePicker = useUIStore((s) => s.closePicker);
  const requestFocus = useUIStore((s) => s.requestFocus);
  const repoPath = useRepoStore((s) => s.repoPath);
  const reviewBranch = useRepoStore((s) => s.reviewBranch);

  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // Fresh history on every open — the branch moves between reviews.
  useEffect(() => {
    if (!open || !repoPath || !reviewBranch) return;
    let cancelled = false;
    setQuery("");
    setError(null);
    setCommits([]);
    setLoading(true);
    // The whole history, not the log's range: this picker is for what the log
    // doesn't list.
    void listCommits(repoPath, reviewBranch.ref, null, 0, HISTORY_LIMIT)
      .then((next) => {
        if (!cancelled) setCommits(next.commits);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, repoPath, reviewBranch]);

  const rows = useMemo<CommitRow[]>(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? commits.filter((c) =>
          `${c.shortOid} ${c.summary} ${c.authorName}`
            .toLowerCase()
            .includes(needle),
        )
      : commits;
    if (matches.length === 0 && REV_PATTERN.test(needle)) {
      // Older than the window, or on another branch entirely — resolve it directly.
      return [{ kind: "resolve", rev: needle }];
    }
    return matches.map((commit) => ({ kind: "commit", commit }));
  }, [commits, query]);

  const close = useCallback(() => {
    closePicker();
    requestFocus();
  }, [closePicker, requestFocus]);

  const review = useCallback(
    async (oid: string, branchRef: string | null) => {
      const spec: DiffSpec = { kind: "commit", oid, branchRef };
      setApplying(true);
      setError(null);
      try {
        await applyComparison(spec);
        close();
      } catch (e) {
        // Stay open so the reviewer can pick a different commit.
        setError(errorMessage(e));
      } finally {
        setApplying(false);
      }
    },
    [close],
  );

  const activate = useCallback(
    async (row: CommitRow) => {
      if (applying || !repoPath) return;
      if (row.kind === "commit") {
        await review(row.commit.oid, reviewBranch?.ref ?? null);
        return;
      }
      // A typed revision needn't live on the branch under review, so it carries no
      // branch context — and the spec needs the full oid, never the abbreviation.
      setApplying(true);
      setError(null);
      try {
        const resolved = await resolveCommit(repoPath, row.rev);
        // `review` owns `applying` from here; leaving it set keeps the guard unbroken.
        await review(resolved.oid, null);
      } catch (e) {
        setError(errorMessage(e));
        setApplying(false);
      }
    },
    [applying, repoPath, review, reviewBranch],
  );

  if (!open) return null;

  const footer = error ? (
    <span className="branch-error">{error}</span>
  ) : (
    <>
      <span className="branch-base">on {reviewBranch?.display ?? "no branch"}</span>
      {" · ↵ review commit · Esc cancel"}
    </>
  );

  return (
    <NeoPicker<CommitRow>
      open={open}
      title="Review a commit"
      className="commit-pick"
      query={query}
      onQueryChange={setQuery}
      placeholder="sha, subject or author…"
      rows={rows}
      rowKey={(row) => (row.kind === "commit" ? row.commit.oid : `rev:${row.rev}`)}
      rowClassName={() => "commit-row"}
      onActivate={(row) => void activate(row)}
      onClose={close}
      renderCount={(_s, total) =>
        commits.length >= HISTORY_LIMIT
          ? `${total} of newest ${HISTORY_LIMIT}`
          : `${total} commit${total === 1 ? "" : "s"}`
      }
      footer={applying ? "loading diff…" : footer}
      emptyText={loading ? "loading commits…" : "no matching commits"}
      renderRow={(row) =>
        row.kind === "resolve" ? (
          <>
            <span className="commit-oid">{row.rev}</span>
            <span className="commit-summary is-resolve">
              resolve this revision…
            </span>
            <span className="commit-meta" />
          </>
        ) : (
          <>
            <span className="commit-oid">{row.commit.shortOid}</span>
            <span className="commit-summary">{row.commit.summary}</span>
            <span className="commit-meta">
              {row.commit.isMerge && (
                <span className="commit-badge is-merge">merge</span>
              )}
              {row.commit.isHead && (
                <span className="commit-badge is-head">HEAD</span>
              )}
              <span className="commit-author">{row.commit.authorName}</span>
              <span className="commit-when">{timeAgo(row.commit.timestamp)}</span>
            </span>
          </>
        )
      }
    />
  );
}
