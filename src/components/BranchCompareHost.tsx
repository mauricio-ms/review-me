import { useCallback, useEffect, useMemo, useState } from "react";

import { applyComparison } from "../lib/open-repo";
import { listBranches } from "../lib/tauri";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import type { DiffSpec } from "../types/diff";
import type { BranchInfo } from "../types/repo";
import NeoPicker from "./NeoPicker";

/** Which side of the comparison the picker is currently collecting. */
type Stage = "base" | "target";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Two-stage branch comparison picker: choose the base, then the branch being
 * reviewed, and apply `base...target`. Nothing is fetched, checked out, or staged —
 * only refs git already knows about are offered.
 *
 * `Esc` in the second stage returns to base selection; a second `Esc` closes. Errors
 * (an unresolvable ref, no common ancestor) are shown inline without closing, so the
 * reviewer can pick again.
 */
export default function BranchCompareHost() {
  const open = useUIStore((s) => s.picker === "branchCompare");
  const closePicker = useUIStore((s) => s.closePicker);
  const requestFocus = useUIStore((s) => s.requestFocus);
  const repoPath = useRepoStore((s) => s.repoPath);

  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<Stage>("base");
  const [base, setBase] = useState<BranchInfo | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // Fresh ref list on every open — branches move between reviews.
  useEffect(() => {
    if (!open || !repoPath) return;
    let cancelled = false;
    setStage("base");
    setBase(null);
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

  // The same ref on both sides is not a comparison.
  const isDisabled = useCallback(
    (row: BranchInfo) => stage === "target" && row.name === base?.name,
    [base, stage],
  );

  // Base defaults to the repo's default branch, target to the checkout — then to
  // the first row that isn't already taken by the other side.
  const initialSelected = useMemo(() => {
    const preferred = rows.findIndex((row) =>
      stage === "base" ? row.isDefault : row.isCurrent,
    );
    if (preferred >= 0 && !isDisabled(rows[preferred])) return preferred;
    const first = rows.findIndex((row) => !isDisabled(row));
    return first >= 0 ? first : 0;
  }, [isDisabled, rows, stage]);

  const close = useCallback(() => {
    closePicker();
    requestFocus();
  }, [closePicker, requestFocus]);

  // Esc unwinds one stage at a time rather than throwing away the base choice.
  const onClose = useCallback(() => {
    if (stage === "target") {
      setStage("base");
      setQuery("");
      setError(null);
      return;
    }
    close();
  }, [close, stage]);

  const activate = useCallback(
    async (row: BranchInfo) => {
      if (stage === "base") {
        setBase(row);
        setStage("target");
        setQuery("");
        setError(null);
        return;
      }
      if (!base || applying) return;
      const spec: DiffSpec = {
        kind: "branches",
        baseRef: base.name,
        targetRef: row.name,
        strategy: "mergeBase",
      };
      setApplying(true);
      setError(null);
      try {
        await applyComparison(spec);
        close();
      } catch (e) {
        // Stay open so the reviewer can pick a different pair.
        setError(errorMessage(e));
      } finally {
        setApplying(false);
      }
    },
    [applying, base, close, stage],
  );

  if (!open) return null;

  const title = stage === "base" ? "Compare branches" : "Review branch";
  const footer = error ? (
    <span className="branch-error">{error}</span>
  ) : stage === "base" ? (
    "↑↓ move · ↵ pick base · Esc cancel"
  ) : (
    <>
      <span className="branch-base">base: {base?.display}</span>
      {" · ↵ compare · Esc back"}
    </>
  );

  return (
    <NeoPicker<BranchInfo>
      open={open}
      title={title}
      className="branch-compare"
      query={query}
      onQueryChange={setQuery}
      placeholder={stage === "base" ? "base branch…" : "branch to review…"}
      rows={rows}
      rowKey={(row) => row.name}
      rowClassName={() => "branch-row"}
      initialSelected={initialSelected}
      isRowDisabled={isDisabled}
      onActivate={(row) => void activate(row)}
      onClose={onClose}
      renderCount={(_s, total) => `${total} ref${total === 1 ? "" : "s"}`}
      footer={applying ? "comparing…" : footer}
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
