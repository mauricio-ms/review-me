import { create } from "zustand";

import type { SourceChoice } from "../lib/project";
import type { Place } from "./history";
import type { WindowId } from "./windows";
import type { GrepScope, SearchResults } from "../types/grep";

export type GrepContext = {
  repo: string;
  epoch: number;
  choice: SourceChoice;
  /** Reuse the selected project window; null means enter project mode on accept. */
  window: WindowId | null;
  origin: Place | null;
};

const initial = () => ({
  context: null as GrepContext | null,
  query: "",
  scope: "repository" as GrepScope,
  results: null as SearchResults | null,
  selected: 0,
  status: "idle" as "idle" | "loading" | "ready" | "error" | "cancelled",
  error: null as string | null,
});

export const useGrepStore = create<ReturnType<typeof initial> & {
  reset: () => void;
  select: (index: number) => void;
}>((set) => ({
  ...initial(),
  reset: () => set(initial()),
  select: (index) => set((s) => ({
    selected: Math.max(0, Math.min(index, (s.results?.hits.length ?? 1) - 1)),
  })),
}));
