import { create } from "zustand";

/** An open file's buffer id: `file:<n>`, stable for as long as the buffer lives. */
export type FileBufferId = `file:${string}`;

/**
 * Anything a window can show: one of the buffers that always exist, or an open file.
 * The diff and the log each keep a single cursor, so each shows in one window at most.
 */
export type BufferKey = "diff" | "log" | "help" | FileBufferId;

/** What has the keyboard, by kind — what buffer-scoped commands and keymaps key on. */
export type BufferName = "diff" | "log" | "project" | "help";

export function isFileKey(key: BufferKey): key is FileBufferId {
  return key.startsWith("file:");
}

export type WindowId = number;

/** How the frame is divided into windows, as Emacs splits them. */
export type Layout = { kind: "window"; id: WindowId };

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

  /** Show `key` in window `win` (it goes on remembering what was there). */
  show: (win: WindowId, key: BufferKey) => void;
  /** Go back to `key` in window `win`, forgetting the buffer it is leaving there. */
  quitTo: (win: WindowId, key: BufferKey) => void;
  setTreeFocused: (focused: boolean) => void;
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
});

export const useWindowStore = create<WindowState>((set) => ({
  ...initial(),

  show: (win, key) =>
    set((s) => {
      const old = s.shown[win];
      const recent = s.recent[0] === key ? s.recent : [key, ...s.recent.filter((k) => k !== key)];
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
        recent: [key, ...s.recent.filter((k) => k !== key)],
      };
    }),

  setTreeFocused: (focused) => set((s) => (s.treeFocused === focused ? {} : { treeFocused: focused })),

  forget: (keys) =>
    set((s) => {
      const gone = new Set<BufferKey>(keys);
      const shown = { ...s.shown };
      const prev: Record<WindowId, BufferKey[]> = {};
      for (const [id, list] of Object.entries(s.prev)) {
        prev[Number(id)] = list.filter((k) => !gone.has(k));
      }
      for (const [id, key] of Object.entries(s.shown)) {
        const win = Number(id);
        if (!gone.has(key)) continue;
        const visible = new Set(Object.values(shown));
        // Back to what it showed before — never a single-cursor buffer that another
        // window already shows.
        const next =
          prev[win].find((k) => isFileKey(k) || !visible.has(k)) ??
          (["diff", "log", "help"] as const).find((k) => !visible.has(k)) ??
          "diff";
        shown[win] = next;
        prev[win] = prev[win].filter((k) => k !== next);
      }
      return { shown, prev, recent: s.recent.filter((k) => !gone.has(k)) };
    }),

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
