import { useFilesStore, fileBuffer, type FileBuffer } from "../state/files";
import { useProjectStore } from "../state/project";
import { useUIStore } from "../state/ui";
import {
  isFileKey,
  selectedBuffer,
  useWindowStore,
  type BufferKey,
  type FileBufferId,
} from "../state/windows";
import { shortOid } from "../types/diff";
import { sameSource, type ProjectSource } from "../types/repo";
import { armRepeat } from "./key-dispatch";
import type { KeyScope } from "./keymap";
import { forgetPositions } from "./project-view";

/** The file buffer in the selected window, if it shows one. */
export function currentFile(): FileBuffer | null {
  const key = selectedBuffer(useWindowStore.getState());
  return isFileKey(key) ? (fileBuffer(key) ?? null) : null;
}

/** `currentFile()` as a hook. */
export function useCurrentFile(): FileBuffer | null {
  const key = useWindowStore(selectedBuffer);
  return useFilesStore((s) =>
    isFileKey(key) ? (s.buffers.find((b) => b.id === key) ?? null) : null,
  );
}

/** The open buffer for `path` at `source`, if there is one. */
export function findFileBuffer(source: ProjectSource, path: string): FileBuffer | undefined {
  return useFilesStore
    .getState()
    .buffers.find((b) => b.path === path && sameSource(b.source, source));
}

/** Show `key` in the selected window and give that window the keyboard. */
export function showBuffer(key: BufferKey): void {
  const ws = useWindowStore.getState();
  ws.show(ws.selected, key);
  ws.setTreeFocused(false);
  useUIStore.getState().requestFocus();
}

/** `C-h b` / `C-h m`: the help buffer, listing `from`'s keys first (or only). */
export function openHelp(from: KeyScope, only: boolean): void {
  useUIStore.getState().setHelp({ from, only });
  showBuffer("help");
}

/**
 * `q` (Emacs's quit-window): the selected window goes back to what it showed before —
 * the diff, when it remembers nothing — and forgets the buffer it quit, so a second
 * `q` keeps going back rather than returning to it.
 */
export function quitWindow(): void {
  const ws = useWindowStore.getState();
  const win = ws.selected;
  const others = new Set(
    Object.entries(ws.shown)
      .filter(([id]) => Number(id) !== win)
      .map(([, key]) => key),
  );
  const next =
    (ws.prev[win] ?? []).find((k) =>
      isFileKey(k) ? fileBuffer(k) !== undefined : !others.has(k),
    ) ?? "diff";
  ws.quitTo(win, next);
  ws.setTreeFocused(false);
  useUIStore.getState().requestFocus();
}

/**
 * Close file buffers: every window showing one goes back to what it showed before,
 * and their remembered places go with them.
 */
export function killFileBuffers(ids: FileBufferId[]): void {
  if (ids.length === 0) return;
  useWindowStore.getState().forget(ids);
  useFilesStore.getState().remove(ids);
  forgetPositions(ids);
  useUIStore.getState().requestFocus();
}

/**
 * `C-x k`: kill the buffer in the selected window. Only open files can go — the diff
 * and the log always exist, and killing help is leaving it.
 */
export function killCurrentBuffer(): void {
  const key = selectedBuffer(useWindowStore.getState());
  const ui = useUIStore.getState();
  if (key === "help") {
    quitWindow();
    return;
  }
  if (!isFileKey(key)) {
    ui.showFlash(`The ${key} buffer can't be killed — C-x b switches away from it`);
    return;
  }
  const name = bufferNames(useFilesStore.getState().buffers).get(key) ?? key;
  killFileBuffers([key]);
  ui.showFlash(`Killed ${name}`);
}

/**
 * `C-x <left>` / `C-x <right>`: the previous or next open file, in the order they were
 * opened; then `<left>` and `<right>` alone keep going (Emacs's repeat map).
 */
export function cycleFileBuffers(step: 1 | -1): void {
  const { buffers } = useFilesStore.getState();
  const ui = useUIStore.getState();
  if (buffers.length === 0) {
    ui.showFlash("No files are open");
    return;
  }
  const key = selectedBuffer(useWindowStore.getState());
  const at = buffers.findIndex((b) => b.id === key);
  const next =
    at < 0
      ? step > 0
        ? 0
        : buffers.length - 1
      : (at + step + buffers.length) % buffers.length;
  showBuffer(buffers[next].id);
  const name = bufferNames(buffers).get(buffers[next].id) ?? buffers[next].path;
  ui.showFlash(
    `${name} (${next + 1}/${buffers.length}) — use <left>, <right> for further cycling`,
  );
  armRepeat({
    "<left>": () => cycleFileBuffers(-1),
    "<right>": () => cycleFileBuffers(1),
  });
}

/** `M-x project`: the file tree, shown if it was hidden, with the keyboard. */
export function focusTree(): void {
  const ps = useProjectStore.getState();
  if (ps.treeHidden) ps.setTreeHidden(false);
  useWindowStore.getState().setTreeFocused(true);
  useUIStore.getState().requestFocus();
}

/** `C-x o`: between the file tree and the window (the tree comes back if hidden). */
export function otherWindow(): void {
  const ws = useWindowStore.getState();
  const ps = useProjectStore.getState();
  if (ps.treeHidden) {
    focusTree();
    return;
  }
  ws.setTreeFocused(!ws.treeFocused);
  useUIStore.getState().requestFocus();
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const folders = (path: string) => path.split("/").slice(0, -1);
const tail = (dirs: string[], k: number) => dirs.slice(Math.max(0, dirs.length - k)).join("/");

/**
 * Each file buffer's name, as Emacs's uniquify writes them: the file name alone, or —
 * when two open files share it — with as few of its last folders as tell them apart
 * (`Item.java<model>`, `Item.java<catalog>`), and the revision when it is the same file
 * read twice (`Item.java<9fceb02>`).
 */
export function bufferNames(buffers: FileBuffer[]): Map<FileBufferId, string> {
  const byName = new Map<string, FileBuffer[]>();
  for (const b of buffers) {
    const name = baseName(b.path);
    byName.set(name, [...(byName.get(name) ?? []), b]);
  }
  const names = new Map<FileBufferId, string>();
  for (const [name, group] of byName) {
    for (const b of group) {
      const dirs = folders(b.path);
      const others = group.filter((o) => o.path !== b.path).map((o) => folders(o.path));
      const parts: string[] = [];
      if (others.length > 0 && dirs.length > 0) {
        let k = 1;
        while (k < dirs.length && others.some((o) => tail(o, k) === tail(dirs, k))) k++;
        parts.push(tail(dirs, k));
      }
      if (group.some((o) => o !== b && o.path === b.path)) {
        parts.push(b.source.kind === "worktree" ? "worktree" : shortOid(b.source.oid));
      }
      names.set(b.id, parts.length > 0 ? `${name}<${parts.join(" ")}>` : name);
    }
  }
  return names;
}
