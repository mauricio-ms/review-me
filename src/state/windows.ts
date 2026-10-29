import { create } from "zustand";

/** An open file's buffer id: `file:<n>`, stable for as long as the buffer lives. */
export type FileBufferId = `file:${string}`;

/**
 * Anything a window can show: one of the buffers that always exist, or an open file.
 * `project` is the project buffer with no file open (the tree, and "no file open"); an
 * open file is the project buffer showing it. The diff, the log, help and `project` each
 * show in one window at most; a file can show in several, each with its own cursor.
 */
export type BufferKey = "diff" | "log" | "help" | "project" | FileBufferId;

/** What has the keyboard, by kind — what buffer-scoped commands and keymaps key on. */
export type BufferName = "diff" | "log" | "project" | "help";

export function isFileKey(key: BufferKey): key is FileBufferId {
  return key.startsWith("file:");
}

/** The buffers that exist once: never in two windows at a time. */
export function isSingleton(key: BufferKey): boolean {
  return !isFileKey(key);
}

/** The project buffer: a file, or `project` with none open. */
export function isProjectKey(key: BufferKey | undefined): boolean {
  return key === "project" || (key != null && isFileKey(key));
}

export type WindowId = number;

/**
 * How the frame is divided, as Emacs splits it: a window, or a split into two parts
 * side by side (`row`, `C-x 3`) or stacked (`column`, `C-x 2`), the first taking
 * `ratio` of the space.
 */
export type Layout =
  | { kind: "window"; id: WindowId }
  | { kind: "split"; dir: "row" | "column"; ratio: number; first: Layout; second: Layout };

/** Where a split sits in the layout: first (0) / second (1) at each level from the root. */
export type SplitPath = number[];

/** The windows, left to right and top to bottom — `C-x o`'s order. */
export function windowOrder(layout: Layout): WindowId[] {
  return layout.kind === "window"
    ? [layout.id]
    : [...windowOrder(layout.first), ...windowOrder(layout.second)];
}

/** `layout` without window `win`: its sibling takes the split's place. */
function withoutWindow(layout: Layout, win: WindowId): Layout {
  if (layout.kind === "window") return layout;
  if (layout.first.kind === "window" && layout.first.id === win) return layout.second;
  if (layout.second.kind === "window" && layout.second.id === win) return layout.first;
  return {
    ...layout,
    first: withoutWindow(layout.first, win),
    second: withoutWindow(layout.second, win),
  };
}

/**
 * The window that takes `win`'s space when it closes: the nearest window of its sibling
 * (the last of a sibling before it, the first of one after it).
 */
function heir(layout: Layout, win: WindowId): WindowId | null {
  if (layout.kind === "window") return null;
  if (layout.first.kind === "window" && layout.first.id === win) {
    return windowOrder(layout.second)[0];
  }
  if (layout.second.kind === "window" && layout.second.id === win) {
    const before = windowOrder(layout.first);
    return before[before.length - 1];
  }
  return heir(layout.first, win) ?? heir(layout.second, win);
}

/** `layout` with window `win` split in two: `win` first, `added` second. */
function withSplit(
  layout: Layout,
  win: WindowId,
  dir: "row" | "column",
  added: WindowId,
): Layout {
  if (layout.kind === "window") {
    return layout.id === win
      ? { kind: "split", dir, ratio: 0.5, first: layout, second: { kind: "window", id: added } }
      : layout;
  }
  return {
    ...layout,
    first: withSplit(layout.first, win, dir, added),
    second: withSplit(layout.second, win, dir, added),
  };
}

function withRatio(layout: Layout, path: SplitPath, ratio: number): Layout {
  if (layout.kind === "window") return layout;
  if (path.length === 0) return { ...layout, ratio };
  const [step, ...rest] = path;
  return step === 0
    ? { ...layout, first: withRatio(layout.first, rest, ratio) }
    : { ...layout, second: withRatio(layout.second, rest, ratio) };
}

/** How many buffers a window remembers having shown (where `q` goes back to). */
const PREV_DEPTH = 20;

const FIRST_WINDOW: WindowId = 1;

