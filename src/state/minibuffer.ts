import { create } from "zustand";

import type { SwiperHit, SwiperMatcher } from "../lib/swiper";
import { useUIStore } from "./ui";

/**
 * What the minibuffer at the bottom of the window is reading: a command (`M-x`), a
 * buffer (`C-x b`, `C-x 4 b`), one of a caller's choices (`C-x 4 t`'s candidates), a
 * line of text for some caller (`M-g g`'s line, `C-s` in help), a Swiper search over a
 * buffer's lines (`C-s` in a file), or a `y` / `n` answer (Emacs's `y-or-n-p`: `u` asks
 * before it deletes a note).
 */
export type MinibufferRequest =
  | { kind: "command" }
  | { kind: "buffer"; /** Into the other window (`C-x 4 b`). */ other?: boolean }
  | {
      kind: "choice";
      prompt: string;
      /** The first is the default. */
      choices: { id: string; name: string; label: string }[];
      onAccept: (id: string) => void;
    }
  | {
      kind: "text";
      prompt: string;
      initial?: string;
      /** Every edit, for callers that follow the text live (help's search). */
      onChange?: (value: string) => void;
      onAccept: (value: string) => void;
      onCancel?: () => void;
    }
  | SwiperRequest
  | {
      kind: "confirm";
      /** The question; the minibuffer adds `(y or n)`. */
      prompt: string;
      /** `y` answers true; `n`, `C-g` and `ESC` false. */
      onAnswer: (yes: boolean) => void;
    };

/** Swiper: the lines that match as you type, the buffer following the selected one. */
export type SwiperRequest = {
  kind: "swiper";
  /** The buffer's lines, searched in order. */
  lines: readonly string[];
  /** The cursor's line (0-based): selected to begin with, and where matching starts. */
  start: number;
  /** The symbol at the cursor, which `M-n` searches for. */
  atPoint: string | null;
  /** The selected line as it changes (null: nothing matches), for the buffer to show. */
  onMove: (hit: SwiperHit | null, matcher: SwiperMatcher | null) => void;
  /** `RET` on a line; `RET` with nothing matching is a cancel. */
  onAccept: (hit: SwiperHit) => void;
  onCancel: () => void;
};

type MinibufferState = {
  request: MinibufferRequest | null;
  /** Bumped per opening, so each read starts from a fresh prompt. */
  session: number;
  open: (request: MinibufferRequest) => void;
  close: () => void;
};

export const useMinibufferStore = create<MinibufferState>((set) => ({
  request: null,
  session: 0,
  open: (request) => {
    // The minibuffer and a modal picker never share the screen.
    useUIStore.getState().closePicker();
    set((s) => ({ request, session: s.session + 1 }));
  },
  close: () => set({ request: null }),
}));
