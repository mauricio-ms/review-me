import { useCallback, useEffect, useMemo, useState } from "react";

import { applyComparison } from "../lib/open-repo";
import { listBranches } from "../lib/tauri";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import type { DiffSpec } from "../types/diff";
import type { BranchInfo } from "../types/repo";
import NeoPicker from "./NeoPicker";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Base picker for a branch comparison. The branch under review is always the target —
 * choosing it is `:checkout`'s job — so all this collects is what to compare it
 * against, and applies `base...reviewBranch`. Nothing is fetched, checked out, or
 * staged; only refs git already knows about are offered.
 *
 * Errors (an unresolvable ref, no common ancestor) are shown inline without closing,
 * so the reviewer can pick again.
 */
export default function BranchCompareHost() {
  const open = useUIStore((s) => s.picker === "branchCompare");
  const closePicker = useUIStore((s) => s.closePicker);
  const requestFocus = useUIStore((s) => s.requestFocus);
  const repoPath = useRepoStore((s) => s.repoPath);
  const reviewBranch = useRepoStore((s) => s.reviewBranch);

  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // Fresh ref list on every open — branches move between reviews.
  useEffect(() => {
    if (!open || !repoPath) return;
    let cancelled = false;
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

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return branches;
    return branches.filter((b) => b.display.toLowerCase().includes(needle));
  }, [branches, query]);

  // The branch under review can't also be the base.
  const isDisabled = useCallback(
    (row: BranchInfo) => row.name === reviewBranch?.ref,
    [reviewBranch],
  );

  // Default to the repo's default branch — then to the first row that isn't the
  // branch being reviewed.
  const initialSelected = useMemo(() => {
    const preferred = rows.findIndex((row) => row.isDefault);
    if (preferred >= 0 && !isDisabled(rows[preferred])) return preferred;
    const first = rows.findIndex((row) => !isDisabled(row));
    return first >= 0 ? first : 0;
  }, [isDisabled, rows]);

  const close = useCallback(() => {
    closePicker();
    requestFocus();
  }, [closePicker, requestFocus]);

  const activate = useCallback(
    async (row: BranchInfo) => {
      if (!reviewBranch || applying) return;
      const spec: DiffSpec = {
        kind: "branches",
        baseRef: row.name,
        targetRef: reviewBranch.ref,
        strategy: "mergeBase",
      };
      setApplying(true);
      setError(null);
      try {
        await applyComparison(spec);
        close();
      } catch (e) {
        // Stay open so the reviewer can pick a different base.
        setError(errorMessage(e));
      } finally {
        setApplying(false);
      }
    },
    [applying, close, reviewBranch],
  );

  if (!open) return null;

  const footer = error ? (
    <span className="branch-error">{error}</span>
  ) : (
    <>
      <span className="branch-base">reviewing: {reviewBranch?.display}</span>
      {" · ↵ compare · Esc cancel"}
    </>
  );

  return (
    <NeoPicker<BranchInfo>
      open={open}
      title="Compare against"
      className="branch-compare"
      query={query}
      onQueryChange={setQuery}
      placeholder="base branch…"
      rows={rows}
      rowKey={(row) => row.name}
      rowClassName={() => "branch-row"}
      initialSelected={initialSelected}
      isRowDisabled={isDisabled}
      onActivate={(row) => void activate(row)}
      onClose={close}
      renderCount={(_s, total) => `${total} ref${total === 1 ? "" : "s"}`}
      footer={applying ? "comparing…" : footer}
      emptyText={loading ? "loading branches…" : "no matching branches"}
      renderRow={(row) => (
        <>
          <span className="branch-name">{row.display}</span>
          <span className="branch-badges">
            {row.isDefault && <span className="branch-badge is-default">default</span>}
            {row.isCurrent && <span className="branch-badge is-current">checkout</span>}
            <span className={`branch-badge is-${row.kind}`}>{row.kind}</span>
            <span className="branch-oid">{row.shortOid}</span>
          </span>
        </>
      )}
    />
  );
}