/** The windows a frame had: how it was split, what each showed and had shown, which had the selection. */
export type Stash = {
  layout: Layout;
  shown: Record<WindowId, BufferKey>;
  prev: Record<WindowId, BufferKey[]>;
  ahead: Record<WindowId, BufferKey[]>;
  selected: WindowId;
};

type WindowState = {
  layout: Layout;
  /** What each window shows. */
  shown: Record<WindowId, BufferKey>;
  /** What each window showed before, most recent first: where `C-x ←` and `q` go. */
  prev: Record<WindowId, BufferKey[]>;
  /** What `C-x ←` stepped back from, most recent first: where `C-x →` goes. */
  ahead: Record<WindowId, BufferKey[]>;
  /** The window commands act on — and where the tree opens files. */
  selected: WindowId;
  /** The file tree has the keyboard rather than the selected window (project mode only). */
  treeFocused: boolean;
  /** Which half of the project buffer had the keyboard when it was left, for coming back. */
  projectPane: "tree" | "viewer";
  /** Every buffer shown so far, most recent first: `C-x b`'s order. */
  recent: BufferKey[];
  nextId: WindowId;
  /**
   * Project mode's windows while the diff has the frame to itself (`takeFrame`), put
   * back on the way back (`unstash`). Only ever set outside project mode.
   */
  stash: Stash | null;

  /** Show `key` in window `win` (it goes on remembering what was there). */
  show: (win: WindowId, key: BufferKey) => void;
  /**
   * `C-x ←` / `C-x →` (Emacs's previous-buffer / next-buffer): show `key`, taken from
   * the window's history behind (`back`) or ahead, and move what was shown to the other
   * side — so stepping one way and then the other comes back.
   */
  step: (win: WindowId, key: BufferKey, dir: "back" | "ahead") => void;
  /** Go back to `key` in window `win`, forgetting the buffer it is leaving there. */
  quitTo: (win: WindowId, key: BufferKey) => void;
  /** Give window `win` the selection (and the keyboard, from the tree). */
  select: (win: WindowId) => void;
  setTreeFocused: (focused: boolean) => void;
  setProjectPane: (pane: "tree" | "viewer") => void;
  /** Split window `win`; the new window — returned — shows `key`. */
  split: (win: WindowId, dir: "row" | "column", key: BufferKey) => WindowId;
  /** Close window `win` (never the last one); its space goes to its sibling. */
  remove: (win: WindowId) => void;
  /** Close every window but `win`. */
  keepOnly: (win: WindowId) => void;
  /**
   * Window `win` alone in the frame, switching to `key` (as `show`, or as `step` with
   * a `dir`); the windows it covers are stashed to come back.
   */
  takeFrame: (win: WindowId, key: BufferKey, dir?: "back" | "ahead") => void;
  /**
   * Bring the stashed windows back, window `win` — the one left on screen, which keeps
   * the history it made meanwhile — switching to `key`. False, with nothing changed,
   * when there is no stash `win` belongs to.
   */
  unstash: (win: WindowId, key: BufferKey, dir?: "back" | "ahead") => boolean;
  setRatio: (path: SplitPath, ratio: number) => void;
  /** Forget killed buffers: a window showing one goes back to what it showed before. */
  forget: (keys: BufferKey[]) => void;
  reset: () => void;
};

const initial = () => ({
  layout: { kind: "window", id: FIRST_WINDOW } as Layout,
  shown: { [FIRST_WINDOW]: "diff" } as Record<WindowId, BufferKey>,
  prev: { [FIRST_WINDOW]: [] } as Record<WindowId, BufferKey[]>,
  ahead: { [FIRST_WINDOW]: [] } as Record<WindowId, BufferKey[]>,
  selected: FIRST_WINDOW,
  treeFocused: false,
  projectPane: "tree" as "tree" | "viewer",
  recent: ["diff"] as BufferKey[],
  nextId: FIRST_WINDOW + 1,
  stash: null as Stash | null,
});

/** `old` in front of a window's history list, without `old` or `key` further down. */
const pushFront = (list: BufferKey[] | undefined, old: BufferKey, key: BufferKey) =>
  [old, ...(list ?? []).filter((k) => k !== old && k !== key)].slice(0, PREV_DEPTH);

const touch = (recent: BufferKey[], key: BufferKey) =>
  recent[0] === key ? recent : [key, ...recent.filter((k) => k !== key)];

