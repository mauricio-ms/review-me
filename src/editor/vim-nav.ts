import { Vim } from "@replit/codemirror-vim";

import { backToDiff } from "../lib/project";

let defined = false;

/** Bind `q` in the project viewer to return to the diff buffer (magit-style quit). */
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
  v.defineAction("reviewMeBackToDiff", () => backToDiff());
  v.mapCommand("q", "action", "reviewMeBackToDiff", {}, { context: "normal" });
}
