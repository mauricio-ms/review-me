import { useCallback, useEffect, useMemo, useState } from "react";

import { switchReviewBranch } from "../lib/open-repo";
import { listBranches } from "../lib/tauri";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import type { BranchInfo } from "../types/repo";
import NeoPicker from "./NeoPicker";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Picks the branch under review — the app's own "checkout". It targets branch
 * comparisons and supplies the commit picker's history, but nothing is fetched,
 * checked out, or staged: the real working tree stays exactly where it was, so a
 * branch nobody has checked out reviews like any other.
 *
 * Switching while comparing branches re-targets the comparison, which is what makes
 * the concept live rather than a label.
 */
export default function CheckoutBranchHost() {
  const open = useUIStore((s) => s.picker === "checkoutBranch");
  const closePicker = useUIStore((s) => s.closePicker);
  const requestFocus = useUIStore((s) => s.requestFocus);
  const repoPath = useRepoStore((s) => s.repoPath);
  const reviewBranch = useRepoStore((s) => s.reviewBranch);

  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

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

  // Start on the branch already under review, else the checkout, else the default.
  const initialSelected = useMemo(() => {
    const order = [
      (row: BranchInfo) => row.name === reviewBranch?.ref,
      (row: BranchInfo) => row.isCurrent,
      (row: BranchInfo) => row.isDefault,
    ];
    for (const match of order) {
      const idx = rows.findIndex(match);
      if (idx >= 0) return idx;
    }
    return 0;
  }, [reviewBranch, rows]);

  const close = useCallback(() => {
    closePicker();
    requestFocus();
  }, [closePicker, requestFocus]);

  const activate = useCallback(
    async (row: BranchInfo) => {
      if (switching) return;
      setSwitching(true);
      setError(null);
      try {
        await switchReviewBranch({ ref: row.name, display: row.display });
        close();
      } catch (e) {
        // Re-targeting the comparison failed; stay open with the reason.
        setError(errorMessage(e));
      } finally {
        setSwitching(false);
      }
    },
    [close, switching],
  );

  if (!open) return null;

  const footer = error ? (
    <span className="branch-error">{error}</span>
  ) : (
    <>
      <span className="branch-base">reviewing: {reviewBranch?.display ?? "none"}</span>
      {" · ↵ switch · Esc cancel"}
    </>
  );

  return (
    <NeoPicker<BranchInfo>
      open={open}
      title="Branch to review"
      className="branch-compare"
      query={query}
      onQueryChange={setQuery}
      placeholder="branch…"
      rows={rows}
      rowKey={(row) => row.name}
      rowClassName={(row) =>
        row.name === reviewBranch?.ref ? "branch-row is-reviewing" : "branch-row"
      }
      initialSelected={initialSelected}
      onActivate={(row) => void activate(row)}
      onClose={close}
      renderCount={(_s, total) => `${total} ref${total === 1 ? "" : "s"}`}
      footer={switching ? "switching…" : footer}
      emptyText={loading ? "loading branches…" : "no matching branches"}
      renderRow={(row) => (
        <>
          <span className="branch-name">{row.display}</span>
          <span className="branch-badges">
            {row.name === reviewBranch?.ref && (
              <span className="branch-badge is-reviewing">reviewing</span>
            )}
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
