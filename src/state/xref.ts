import { create } from "zustand";

import type { XrefResult } from "../types/xref";

const EMPTY_RESULTS: XrefResult[] = [];

type XrefState = {
  open: boolean;
  title: string;
  results: XrefResult[];
  show: (title: string, results: XrefResult[]) => void;
  close: () => void;
};

export const useXrefStore = create<XrefState>((set) => ({
  open: false,
  title: "",
  results: EMPTY_RESULTS,
  show: (title, results) => set({ open: true, title, results }),
  close: () => set({ open: false, results: EMPTY_RESULTS }),
}));
