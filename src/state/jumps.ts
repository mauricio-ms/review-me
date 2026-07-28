import { create } from "zustand";

/** A viewer position worth returning to. */
export type JumpEntry = { file: string; line: number; col: number };

const EMPTY_STACK: JumpEntry[] = [];

/** Oldest entries fall off the bottom rather than growing without bound. */
const MAX_DEPTH = 100;

type JumpState = {
  stack: JumpEntry[];
  /** Record a position. Re-recording the line already on top is a no-op. */
  push: (entry: JumpEntry) => void;
  pop: () => JumpEntry | null;
  clear: () => void;
};

/**
 * Where navigation came from, emacs-style: a pop-only marker stack (`M-,`), not a
 * back/forward pair. Entries are viewer-local — they name a file and a cursor, never
 * a revision — so the stack is cleared whenever the project source changes, since
 * nothing it points at is reachable in the new one.
 */
export const useJumpStore = create<JumpState>((set, get) => ({
  stack: EMPTY_STACK,

  push: (entry) =>
    set((s) => {
      const top = s.stack[s.stack.length - 1];
      if (top && top.file === entry.file && top.line === entry.line) return {};
      return { stack: [...s.stack, entry].slice(-MAX_DEPTH) };
    }),

  pop: () => {
    const { stack } = get();
    if (stack.length === 0) return null;
    set({ stack: stack.slice(0, -1) });
    return stack[stack.length - 1];
  },

  clear: () => set((s) => (s.stack.length === 0 ? {} : { stack: EMPTY_STACK })),
}));
