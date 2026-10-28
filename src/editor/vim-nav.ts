import { Vim } from "@replit/codemirror-vim";

import { quitWindow } from "../lib/buffers";

let defined = false;

/**
 * Bind `q` in the file viewer to quit its window (magit-style): back to what the window
 * showed before — the diff, usually.
 */
export function defineNavVim(): void {
  if (defined) return;
  defined = true;
  const v = Vim as unknown as {
    defineAction: (name: string, fn: () => void) => void;
    mapCommand: (
      keys: string,
      type: string,
      name: string,
      args: object,
      extra: object,
    ) => void;
  };
  v.defineAction("reviewMeQuitWindow", () => quitWindow());
  v.mapCommand("q", "action", "reviewMeQuitWindow", {}, { context: "normal" });
}
