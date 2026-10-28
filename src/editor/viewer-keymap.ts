import { Prec } from "@codemirror/state";
import { EditorView, keymap, type KeyBinding as CmKeyBinding } from "@codemirror/view";

import { quitWindow } from "../lib/buffers";
import { recordJump } from "../lib/jumps";
import { KEYMAP, type ViewerAction } from "../lib/keymap";
import { gotoChange, gotoChangedFile } from "../lib/project-diff";
import { setProjectCursor } from "../lib/project-view";
import { findUsages, gotoDefinition } from "../lib/xref";
import { useMinibufferStore } from "../state/minibuffer";
import { inVimInsertMode } from "./cm-shared";

/** Run an action unless vim is mid-insert, where the key must stay literal. */
function normalOnly(action: (count: number) => void) {
  return (view: EditorView) => {
    if (inVimInsertMode(view)) return false;
    action(1);
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

/** Every viewer action; `count` is vim's (`3]c`), 1 from a CodeMirror key. */
export const VIEWER_HANDLERS: Record<ViewerAction, (count: number) => void> = {
  definition: () => void gotoDefinition(),
  references: () => void findUsages(),
  "goto-line": promptGotoLine,
  "next-change": (count) => gotoChange(1, count),
  "prev-change": (count) => gotoChange(-1, count),
  "next-file": (count) => gotoChangedFile(1, count),
  "prev-file": (count) => gotoChangedFile(-1, count),
  quit: quitWindow,
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
