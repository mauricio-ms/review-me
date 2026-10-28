import { create } from "zustand";

/** An open file's buffer id: `file:<n>`, stable for as long as the buffer lives. */
export type FileBufferId = `file:${string}`;

/**
 * Anything a window can show: one of the buffers that always exist, or an open file.
 * The diff, the log and help each keep a single cursor, so each shows in one window
 * at most; a file can show in several, each with its own cursor.
 */
export type BufferKey = "diff" | "log" | "help" | FileBufferId;

/** What has the keyboard, by kind — what buffer-scoped commands and keymaps key on. */
export type BufferName = "diff" | "log" | "project" | "help";

export function isFileKey(key: BufferKey): key is FileBufferId {
  return key.startsWith("file:");
}

/** The buffers that exist once: never in two windows at a time. */
export function isSingleton(key: BufferKey): boolean {
  return !isFileKey(key);
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

type WindowState = {
  layout: Layout;
  /** What each window shows. */
  shown: Record<WindowId, BufferKey>;
  /** What each window showed before, most recent first. */
  prev: Record<WindowId, BufferKey[]>;
  /** The window commands act on — and where the tree opens files. */
  selected: WindowId;
  /** The file tree has the keyboard rather than the selected window. */
  treeFocused: boolean;
  /** Every buffer shown so far, most recent first: `C-x b`'s order. */
  recent: BufferKey[];
  nextId: WindowId;

  /** Show `key` in window `win` (it goes on remembering what was there). */
  show: (win: WindowId, key: BufferKey) => void;
  /** Go back to `key` in window `win`, forgetting the buffer it is leaving there. */
  quitTo: (win: WindowId, key: BufferKey) => void;
  /** Give window `win` the selection (and the keyboard, from the tree). */
  select: (win: WindowId) => void;
  setTreeFocused: (focused: boolean) => void;
  /** Split window `win`; the new window — returned — shows `key`. */
  split: (win: WindowId, dir: "row" | "column", key: BufferKey) => WindowId;
  /** Close window `win` (never the last one); its space goes to its sibling. */
  remove: (win: WindowId) => void;
  /** Close every window but `win`. */
  keepOnly: (win: WindowId) => void;
  setRatio: (path: SplitPath, ratio: number) => void;
  /** Forget killed buffers: a window showing one goes back to what it showed before. */
  forget: (keys: BufferKey[]) => void;
  reset: () => void;
};

const initial = () => ({
  layout: { kind: "window", id: FIRST_WINDOW } as Layout,
  shown: { [FIRST_WINDOW]: "diff" } as Record<WindowId, BufferKey>,
  prev: { [FIRST_WINDOW]: [] } as Record<WindowId, BufferKey[]>,
  selected: FIRST_WINDOW,
  treeFocused: false,
  recent: ["diff"] as BufferKey[],
  nextId: FIRST_WINDOW + 1,
});

const touch = (recent: BufferKey[], key: BufferKey) =>
  recent[0] === key ? recent : [key, ...recent.filter((k) => k !== key)];

/** Drop `wins` from the window maps. */
function dropWindows<T>(map: Record<WindowId, T>, wins: WindowId[]): Record<WindowId, T> {
  const next = { ...map };
  for (const win of wins) delete next[win];
  return next;
}

export const useWindowStore = create<WindowState>((set, get) => ({
  ...initial(),

  show: (win, key) =>
    set((s) => {
      const old = s.shown[win];
      const recent = touch(s.recent, key);
      if (old === key) return recent === s.recent ? {} : { recent };
      return {
        shown: { ...s.shown, [win]: key },
        prev: {
          ...s.prev,
          [win]: [old, ...(s.prev[win] ?? []).filter((k) => k !== old && k !== key)].slice(
            0,
            PREV_DEPTH,
          ),
        },
        recent,
      };
    }),

  quitTo: (win, key) =>
    set((s) => {
      const old = s.shown[win];
      return {
        shown: { ...s.shown, [win]: key },
        prev: { ...s.prev, [win]: (s.prev[win] ?? []).filter((k) => k !== key && k !== old) },
        recent: touch(s.recent, key),
      };
    }),

  select: (win) =>
    set((s) =>
      s.selected === win && !s.treeFocused ? {} : { selected: win, treeFocused: false },
    ),

  setTreeFocused: (focused) =>
    set((s) => (s.treeFocused === focused ? {} : { treeFocused: focused })),

  split: (win, dir, key) => {
    const added = get().nextId;
    set((s) => ({
      layout: withSplit(s.layout, win, dir, added),
      shown: { ...s.shown, [added]: key },
      prev: { ...s.prev, [added]: [] },
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
        selected: win,
      };
    }),

  setRatio: (path, ratio) =>
    set((s) => ({ layout: withRatio(s.layout, path, Math.min(0.9, Math.max(0.1, ratio))) })),

  forget: (keys) => {
    const gone = new Set<BufferKey>(keys);
    const s = get();
    const shown = { ...s.shown };
    const prev: Record<WindowId, BufferKey[]> = {};
    for (const [id, list] of Object.entries(s.prev)) {
      prev[Number(id)] = list.filter((k) => !gone.has(k));
    }
    const orphans: WindowId[] = [];
    for (const win of windowOrder(s.layout)) {
      if (!gone.has(shown[win])) continue;
      const visible = new Set(Object.values(shown));
      // Back to what it showed before — never a single-cursor buffer that another
      // window already shows. A window with nothing left to show closes.
      const next =
        prev[win].find((k) => isFileKey(k) || !visible.has(k)) ??
        (["diff", "log", "help"] as const).find((k) => !visible.has(k));
      if (!next) {
        orphans.push(win);
        continue;
      }
      shown[win] = next;
      prev[win] = prev[win].filter((k) => k !== next);
    }
    set({ shown, prev, recent: s.recent.filter((k) => !gone.has(k)) });
    for (const win of orphans) get().remove(win);
  },

  reset: () => set(initial()),
}));

/** The buffer in the selected window. */
export function selectedBuffer(s: WindowState): BufferKey {
  return s.shown[s.selected] ?? "diff";
}

/** Which kind of buffer has the keyboard (the tree counts as the project). */
export function activeBuffer(s: WindowState): BufferName {
  if (s.treeFocused) return "project";
  const key = selectedBuffer(s);
  return isFileKey(key) ? "project" : key;
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
