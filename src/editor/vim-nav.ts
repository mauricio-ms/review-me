import { Vim } from "@replit/codemirror-vim";

import { KEYMAP, type ViewerAction } from "../lib/keymap";
import { VIEWER_HANDLERS } from "./viewer-keymap";

let defined = false;

/**
 * Map the viewer's vim-bound keys (`keymap.ts`'s `vim: true` entries) as vim commands in
 * normal mode: `q` quits the window, `] c` / `[ c` walk the file's changes, `] f` / `[ f`
 * the changed files. Vim reads the whole sequence, so its own `]]`, `[(`, … still work,
 * and a count (`3]c`) arrives as the action's repeat.
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
  };
  for (const binding of KEYMAP.viewer) {
    if (!binding.vim || !binding.action) continue;
    const action = binding.action as ViewerAction;
    const name = `reviewMe:${action}`;
    v.defineAction(name, (_cm, args) => VIEWER_HANDLERS[action](args.repeat ?? 1));
    for (const keys of binding.keys) {
      v.mapCommand(keys.replace(/ /g, ""), "action", name, {}, { context: "normal" });
    }
  }
}
