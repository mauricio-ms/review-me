import { Prec } from "@codemirror/state";
import { EditorView, keymap, type KeyBinding as CmKeyBinding } from "@codemirror/view";

import { quitFile } from "../lib/buffers";
import { recordJump } from "../lib/jumps";
import { KEYMAP, type ViewerAction } from "../lib/keymap";
import { gotoChange, gotoChangedFile } from "../lib/project-diff";
import { flagHere, reviewHere, unmarkHere } from "../lib/project-review";
import { setProjectCursor } from "../lib/project-view";
import { findUsages, gotoDefinition } from "../lib/xref";
import { useMinibufferStore } from "../state/minibuffer";
import { inVimInsertMode } from "./cm-shared";

/** Run an action unless vim is mid-insert, where the key must stay literal. */
function normalOnly(action: ViewerHandler) {
  return (view: EditorView) => {
    if (inVimInsertMode(view)) return false;
    action(1, false);
    return true;
  };
}

/** `M-g g`: read a line number in the minibuffer and go there (a jump `M-,` undoes). */
function promptGotoLine(): void {
  useMinibufferStore.getState().open({
    kind: "text",
    prompt: "Goto line:",
    initial: "",
    onAccept: (value) => {
      const line = Number.parseInt(value.trim(), 10);
      if (!Number.isFinite(line)) return;
      recordJump();
      setProjectCursor(line);
    },
  });
}

/**
 * A viewer action. `count` is vim's (`3]c`), 1 from a CodeMirror key; `visual` says it
 * was pressed in vim's visual mode, on a selection.
 */
type ViewerHandler = (count: number, visual: boolean) => void;

export const VIEWER_HANDLERS: Record<ViewerAction, ViewerHandler> = {
  definition: () => void gotoDefinition(),
  references: () => void findUsages(),
  "goto-line": promptGotoLine,
  "next-change": (count) => gotoChange(1, count),
  "prev-change": (count) => gotoChange(-1, count),
  "next-file": (count) => gotoChangedFile(1, count),
  "prev-file": (count) => gotoChangedFile(-1, count),
  review: () => void reviewHere(),
  flag: () => void flagHere(),
  unmark: (_count, visual) => void unmarkHere(visual),
  quit: quitFile,
};

/** `M-g g` → `Alt-g g`: keymap.ts's Emacs notation in CodeMirror's spelling. */
function cmKey(keys: string): string {
  return keys
    .split(" ")
    .map((chord) =>
      chord
        .replace(/^C-M-/, "Ctrl-Alt-")
        .replace(/^C-/, "Ctrl-")
        .replace(/^M-/, "Alt-")
        .replace(/RET$/, "Enter"),
    )
    .join(" ");
}

// The vim-bound ones are mapped in `vim-nav.ts` instead.
const bindings: CmKeyBinding[] = KEYMAP.viewer.flatMap((binding) =>
  binding.external || binding.vim || !binding.action
    ? []
    : binding.keys.map((keys) => ({
        key: cmKey(keys),
        run: normalOnly(VIEWER_HANDLERS[binding.action as ViewerAction]),
      })),
);

/**
 * The viewer's own keys (`keymap.ts`'s `viewer` scope): emacs-xref navigation —
 * `M-.` definition · `M-?` references (`M-,` back is global: history spans every
 * buffer) — and `M-g g` go to line.
 *
 * Alt chords rather than vim's `C-o`/`C-i` on purpose. codemirror-vim binds those to
 * its own jump list, whose marks are anchored into the document — and each buffer has
 * its own document, so that list can't follow a jump across files. Alt sidesteps it
 * rather than overriding it.
 */
export const viewerKeymap = Prec.highest(
  keymap.of([
    ...bindings,
    // `?` needs shift on most layouts; CodeMirror may resolve `M-?` as either spelling.
    { key: "Shift-Alt-/", run: normalOnly(VIEWER_HANDLERS.references) },
  ]),
);
