import { useFilesStore } from "../state/files";
import { useProjectStore } from "../state/project";
import { useUIStore } from "../state/ui";
import {
  inProjectMode,
  isFileKey,
  isSingleton,
  mainWindow,
  useWindowStore,
  windowOrder,
  windowShowing,
  type BufferKey,
  type WindowId,
} from "../state/windows";
import { positionOf, savePosition } from "./project-view";

/** Give window `win` the selection and the keyboard. */
export function selectWindow(win: WindowId): void {
  useWindowStore.getState().select(win);
  useUIStore.getState().requestFocus();
}

/**
 * Show `key` in window `win` and return the window that shows it. A single-cursor
 * buffer (the diff, the log, help) already in another window isn't shown twice: that
 * window is the one (Emacs's reuse-window). `select` (the default) gives it the keyboard.
 */
export function display(key: BufferKey, win: WindowId, select = true): WindowId {
  const ws = useWindowStore.getState();
  const elsewhere = isSingleton(key) ? windowShowing(ws, key, win) : null;
  const target = elsewhere ?? win;
  if (elsewhere == null) ws.show(target, key);
  if (select) ws.select(target);
  else if (ws.treeFocused) ws.setTreeFocused(false);
  useUIStore.getState().requestFocus();
  return target;
}

/** Split window `win`; the new window shows `key` — at the same place, if it's the same file. */
function splitFor(win: WindowId, dir: "row" | "column", key: BufferKey): WindowId {
  const ws = useWindowStore.getState();
  const same = ws.shown[win] === key;
  const added = ws.split(win, dir, key);
  if (same && isFileKey(key)) {
    const pos = positionOf(win, key);
    if (pos) savePosition(added, key, { ...pos, center: false });
  }
  return added;
}

/**
 * What "the other window" is for showing `key` from window `from` (Emacs's `C-x 4`):
 * a window already showing it, else the next window, else a new one split off to the
 * right of `from`.
 */
export function otherWindowFor(key: BufferKey, from: WindowId): WindowId {
  const ws = useWindowStore.getState();
  // The diff can't be in two windows: "the diff, in the other window" from the diff is
  // just the diff.
  if (isSingleton(key) && ws.shown[from] === key) return from;
  const showing = windowShowing(ws, key, from);
  if (showing != null) return showing;
  const order = windowOrder(ws.layout);
  if (order.length > 1) return order[(order.indexOf(from) + 1) % order.length];
  return splitFor(from, "row", key);
}

/**
 * The buffer a new window shows when the one split shows the diff, the log or help —
 * which can't be in two windows: the most recently shown buffer not on screen, else any
 * open file.
 */
function otherBuffer(): BufferKey | null {
  const ws = useWindowStore.getState();
  const visible = new Set(Object.values(ws.shown));
  const files = useFilesStore.getState().buffers.map((b) => b.id);
  const candidates: BufferKey[] = [...ws.recent, "diff", "log", ...files];
  return (
    candidates.find((k) => !visible.has(k)) ?? candidates.find((k) => isFileKey(k)) ?? null
  );
}

/**
 * `C-x 3` / `C-x 2`: split the selected window side by side (`row`) or stacked
 * (`column`). As in Emacs both halves show the same file, each with its own cursor, and
 * the selection stays where it was.
 */
export function splitWindow(dir: "row" | "column"): void {
  const ws = useWindowStore.getState();
  const key = ws.shown[ws.selected];
  const next = isFileKey(key) ? key : otherBuffer();
  if (!next) {
    useUIStore.getState().showFlash("Nothing else to show in a new window");
    return;
  }
  splitFor(ws.selected, dir, next);
  useUIStore.getState().requestFocus();
}

/** `C-x 0`: close the selected window; its space and the selection go to its neighbour. */
export function deleteWindow(): void {
  const ws = useWindowStore.getState();
  if (windowOrder(ws.layout).length <= 1) {
    useUIStore.getState().showFlash("Can't delete the only window");
    return;
  }
  ws.remove(ws.selected);
  useUIStore.getState().requestFocus();
}