type History = Pick<WindowState, "shown" | "prev" | "ahead" | "recent">;

/**
 * Window `win` switching to `key`: a new switch remembers what it leaves and, as a new
 * move in a browser does, drops the way forward; a step (`C-x ←` / `C-x →`) takes `key`
 * from one side of the window's history and puts what it leaves on the other.
 */
function switched(
  s: History,
  win: WindowId,
  key: BufferKey,
  dir?: "back" | "ahead",
): Partial<History> {
  const old = s.shown[win];
  const recent = touch(s.recent, key);
  if (old === key) return recent === s.recent ? {} : { recent };
  if (!dir) {
    return {
      shown: { ...s.shown, [win]: key },
      prev: { ...s.prev, [win]: pushFront(s.prev[win], old, key) },
      ahead: { ...s.ahead, [win]: [] },
      recent,
    };
  }
  const [from, to] = dir === "back" ? [s.prev, s.ahead] : [s.ahead, s.prev];
  const taken = (from[win] ?? []).filter((k) => k !== key && k !== old);
  const given = pushFront(to[win], old, key);
  return {
    shown: { ...s.shown, [win]: key },
    prev: { ...s.prev, [win]: dir === "back" ? taken : given },
    ahead: { ...s.ahead, [win]: dir === "back" ? given : taken },
    recent,
  };
}

/** Drop `wins` from the window maps. */
function dropWindows<T>(map: Record<WindowId, T>, wins: WindowId[]): Record<WindowId, T> {
  const next = { ...map };
  for (const win of wins) delete next[win];
  return next;
}

export const useWindowStore = create<WindowState>((set, get) => ({
  ...initial(),

  show: (win, key) => set((s) => switched(s, win, key)),

  step: (win, key, dir) => set((s) => switched(s, win, key, dir)),

  quitTo: (win, key) =>
    set((s) => {
      const old = s.shown[win];
      return {
        shown: { ...s.shown, [win]: key },
        prev: { ...s.prev, [win]: (s.prev[win] ?? []).filter((k) => k !== key && k !== old) },
        ahead: { ...s.ahead, [win]: [] },
        recent: touch(s.recent, key),
      };
    }),

  select: (win) =>
    set((s) =>
      s.selected === win && !s.treeFocused ? {} : { selected: win, treeFocused: false },
    ),

  setTreeFocused: (focused) =>
    set((s) => (s.treeFocused === focused ? {} : { treeFocused: focused })),

  setProjectPane: (pane) => set((s) => (s.projectPane === pane ? {} : { projectPane: pane })),

  split: (win, dir, key) => {
    const added = get().nextId;
    set((s) => ({
      layout: withSplit(s.layout, win, dir, added),
      shown: { ...s.shown, [added]: key },
      prev: { ...s.prev, [added]: [] },
      ahead: { ...s.ahead, [added]: [] },
      recent: touch(s.recent, key),
      nextId: added + 1,
    }));
    return added;
  },

  remove: (win) =>
    set((s) => {
      if (windowOrder(s.layout).length <= 1) return {};
      const layout = withoutWindow(s.layout, win);
      const order = windowOrder(layout);
      return {
        layout,
        shown: dropWindows(s.shown, [win]),
        prev: dropWindows(s.prev, [win]),
        ahead: dropWindows(s.ahead, [win]),
        // The selection moves to the window that took the space.
        selected: s.selected === win ? (heir(s.layout, win) ?? order[0]) : s.selected,
      };
    }),

  keepOnly: (win) =>
    set((s) => {
      const others = windowOrder(s.layout).filter((w) => w !== win);
      if (others.length === 0) return {};
      return {
        layout: { kind: "window", id: win },
        shown: dropWindows(s.shown, others),
        prev: dropWindows(s.prev, others),
        ahead: dropWindows(s.ahead, others),
        selected: win,
      };
    }),

  takeFrame: (win, key, dir) =>
    set((s) => {
      const others = windowOrder(s.layout).filter((w) => w !== win);
      const alone = {
        layout: { kind: "window", id: win } as Layout,
        shown: dropWindows(s.shown, others),
        prev: dropWindows(s.prev, others),
        ahead: dropWindows(s.ahead, others),
        selected: win,
        treeFocused: false,
      };
      const { layout, shown, prev, ahead, selected } = s;
      return {
        ...alone,
        ...switched({ ...s, ...alone }, win, key, dir),
        stash: { layout, shown, prev, ahead, selected },
      };
    }),

  unstash: (win, key, dir) => {
    const s = get();
    const stash = s.stash;
    if (!stash || !windowOrder(stash.layout).includes(win)) return false;
    const back = {
      layout: stash.layout,
      shown: { ...stash.shown, [win]: s.shown[win] },
      prev: { ...stash.prev, [win]: s.prev[win] ?? [] },
      ahead: { ...stash.ahead, [win]: s.ahead[win] ?? [] },
      selected: stash.selected,
    };
    set({ ...back, ...switched({ ...s, ...back }, win, key, dir), stash: null });
    return true;
  },

  setRatio: (path, ratio) =>
    set((s) => ({ layout: withRatio(s.layout, path, Math.min(0.9, Math.max(0.1, ratio))) })),

  forget: (keys) => {
    const gone = new Set<BufferKey>(keys);
    const s = get();
    const shown = { ...s.shown };
    const kept = (lists: Record<WindowId, BufferKey[]>) => {
      const out: Record<WindowId, BufferKey[]> = {};
      for (const [id, list] of Object.entries(lists)) {
        out[Number(id)] = list.filter((k) => !gone.has(k));
      }
      return out;
    };
    const prev = kept(s.prev);
    const orphans: WindowId[] = [];
    const main = windowOrder(s.layout)[0];
    for (const win of windowOrder(s.layout)) {
      if (!gone.has(shown[win])) continue;
      const visible = new Set(Object.values(shown));
      // The main window stays in the project buffer: another open file it showed, else
      // "no file open". Another window goes back to what it showed before — never a
      // single-cursor buffer a window already shows — and with nothing left, closes.
      const next =
        win === main
          ? (prev[win].find((k) => isFileKey(k)) ?? "project")
          : prev[win].find((k) => isFileKey(k) || !visible.has(k));
      if (!next) {
        orphans.push(win);
        continue;
      }
      shown[win] = next;
      prev[win] = prev[win].filter((k) => k !== next);
    }
    set({ shown, prev, ahead: kept(s.ahead), recent: s.recent.filter((k) => !gone.has(k)) });
    for (const win of orphans) get().remove(win);
  },

  reset: () => set(initial()),
}));

