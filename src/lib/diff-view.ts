import type { AnchorKind, AnchorSide } from "../types/tags";

/** The lines the diff buffer's cursor (or visual selection) would mark right now. */
export type DiffTarget = {
  file: string;
  lo: number;
  hi: number;
  kind: AnchorKind;
  side: AnchorSide;
};

// Module-level handle on the diff buffer's current target, so commands (`M-x note`) can
// act on the cursor without prop-drilling — the diff-buffer twin of `project-view.ts`.
let source: (() => DiffTarget | null) | null = null;

export function setDiffTargetSource(next: (() => DiffTarget | null) | null): void {
  source = next;
}

/** What `r`/`f`/`i` would mark at the cursor, or null on a section header. */
export function diffTarget(): DiffTarget | null {
  return source?.() ?? null;
}
