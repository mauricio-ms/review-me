import { useCallback, useEffect, useMemo, useState } from "react";

import { applyComparison } from "../lib/open-repo";
import { listBranches, listCommits, resolveCommit } from "../lib/tauri";
import { timeAgo } from "../lib/time";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import type { DiffSpec } from "../types/diff";
import type { BranchInfo, CommitInfo } from "../types/repo";
import NeoPicker from "./NeoPicker";

/** Which side of the choice the picker is currently collecting. */
type Stage = "branch" | "commit";

/**
 * How much history the second stage offers. Deep enough for any review, shallow
 * enough to stay instant on a large repo; anything older is reachable by typing its
 * sha, which resolves against the whole object database.
 */
const HISTORY_LIMIT = 300;

/** A revision the reviewer typed that no listed commit matches. */
const REV_PATTERN = /^[0-9a-f]{4,40}$/i;

/** Stage-two rows: a listed commit, or the escape hatch for a typed sha. */
type CommitRow =
  | { kind: "commit"; commit: CommitInfo }
  | { kind: "resolve"; rev: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Two-stage commit picker: choose the branch, then the commit on it, and review that
 * commit against its first parent. Nothing is fetched, checked out, or staged.
 *
 * `Esc` in the second stage returns to branch selection; a second `Esc` closes.
 * Errors (an unknown revision, a commit outside this repo) are shown inline without
 * closing, so the reviewer can pick again.
 */
export default function CommitPickHost() {
  const open = useUIStore((s) => s.picker === "commitPick");
  const closePicker = useUIStore((s) => s.closePicker);
  const requestFocus = useUIStore((s) => s.requestFocus);
  const repoPath = useRepoStore((s) => s.repoPath);

  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [stage, setStage] = useState<Stage>("branch");
  const [branch, setBranch] = useState<BranchInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // Fresh ref list on every open — branches move between reviews.
  useEffect(() => {
    if (!open || !repoPath) return;
    let cancelled = false;
    setStage("branch");
    setBranch(null);
    setCommits([]);
    setQuery("");
    setError(null);
    setLoading(true);
    void listBranches(repoPath)
      .then((next) => {
        if (!cancelled) setBranches(next);
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
  }, [open, repoPath]);

  const branchRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return branches;
    return branches.filter((b) => b.display.toLowerCase().includes(needle));
  }, [branches, query]);

  const commitRows = useMemo<CommitRow[]>(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? commits.filter((c) =>
          `${c.shortOid} ${c.summary} ${c.authorName}`
            .toLowerCase()
            .includes(needle),
        )
      : commits;
    if (matches.length === 0 && REV_PATTERN.test(needle)) {
      // Older than the window, or on no branch at all — resolve it directly.
      return [{ kind: "resolve", rev: needle }];
    }
    return matches.map((commit) => ({ kind: "commit", commit }));
  }, [commits, query]);

  // The commit worth reviewing is usually on the branch you're on, so start there
  // and fall back to the repo's default branch.
  const initialBranch = useMemo(() => {
    const preferred = branchRows.findIndex((row) => row.isCurrent);
    if (preferred >= 0) return preferred;
    const fallback = branchRows.findIndex((row) => row.isDefault);
    return fallback >= 0 ? fallback : 0;
  }, [branchRows]);

  const close = useCallback(() => {
    closePicker();
    requestFocus();
  }, [closePicker, requestFocus]);

  // Esc unwinds one stage at a time rather than throwing away the branch choice.
  const onClose = useCallback(() => {
    if (stage === "commit") {
      setStage("branch");
      setCommits([]);
      setQuery("");
      setError(null);
      return;
    }
    close();
  }, [close, stage]);

  const pickBranch = useCallback(
    async (row: BranchInfo) => {
      if (!repoPath) return;
      setBranch(row);
      setStage("commit");
      setQuery("");
      setError(null);
      setLoading(true);
      try {
        setCommits(await listCommits(repoPath, row.name, HISTORY_LIMIT));
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [repoPath],
  );

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

  const pickCommit = useCallback(
    async (row: CommitRow) => {
      if (applying || !repoPath) return;
      if (row.kind === "commit") {
        await review(row.commit.oid, branch?.name ?? null);
        return;
      }
      // A typed revision may not live on the branch that was picked, so it carries no
      // branch context — and the spec needs the full oid, never the abbreviation.
      setApplying(true);
      setError(null);
      try {
        const resolved = await resolveCommit(repoPath, row.rev);
        setApplying(false);
        await review(resolved.oid, null);
      } catch (e) {
        setError(errorMessage(e));
        setApplying(false);
      }
    },
    [applying, branch, repoPath, review],
  );

  if (!open) return null;

  const title = stage === "branch" ? "Review a commit" : "Pick a commit";
  const footer = error ? (
    <span className="branch-error">{error}</span>
  ) : stage === "branch" ? (
    "↑↓ move · ↵ pick branch · Esc cancel"
  ) : (
    <>
      <span className="branch-base">on {branch?.display}</span>
      {" · ↵ review commit · Esc back"}
    </>
  );

  if (stage === "branch") {
    return (
      <NeoPicker<BranchInfo>
        open={open}
        title={title}
        className="commit-pick"
        query={query}
        onQueryChange={setQuery}
        placeholder="branch…"
        rows={branchRows}
        rowKey={(row) => row.name}
        rowClassName={() => "branch-row"}
        initialSelected={initialBranch}
        onActivate={(row) => void pickBranch(row)}
        onClose={onClose}
        renderCount={(_s, total) => `${total} ref${total === 1 ? "" : "s"}`}
        footer={footer}
        emptyText={loading ? "loading branches…" : "no matching branches"}
        renderRow={(row) => (
          <>
            <span className="branch-name">{row.display}</span>
            <span className="branch-badges">
              {row.isDefault && <span className="branch-badge is-default">default</span>}
              {row.isCurrent && <span className="branch-badge is-current">current</span>}
              <span className={`branch-badge is-${row.kind}`}>{row.kind}</span>
              <span className="branch-oid">{row.shortOid}</span>
            </span>
          </>
        )}
      />
    );
  }

  return (
    <NeoPicker<CommitRow>
      open={open}
      title={title}
      className="commit-pick"
      query={query}
      onQueryChange={setQuery}
      placeholder="sha, subject or author…"
      rows={commitRows}
      rowKey={(row) => (row.kind === "commit" ? row.commit.oid : `rev:${row.rev}`)}
      rowClassName={() => "commit-row"}
      onActivate={(row) => void pickCommit(row)}
      onClose={onClose}
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
