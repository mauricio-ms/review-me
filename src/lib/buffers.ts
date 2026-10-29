import { useFilesStore, fileBuffer, type FileBuffer } from "../state/files";
import { useUIStore } from "../state/ui";
import {
  inProjectMode,
  isFileKey,
  mainWindow,
  selectedBuffer,
  useWindowStore,
  windowOrder,
  type BufferKey,
  type FileBufferId,
} from "../state/windows";
import { shortOid } from "../types/diff";
import { sameSource, type ProjectSource } from "../types/repo";
import { armRepeat } from "./key-dispatch";
import type { KeyScope } from "./keymap";
import { forgetPositions } from "./project-view";
import { bringBackProject, display, otherWindowFor } from "./windows";

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

/** Where to show a buffer: the selected window, or the other one (`C-x 4`). */
export type ShowOptions = {
  /** In the other window (Emacs's `C-x 4` commands) rather than the selected one. */
  other?: boolean;
  /** Give that window the keyboard (the default); false just shows it there (`C-o`). */
  select?: boolean;
};

/** Show `key` in the selected window — or the other one — and give it the keyboard. */
export function showBuffer(key: BufferKey, options: ShowOptions = {}): void {
  const { selected } = useWindowStore.getState();
  display(key, options.other ? otherWindowFor(key, selected) : selected, options.select ?? true);
}

/** `C-h b` / `C-h m`: the help buffer, listing `from`'s keys first (or only). */
export function openHelp(from: KeyScope, only: boolean, options: ShowOptions = {}): void {
  useUIStore.getState().setHelp({ from, only });
  showBuffer("help", options);
}

/**
 * Switch to the diff — `q` in the project buffer, `M-x diff`, `C-x b diff`, entering a
 * commit. From project mode it has the frame to itself, as magit's status does: the
 * windows it covers are stashed and come back with the project buffer
 * (`bringBackProject`). In the other window (`C-x 4 b diff`) it just shows there.
 */
export function showDiff(options: ShowOptions = {}): void {
  const ws = useWindowStore.getState();
  if (options.other || !inProjectMode(ws) || windowOrder(ws.layout).length === 1) {
    showBuffer("diff", options);
    return;
  }
  ws.setProjectPane(ws.treeFocused ? "tree" : "viewer");
  ws.takeFrame(mainWindow(ws), "diff");
  useUIStore.getState().requestFocus();
}

/**
 * `q` in a file: back to the diff from the main window; a window split off beside it
 * (`C-x 4 .`, `o` in the diff) just closes.
 */
export function quitFile(): void {
  const ws = useWindowStore.getState();
  if (ws.selected !== mainWindow(ws) && windowOrder(ws.layout).length > 1) {
    ws.remove(ws.selected);
    useUIStore.getState().requestFocus();
    return;
  }
  showDiff();
}

/**
 * `q` in help (Emacs's quit-window): the selected window goes back to what it showed before,
 * forgetting the buffer it quit, so a second `q` keeps going back rather than returning
 * to it. A window with nothing to go back to — one split off to show something —
 * closes, as long as it isn't the only one; the only one goes back to the diff.
 */
export function quitWindow(): void {
  const ws = useWindowStore.getState();
  const win = ws.selected;
  const others = new Set(
    Object.entries(ws.shown)
      .filter(([id]) => Number(id) !== win)
      .map(([, key]) => key),
  );
  const next = (ws.prev[win] ?? []).find((k) =>
    isFileKey(k) ? fileBuffer(k) !== undefined : !others.has(k),
  );
  if (next == null && windowOrder(ws.layout).length > 1) ws.remove(win);
  else ws.quitTo(win, next ?? "diff");
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
  const name = bufferLabel(key);
  killFileBuffers([key]);
  ui.showFlash(`Killed ${name}`);
}

/** A buffer's name as `C-x b` writes it. */
function bufferLabel(key: BufferKey): string {
  if (!isFileKey(key)) return key;
  return bufferNames(useFilesStore.getState().buffers).get(key) ?? key;
}

/**
 * `C-x ←` / `C-x →` (Emacs's previous-buffer / next-buffer): back through what the
 * selected window has shown — the diff, the log, help and files alike — and forward
 * again; then `←` / `→` alone keep going (a repeat map). Once the window's own history
 * runs out, `C-x ←` goes on through the other buffers, most recently shown first, as
 * Emacs's does. The diff, the log and help are skipped while another window has them.
 */
export function stepBuffer(dir: "back" | "ahead"): void {
  const ws = useWindowStore.getState();
  const ui = useUIStore.getState();
  const win = ws.selected;
  const current = ws.shown[win];
  const elsewhere = new Set(
    Object.entries(ws.shown)
      .filter(([id]) => Number(id) !== win)
      .map(([, key]) => key),
  );
  const usable = (key: BufferKey) =>
    key !== current && (isFileKey(key) ? fileBuffer(key) !== undefined : !elsewhere.has(key));
  let target = (dir === "back" ? ws.prev[win] : ws.ahead[win])?.find(usable);
  if (!target && dir === "back") {
    const ahead = new Set(ws.ahead[win] ?? []);
    const files = useFilesStore.getState().buffers.map((b) => b.id);
    target = [...ws.recent, "diff" as const, "log" as const, ...files].find(
      (key) => usable(key) && !ahead.has(key),
    );
  }
  if (!target) {
    ui.showFlash(dir === "back" ? "No previous buffer" : "No next buffer");
    return;
  }
  // The diff and the project buffer trade the frame here as they do everywhere else.
  if (target === "diff" && inProjectMode(ws) && windowOrder(ws.layout).length > 1) {
    ws.setProjectPane("viewer");
    ws.takeFrame(win, target, dir);
  } else if (bringBackProject(win, target, dir) != null) {
    useWindowStore.getState().select(win);
  } else {
    ws.step(win, target, dir);
  }
  ws.setTreeFocused(false);
  ui.requestFocus();
  ui.showFlash(`${bufferLabel(target)} — use <left>, <right> for further cycling`);
  armRepeat({
    "<left>": () => stepBuffer("back"),
    "<right>": () => stepBuffer("ahead"),
  });
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
