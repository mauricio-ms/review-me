import { create } from "zustand";

import type { KeyScope } from "../lib/keymap";

export type BufferName = "diff" | "project" | "log" | "help";
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
  | "commitReviewed"
  | "branchCompare"
  | "commitPick"
  | "checkoutBranch";

/** The file (and line) under the diff buffer's cursor, for the mode line. */
export type CursorPath = { path: string; line: number | null };

/** What the help buffer shows: everything (`C-h b`) or one keymap (`C-h m`). */
export type HelpView = {
  /** The keymap that was active when help opened; listed first. */
  from: KeyScope;
  /** Only `from` (`C-h m`), not every keymap. */
  only: boolean;
};

type UIState = {
  activeBuffer: BufferName;
  /** Where `q` in the help buffer and `C-x b`'s default go back to. */
  previousBuffer: BufferName;
  help: HelpView;
  vimMode: VimMode;
  picker: PickerKind;
  focusRequest: number;
  modalDepth: number;
  diffHighlight: DiffHighlightMode;
  /** A one-line message for the echo area (e.g. where `export` wrote); fades. */
  flash: string | null;
  /** A half-typed key sequence (`C-x-`) or `C-h k`'s prompt, for the echo area. */
  keyEcho: string | null;
  diffCursor: CursorPath | null;

  setActiveBuffer: (b: BufferName) => void;
  openHelp: (from: KeyScope, only: boolean) => void;
  setVimMode: (m: VimMode) => void;
  openPicker: (p: Exclude<PickerKind, null>) => void;
  closePicker: () => void;
  requestFocus: () => void;
  beginModal: () => void;
  endModal: () => void;
  setDiffHighlight: (m: DiffHighlightMode) => void;
  toggleDiffHighlight: () => void;
  showFlash: (message: string) => void;
  setKeyEcho: (echo: string | null) => void;
  setDiffCursor: (cursor: CursorPath | null) => void;
};

/** How long an echo-area message stays up. */
const FLASH_MS = 6000;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

export const useUIStore = create<UIState>((set) => ({
  activeBuffer: "diff",
  previousBuffer: "diff",
  help: { from: "global", only: false },
  vimMode: "normal",
  picker: null,
  focusRequest: 0,
  modalDepth: 0,
  diffHighlight: "word",
  flash: null,
  keyEcho: null,
  diffCursor: null,

  setActiveBuffer: (b) =>
    set((s) =>
      s.activeBuffer === b ? {} : { activeBuffer: b, previousBuffer: s.activeBuffer },
    ),
  openHelp: (from, only) =>
    set((s) => ({
      help: { from, only },
      activeBuffer: "help",
      // Reopening help from help keeps the way back out.
      previousBuffer: s.activeBuffer === "help" ? s.previousBuffer : s.activeBuffer,
      focusRequest: s.focusRequest + 1,
    })),
  setVimMode: (m) => set({ vimMode: m }),
  openPicker: (p) => set({ picker: p }),
  closePicker: () => set({ picker: null }),
  requestFocus: () => set((s) => ({ focusRequest: s.focusRequest + 1 })),
  beginModal: () => set((s) => ({ modalDepth: s.modalDepth + 1 })),
  endModal: () => set((s) => ({ modalDepth: Math.max(0, s.modalDepth - 1) })),
  setDiffHighlight: (m) => set({ diffHighlight: m }),
  toggleDiffHighlight: () =>
    set((s) => ({ diffHighlight: s.diffHighlight === "word" ? "line" : "word" })),
  showFlash: (message) => {
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashTimer = null;
      set({ flash: null });
    }, FLASH_MS);
    set({ flash: message });
  },
  setKeyEcho: (echo) => set({ keyEcho: echo }),
  setDiffCursor: (cursor) =>
    set((s) =>
      s.diffCursor?.path === cursor?.path && s.diffCursor?.line === cursor?.line
        ? {}
        : { diffCursor: cursor },
    ),
}));
