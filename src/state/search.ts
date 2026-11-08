import { create } from "zustand";

import { compileSearchRegexp, compileSwiper, type SwiperMatcher } from "../lib/swiper";

/** The last accepted buffer search; hiding its marks keeps it available to n / N. */
export const useSearchStore = create<{
  query: string;
  matcher: SwiperMatcher | null;
  visible: boolean;
  direction: 1 | -1;
  accept: (query: string) => void;
  acceptNative: (pattern: RegExp, reversed: boolean) => void;
  reveal: () => void;
  clear: () => void;
}>((set) => ({
  query: "",
  matcher: null,
  visible: false,
  direction: 1,
  accept: (query) => set({ query, matcher: compileSwiper(query), visible: true, direction: 1 }),
  acceptNative: (pattern, reversed) => set({
    query: pattern.source, matcher: compileSearchRegexp(pattern), visible: true, direction: reversed ? -1 : 1,
  }),
  reveal: () => set((s) => s.visible ? s : { visible: true }),
  clear: () => set((s) => s.visible ? { visible: false } : s),
}));
