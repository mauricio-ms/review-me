import { Vim, type CodeMirrorV } from "@replit/codemirror-vim";

import { KEYMAP, type ViewerAction } from "../lib/keymap";
import { VIEWER_HANDLERS } from "./viewer-keymap";

let defined = false;

/**
 * Map the viewer's vim-bound keys (`keymap.ts`'s `vim: true` entries) as vim commands in
 * normal mode — and in visual mode too for `visual: true` ones, which act on the
 * selection and end it: `q` quits the window, `] c` / `[ c` walk the file's changes,
 * `] f` / `[ f` the changed files, `r` `!` `u` mark. Vim reads the whole sequence, so
 * its own `]]`, `[(`, … still work, and a count (`3]c`) arrives as the action's repeat.
 * In a read-only buffer the keys taken from vim (`r` replace, `u` undo) did nothing.
 */
export function defineNavVim(): void {
  if (defined) return;
  defined = true;
  const v = Vim as unknown as {
    defineAction: (
      name: string,
      fn: (cm: unknown, args: { repeat?: number }) => void,
    ) => void;
    mapCommand: (
      keys: string,
      type: string,
      name: string,
      args: object,
      extra: object,
    ) => void;
    exitVisualMode: (cm: unknown) => void;
  };
  for (const binding of KEYMAP.viewer) {
    if (!binding.vim || !binding.action) continue;
    const action = binding.action as ViewerAction;
    for (const context of binding.visual ? ["normal", "visual"] : ["normal"]) {
      const visual = context === "visual";
      const name = `reviewMe:${action}:${context}`;
      v.defineAction(name, (cm, args) => {
        // The handler reads the selection before anything else, so it can end here —
        // unless taking it ended it already (`project-view.ts`'s `endVisualSelection`).
        VIEWER_HANDLERS[action](args.repeat ?? 1, visual);
        if (visual && (cm as CodeMirrorV).state.vim?.visualMode) v.exitVisualMode(cm);
      });
      for (const keys of binding.keys) {
        v.mapCommand(keys.replace(/ /g, ""), "action", name, {}, { context });
      }
    }
  }
}