// A stash is for coming back to project mode from the diff. Back in it any other way —
// the window beside the diff closed, say — what was stashed is no longer the way back.
useWindowStore.subscribe((s) => {
  if (s.stash && inProjectMode(s)) useWindowStore.setState({ stash: null });
});

/** The buffer in the selected window. */
export function selectedBuffer(s: WindowState): BufferKey {
  return s.shown[s.selected] ?? "diff";
}

/** Which kind of buffer has the keyboard: a file, the tree, or no file open is the project. */
export function activeBuffer(s: WindowState): BufferName {
  if (s.treeFocused) return "project";
  const key = selectedBuffer(s);
  return isProjectKey(key) ? "project" : (key as BufferName);
}

/** The main window: the first in the layout (left, top). */
export function mainWindow(s: WindowState): WindowId {
  return windowOrder(s.layout)[0];
}

/**
 * Project mode, the file tree's: the main window shows the project buffer — a file, or
 * no file open. The diff, the log and help are not — nor the diff with a file opened
 * beside it (`o`), which is still the diff's.
 */
export function inProjectMode(s: WindowState): boolean {
  return isProjectKey(s.shown[mainWindow(s)]);
}

/** Whether any window shows `key`. */
export function isShown(s: WindowState, key: BufferKey): boolean {
  return Object.values(s.shown).includes(key);
}

/** Whether `key` is in the selected window and that window has the keyboard. */
export function hasKeyboard(s: WindowState, key: BufferKey): boolean {
  return !s.treeFocused && selectedBuffer(s) === key;
}

/** A window other than `except` that shows `key`, if there is one. */
export function windowShowing(
  s: WindowState,
  key: BufferKey,
  except?: WindowId,
): WindowId | null {
  return windowOrder(s.layout).find((w) => w !== except && s.shown[w] === key) ?? null;
}
