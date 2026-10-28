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
  /** Choosing one opens it in the other window (`C-x 4 .`). */
  other: boolean;
  show: (title: string, results: XrefResult[], choice: SourceChoice, other?: boolean) => void;
  close: () => void;
};

export const useXrefStore = create<XrefState>((set) => ({
  open: false,
  title: "",
  results: EMPTY_RESULTS,
  choice: null,
  other: false,
  show: (title, results, choice, other = false) =>
    set({ open: true, title, results, choice, other }),
  close: () => set({ open: false, results: EMPTY_RESULTS }),
}));
