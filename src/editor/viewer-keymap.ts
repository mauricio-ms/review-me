import { Prec } from "@codemirror/state";
import { EditorView, keymap, type KeyBinding as CmKeyBinding } from "@codemirror/view";

import { recordJump } from "../lib/jumps";
import { KEYMAP, type ViewerAction } from "../lib/keymap";
import { setProjectCursor } from "../lib/project-view";
import { findUsages, gotoDefinition, jumpBack } from "../lib/xref";
import { useMinibufferStore } from "../state/minibuffer";
import { inVimInsertMode } from "./cm-shared";

/** Run an action unless vim is mid-insert, where the key must stay literal. */
function normalOnly(action: () => void) {
  return (view: EditorView) => {
    if (inVimInsertMode(view)) return false;
    action();
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

const HANDLERS: Record<ViewerAction, () => void> = {
  definition: () => void gotoDefinition(),
  back: () => void jumpBack(),
  references: () => void findUsages(),
  "goto-line": promptGotoLine,
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

const bindings: CmKeyBinding[] = KEYMAP.viewer.flatMap((binding) =>
  binding.external || !binding.action
    ? []
    : binding.keys.map((keys) => ({
        key: cmKey(keys),
        run: normalOnly(HANDLERS[binding.action as ViewerAction]),
      })),
);

/**
 * The viewer's own keys (`keymap.ts`'s `viewer` scope): emacs-xref navigation —
 * `M-.` definition · `M-,` back · `M-?` references — and `M-g g` go to line.
 *
 * Alt chords rather than vim's `C-o`/`C-i` on purpose. codemirror-vim binds those to
 * its own jump list, whose marks are anchored into the document — and the viewer
 * *replaces* its document whenever a file is opened, so that list can't follow a jump
 * across files. Alt sidesteps it rather than overriding it.
 */
export const viewerKeymap = Prec.highest(
  keymap.of([
    ...bindings,
    // `?` needs shift on most layouts; CodeMirror may resolve `M-?` as either spelling.
    { key: "Shift-Alt-/", run: normalOnly(HANDLERS.references) },
  ]),
);
