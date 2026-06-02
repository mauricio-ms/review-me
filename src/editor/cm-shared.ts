import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";

import { useUIStore } from "../state/ui";

/**
 * True when vim is in insert/replace mode. In those modes the leader keys must
 * insert a literal char, so the bindings below bail out. We read the authoritative
 * vim state from the view rather than relying on keymap precedence (which fires in
 * insert mode too). This is the hard-won rule from video-studio's CLAUDE.md.
 */
export function inVimInsertMode(view: EditorView): boolean {
  const cm = getCM(view) as
    | { state?: { vim?: { insertMode?: boolean } } }
    | null;
  return !!cm?.state?.vim?.insertMode;
}

/** LazyVim-style leader keys inside a CodeMirror editor (vim normal/visual only). */
export const leaderKeymap = Prec.highest(
  keymap.of([
    {
      key: " ",
      run: (view) => {
        if (inVimInsertMode(view)) return false;
        useUIStore.getState().openTransient();
        return true;
      },
    },
    {
      key: ":",
      run: (view) => {
        if (inVimInsertMode(view)) return false;
        useUIStore.getState().openCommandLine();
        return true;
      },
    },
  ]),
);

/** Ctrl+[ → Esc (the WebKitGTK webview drops the vim extension's own binding). */
export const vimEscapeKeymap = Prec.highest(
  keymap.of([
    {
      key: "Ctrl-[",
      run: (view) => {
        if (!inVimInsertMode(view)) return false;
        const cm = getCM(view);
        if (!cm) return false;
        Vim.handleKey(cm, "<Esc>", "user");
        return true;
      },
    },
  ]),
);
