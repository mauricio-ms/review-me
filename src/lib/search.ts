import { getCM, Vim, type CodeMirrorV } from "@replit/codemirror-vim";
import type { EditorView } from "@codemirror/view";

import { useMinibufferStore } from "../state/minibuffer";
import { useSearchStore } from "../state/search";
import { useUIStore } from "../state/ui";
import { activeView } from "./project-view";
import { nextSwiperHit, stepSwiperHit, type SearchRepeat, type SwiperHit } from "./swiper";

const searchViews = new Set<EditorView>();

export function registerSearchView(view: EditorView): () => void {
  searchViews.add(view);
  return () => { searchViews.delete(view); };
}

/** Retire native overlays in every window, including ones hidden behind another buffer. */
export function clearNativeSearchHighlights(): void {
  for (const view of searchViews) {
    const cm = getCM(view);
    if (cm?.state.vim?.searchState_) Vim.handleEx(cm as CodeMirrorV, "nohlsearch");
  }
}

/** Evil's :noh[lsearch], read in the bottom minibuffer in every searchable buffer. */
export function openSearchCommand(): void {
  const view = activeView();
  const cm = view ? getCM(view) : null;
  if (cm) Vim.handleKey(cm, "<Esc>", "user");
  useMinibufferStore.getState().open({
    kind: "text",
    prompt: ":",
    onAccept: (value) => {
      const command = value.trim();
      if (!command) return;
      if (command.length >= 3 && "nohlsearch".startsWith(command)) {
        useSearchStore.getState().clear();
        clearNativeSearchHighlights();
      } else {
        useUIStore.getState().showFlash(`Not an editor command: ${command}`);
      }
    },
  });
}

/** Search fresh buffer content, so repeats never hold rows from an earlier revision. */
export function repeatSearch(
  lines: readonly string[],
  position: { index: number; column: number },
  repeat: SearchRepeat,
  byOccurrence = false,
  indexed?: readonly SwiperHit[],
) {
  const { query, matcher, reveal, direction } = useSearchStore.getState();
  if (!matcher) {
    useUIStore.getState().showFlash("No previous search");
    return null;
  }
  reveal();
  const move = { ...repeat, direction: (repeat.direction * direction) as 1 | -1 };
  const hit = indexed
    ? stepSwiperHit(indexed, position, move, byOccurrence)
    : nextSwiperHit(lines, matcher, position, move, byOccurrence);
  if (!hit) useUIStore.getState().showFlash(`No match: ${query}`);
  return hit;
}
