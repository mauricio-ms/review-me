import { create } from "zustand";

import type { FlagTag, IgnoredTag, ReviewedTag, TagStore } from "../types/tags";

// Module-level stable empties — never return fresh [] from selectors (avoids the
// Zustand infinite-rerender trap).
const EMPTY_REVIEWED: ReviewedTag[] = [];
const EMPTY_FLAGS: FlagTag[] = [];
const EMPTY_IGNORED: IgnoredTag[] = [];

type TagsState = {
  reviewed: ReviewedTag[];
  flags: FlagTag[];
  ignored: IgnoredTag[];
  setStore: (store: TagStore) => void;
  clear: () => void;
};

export const useTagsStore = create<TagsState>((set) => ({
  reviewed: EMPTY_REVIEWED,
  flags: EMPTY_FLAGS,
  ignored: EMPTY_IGNORED,
  setStore: (store) =>
    set({ reviewed: store.reviewed, flags: store.flags, ignored: store.ignored }),
  clear: () =>
    set({ reviewed: EMPTY_REVIEWED, flags: EMPTY_FLAGS, ignored: EMPTY_IGNORED }),
}));
