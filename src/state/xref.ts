import { create } from "zustand";

import type { SourceChoice } from "../lib/project";
import type { XrefResult } from "../types/xref";

const EMPTY_RESULTS: XrefResult[] = [];

type XrefState = {
  open: boolean;
  title: string;
  results: XrefResult[];
  /** The revision the results were resolved in — where choosing one opens it. */
  choice: SourceChoice | null;
  show: (title: string, results: XrefResult[], choice: SourceChoice) => void;
  close: () => void;
};

export const useXrefStore = create<XrefState>((set) => ({
  open: false,
  title: "",
  results: EMPTY_RESULTS,
  choice: null,
  show: (title, results, choice) => set({ open: true, title, results, choice }),
  close: () => set({ open: false, results: EMPTY_RESULTS }),
}));
