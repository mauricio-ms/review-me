import { create } from "zustand";

import type { FlagTag, ReviewedTag, TagStore } from "../types/tags";

// Module-level stable empties — never return fresh [] from selectors (avoids the
// Zustand infinite-rerender trap).
const EMPTY_REVIEWED: ReviewedTag[] = [];
const EMPTY_FLAGS: FlagTag[] = [];

type TagsState = {
  reviewed: ReviewedTag[];
  flags: FlagTag[];
  setStore: (store: TagStore) => void;
  clear: () => void;
};

export const useTagsStore = create<TagsState>((set) => ({
  reviewed: EMPTY_REVIEWED,
  flags: EMPTY_FLAGS,
  setStore: (store) => set({ reviewed: store.reviewed, flags: store.flags }),
  clear: () => set({ reviewed: EMPTY_REVIEWED, flags: EMPTY_FLAGS }),
}));
