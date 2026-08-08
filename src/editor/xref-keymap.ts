import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

import { findUsages, gotoDefinition, jumpBack } from "../lib/xref";
import { inVimInsertMode } from "./cm-shared";

/** Run an action unless vim is mid-insert, where the key must stay literal. */
function normalOnly(action: () => void) {
  return (view: EditorView) => {
    if (inVimInsertMode(view)) return false;
    action();
    return true;
  };
}

/**
 * Emacs-xref code navigation in the project viewer:
 * `M-.` find definitions · `M-,` pop back · `M-?` find references.
 *
 * Alt chords rather than vim's `C-o`/`C-i` on purpose. codemirror-vim binds those to
 * its own jump list, whose marks are anchored into the document — and the viewer
 * *replaces* its document whenever a file is opened, so that list can't follow a jump
 * across files. Alt sidesteps it rather than overriding it.
 */
export const xrefKeymap = Prec.highest(
  keymap.of([
    { key: "Alt-.", run: normalOnly(() => void gotoDefinition()) },
    { key: "Alt-,", run: normalOnly(() => void jumpBack()) },
    // `?` needs shift on most layouts; bind both spellings so either resolution works.
    { key: "Alt-?", run: normalOnly(() => void findUsages()) },
    { key: "Shift-Alt-/", run: normalOnly(() => void findUsages()) },
  ]),
);