/** `C-x 1`: the selected window alone. */
export function deleteOtherWindows(): void {
  const ws = useWindowStore.getState();
  ws.keepOnly(ws.selected);
  ws.setTreeFocused(false);
  useUIStore.getState().requestFocus();
}

/** Whether the file tree is on screen: project mode, and not hidden. */
export function treeShown(): boolean {
  return inProjectMode(useWindowStore.getState()) && !useProjectStore.getState().treeHidden;
}

/**
 * `M-x project`: the file tree, shown if it was hidden, with the keyboard. From outside
 * project mode (the diff, the log) it comes up to pick a file with, and that file goes
 * to the main window — which is what makes it project mode.
 */
export function focusTree(): void {
  const ps = useProjectStore.getState();
  if (ps.treeHidden) ps.setTreeHidden(false);
  const ws = useWindowStore.getState();
  if (!inProjectMode(ws)) ws.select(mainWindow(ws));
  useWindowStore.getState().setTreeFocused(true);
  useUIStore.getState().requestFocus();
}

/**
 * `C-x o`: the next window, in order — the file tree first, in project mode. With one
 * window there and the tree hidden, it brings the tree back rather than going nowhere.
 */
export function otherWindow(): void {
  const ws = useWindowStore.getState();
  const order = windowOrder(ws.layout);
  const tree = treeShown();
  if (order.length === 1 && !tree) {
    if (inProjectMode(ws)) focusTree();
    else useUIStore.getState().showFlash("No other window");
    return;
  }
  const stops: ("tree" | WindowId)[] = tree ? ["tree", ...order] : order;
  const at = stops.indexOf(ws.treeFocused ? "tree" : ws.selected);
  const next = stops[(at + 1) % stops.length];
  if (next === "tree") ws.setTreeFocused(true);
  else ws.select(next);
  useUIStore.getState().requestFocus();
}

export type Direction = "left" | "right" | "up" | "down";

const SIDE: Record<Direction, string> = {
  left: "to the left",
  right: "to the right",
  up: "above",
  down: "below",
};

/**
 * `C-w h/j/k/l` (windmove): the window — or the tree — on that side of the one with
 * the keyboard, by where they are on screen. Of several on that side, the nearest wins,
 * then the one level with this one's middle.
 */
export function windmove(dir: Direction): void {
  const ws = useWindowStore.getState();
  const rectOf = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
  const stops: { stop: "tree" | WindowId; rect: DOMRect }[] = [];
  const tree = rectOf(".project-tree");
  if (tree && treeShown()) stops.push({ stop: "tree", rect: tree });
  for (const win of windowOrder(ws.layout)) {
    const rect = rectOf(`.window[data-window="${win}"]`);
    if (rect) stops.push({ stop: win, rect });
  }
  const here = ws.treeFocused ? "tree" : ws.selected;
  const from = stops.find((s) => s.stop === here)?.rect;
  if (!from) return;
  const horizontal = dir === "left" || dir === "right";
  const mid = horizontal ? (from.top + from.bottom) / 2 : (from.left + from.right) / 2;
  const SLACK = 2;
  const best = stops
    .filter((s) => s.stop !== here)
    .map(({ stop, rect }) => {
      const gap =
        dir === "right"
          ? rect.left - from.right
          : dir === "left"
            ? from.left - rect.right
            : dir === "down"
              ? rect.top - from.bottom
              : from.top - rect.bottom;
      const [lo, hi] = horizontal ? [rect.top, rect.bottom] : [rect.left, rect.right];
      const [flo, fhi] = horizontal ? [from.top, from.bottom] : [from.left, from.right];
      const overlaps = lo < fhi && hi > flo;
      const level = mid >= lo && mid <= hi ? 0 : Math.min(Math.abs(mid - lo), Math.abs(mid - hi));
      return { stop, gap, overlaps, level };
    })
    .filter((c) => c.gap >= -SLACK && c.overlaps)
    .sort((a, b) => a.gap - b.gap || a.level - b.level)[0];
  if (!best) {
    useUIStore.getState().showFlash(`No window ${SIDE[dir]}`);
    return;
  }
  if (best.stop === "tree") ws.setTreeFocused(true);
  else ws.select(best.stop);
  useUIStore.getState().requestFocus();
}
