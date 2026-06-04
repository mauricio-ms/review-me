import { Vim } from "@replit/codemirror-vim";

import { findUsages, gotoDefinition } from "../lib/xref";

let defined = false;

/** Bind `gd` / `gr` in the project viewer to go-to-definition / find-references. */
export function defineXrefVim(): void {
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
  v.defineAction("reviewMeGotoDef", () => void gotoDefinition());
  v.defineAction("reviewMeFindRefs", () => void findUsages());
  v.mapCommand("gd", "action", "reviewMeGotoDef", {}, { context: "normal" });
  v.mapCommand("gr", "action", "reviewMeFindRefs", {}, { context: "normal" });
}
