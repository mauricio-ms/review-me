import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";

let writes: Promise<unknown> = Promise.resolve();
let latest = 0;

/** Keep yanks in gesture order, even if the native clipboard takes time to reply. */
export function yankText(text: string, linewise: boolean): void {
  if (linewise && !text.endsWith("\n")) text += "\n";
  const { repo, comparisonEpoch } = useRepoStore.getState();
  const ticket = ++latest;
  const current = () => {
    const state = useRepoStore.getState();
    return ticket === latest && state.repo === repo && state.comparisonEpoch === comparisonEpoch;
  };
  const result = writes.then(() => writeText(text));
  writes = result.catch(() => {});
  void result.then(
    () => {
      if (!current()) return;
      const count = text.split("\n").length - 1;
      useUIStore.getState().showFlash(linewise
        ? `Yanked ${count} line${count === 1 ? "" : "s"}`
        : "Yanked selection");
    },
    (error: unknown) => {
      if (current()) useUIStore.getState().showFlash(`Could not yank: ${String(error)}`);
    },
  );
}
