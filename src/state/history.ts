import { create } from "zustand";

import type { SourceChoice } from "../lib/project";
import { sameSource } from "../types/repo";

/** A place worth coming back to, in whichever buffer it was. */
export type Place =
  | { kind: "file"; path: string; choice: SourceChoice; line: number; col: number }
  /** A row of the diff buffer: a file, and a line of it when the cursor was on one. */
  | { kind: "diff"; path: string | null; line: number | null }
  | { kind: "log"; oid: string | null };

const EMPTY: Place[] = [];

/** Oldest places fall off rather than the lists growing without bound. */
const MAX_DEPTH = 100;

export function samePlace(a: Place, b: Place): boolean {
  switch (a.kind) {
    case "file":
      return (
        b.kind === "file" &&
        a.path === b.path &&
        a.line === b.line &&
        sameSource(a.choice.source, b.choice.source)
      );
    case "diff":
      return b.kind === "diff" && a.path === b.path && a.line === b.line;
    case "log":
      return b.kind === "log" && a.oid === b.oid;
  }
}

type HistoryState = {
  /** Where you came from, most recent last. */
  back: Place[];
  /** Where you went back from, most recent last. */
  forward: Place[];
  /** A move away from `place`: it goes on the back list, and the way forward is gone. */
  record: (place: Place) => void;
  /** Step back from `here` (which goes on the forward list); null when there's nothing. */
  stepBack: (here: Place | null) => Place | null;
  /** Step forward from `here` (which goes on the back list); null when there's nothing. */
  stepForward: (here: Place | null) => Place | null;
  clear: () => void;
};

/** Take the last place of `list` that isn't `here` — a recorded move that went nowhere. */
function takeFrom(list: Place[], here: Place | null): [Place | null, Place[]] {
  const rest = [...list];
  while (rest.length > 0) {
    const place = rest.pop()!;
    if (!here || !samePlace(place, here)) return [place, rest];
  }
  return [null, rest];
}

const pushed = (list: Place[], place: Place) => {
  const top = list[list.length - 1];
  return top && samePlace(top, place) ? list : [...list, place].slice(-MAX_DEPTH);
};

/**
 * Where navigation has been, as a browser (or Emacs's xref) keeps it: `M-,` goes back,
 * `C-M-,` forward again, and a new move drops the way forward. Places name a file at a
 * revision of the comparison under review, a diff row, or a commit — so the history is
 * cleared whenever the comparison changes: nothing it points at means the same there.
 */
export const useHistoryStore = create<HistoryState>((set, get) => ({
  back: EMPTY,
  forward: EMPTY,

  record: (place) =>
    set((s) => ({ back: pushed(s.back, place), forward: EMPTY })),

  stepBack: (here) => {
    const [place, back] = takeFrom(get().back, here);
    if (!place) return null;
    set((s) => ({ back, forward: here ? pushed(s.forward, here) : s.forward }));
    return place;
  },

  stepForward: (here) => {
    const [place, forward] = takeFrom(get().forward, here);
    if (!place) return null;
    set((s) => ({ forward, back: here ? pushed(s.back, here) : s.back }));
    return place;
  },

  clear: () =>
    set((s) =>
      s.back.length === 0 && s.forward.length === 0 ? {} : { back: EMPTY, forward: EMPTY },
    ),
}));
