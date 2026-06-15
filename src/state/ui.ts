import { create } from "zustand";

export type BufferName = "diff" | "project";
export type VimMode = "normal" | "insert" | "visual" | "replace";
/** How the diff view highlights changes: per-word (intra-line) or whole-line. */
export type DiffHighlightMode = "word" | "line";

/** Which full-screen modal picker (if any) is open. */
export type PickerKind =
  | null
  | "openRepo"
  | "recentRepos"
  | "fuzzyFiles"
  | "clearTags"
  | "commitReviewed";

type UIState = {
  activeBuffer: BufferName;
  transientOpen: boolean;
  commandLineOpen: boolean;
  vimMode: VimMode;
  picker: PickerKind;
  focusRequest: number;
  modalDepth: number;
  diffHighlight: DiffHighlightMode;

  switchBuffer: (dir: "next" | "prev") => void;
  setActiveBuffer: (b: BufferName) => void;
  openTransient: () => void;
  closeTransient: () => void;
  toggleTransient: () => void;
  openCommandLine: () => void;
  closeCommandLine: () => void;
  setVimMode: (m: VimMode) => void;
  openPicker: (p: Exclude<PickerKind, null>) => void;
  closePicker: () => void;
  requestFocus: () => void;
  beginModal: () => void;
  endModal: () => void;
  setDiffHighlight: (m: DiffHighlightMode) => void;
  toggleDiffHighlight: () => void;
};

const BUFFERS: BufferName[] = ["diff", "project"];

export const useUIStore = create<UIState>((set) => ({
  activeBuffer: "diff",
  transientOpen: false,
  commandLineOpen: false,
  vimMode: "normal",
  picker: null,
  focusRequest: 0,
  modalDepth: 0,
  diffHighlight: "word",

  switchBuffer: (dir) =>
    set((s) => {
      const i = BUFFERS.indexOf(s.activeBuffer);
      const next =
        dir === "next"
          ? BUFFERS[(i + 1) % BUFFERS.length]
          : BUFFERS[(i - 1 + BUFFERS.length) % BUFFERS.length];
      return { activeBuffer: next };
    }),
  setActiveBuffer: (b) => set({ activeBuffer: b }),
  openTransient: () => set({ transientOpen: true, commandLineOpen: false }),
  closeTransient: () => set({ transientOpen: false }),
  toggleTransient: () => set((s) => ({ transientOpen: !s.transientOpen })),
  openCommandLine: () => set({ commandLineOpen: true, transientOpen: false }),
  closeCommandLine: () => set({ commandLineOpen: false }),
  setVimMode: (m) => set({ vimMode: m }),
  openPicker: (p) => set({ picker: p, transientOpen: false, commandLineOpen: false }),
  closePicker: () => set({ picker: null }),
  requestFocus: () => set((s) => ({ focusRequest: s.focusRequest + 1 })),
  beginModal: () => set((s) => ({ modalDepth: s.modalDepth + 1 })),
  endModal: () => set((s) => ({ modalDepth: Math.max(0, s.modalDepth - 1) })),
  setDiffHighlight: (m) => set({ diffHighlight: m }),
  toggleDiffHighlight: () =>
    set((s) => ({ diffHighlight: s.diffHighlight === "word" ? "line" : "word" })),
}));
