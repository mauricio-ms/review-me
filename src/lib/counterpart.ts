import { useMinibufferStore } from "../state/minibuffer";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import { selectedBuffer, useWindowStore } from "../state/windows";
import { currentFile, type ShowOptions } from "./buffers";
import { recordJump } from "./jumps";
import { ambientSource, visitFile, type SourceChoice } from "./project";
import { findCounterpart } from "./tauri";

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The file to find a counterpart for: the selected window's, or the diff's cursor row. */
function origin(): { path: string; choice: SourceChoice } | null {
  const file = currentFile();
  if (file) return { path: file.path, choice: { source: file.source, label: file.sourceLabel } };
  const ws = useWindowStore.getState();
  const cursor = useUIStore.getState().diffCursor;
  if (selectedBuffer(ws) !== "diff" || !cursor) return null;
  return { path: cursor.path, choice: ambientSource(useRepoStore.getState().diff?.comparison) };
}

/**
 * `C-x p t` / `C-x 4 t` (projectile's toggle): from a test to the code it tests, or from
 * code to its test, found by naming convention in the same revision — `FooTest.java` ↔
 * `Foo.java`, `foo.test.ts` ↔ `foo.ts`, `test_foo.py` ↔ `foo.py`. When the names can't
 * tell candidates apart, the minibuffer asks.
 */
export async function visitCounterpart(options: ShowOptions = {}): Promise<void> {
  const repo = useRepoStore.getState().repoPath;
  const from = origin();
  const ui = useUIStore.getState();
  if (!repo || !from) {
    ui.showFlash("No file here to find a test or code for");
    return;
  }
  const found = await findCounterpart(repo, from.choice.source, from.path).catch((e) => {
    ui.showFlash(String(e));
    return null;
  });
  if (!found) return;
  const name = baseName(from.path);
  if (found.paths.length === 0) {
    ui.showFlash(found.fromTest ? `No code found for ${name}` : `No test found for ${name}`);
    return;
  }
  const open = (path: string) => {
    if (options.select ?? true) recordJump();
    visitFile(path, from.choice, undefined, options);
  };
  if (found.decisive) {
    open(found.paths[0]);
    return;
  }
  useMinibufferStore.getState().open({
    kind: "choice",
    prompt: found.fromTest ? `Code for ${name}:` : `Test for ${name}:`,
    choices: found.paths.map((path) => ({ id: path, name: baseName(path), label: path })),
    onAccept: open,
  });
}
