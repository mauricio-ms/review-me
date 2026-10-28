import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import { isFileKey, selectedBuffer, useWindowStore } from "../state/windows";
import type { KeyBinding, KeyScope } from "./keymap";

/**
 * Key events → Emacs-notation chords → the bindings in `keymap.ts`. Every dispatcher
 * (the window-level global one, each buffer's, the minibuffer's, the editors') feeds
 * the same pending sequence, so a half-typed `C-x` in one never combines with a `g`
 * left over in another.
 */

const NAMED: Record<string, string> = {
  Enter: "RET",
  Tab: "TAB",
  Escape: "ESC",
  Backspace: "DEL",
  Delete: "<delete>",
  " ": "SPC",
  ArrowUp: "<up>",
  ArrowDown: "<down>",
  ArrowLeft: "<left>",
  ArrowRight: "<right>",
  PageUp: "<prior>",
  PageDown: "<next>",
  Home: "<home>",
  End: "<end>",
};

const NOT_A_CHORD = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "Super",
  "Hyper",
  "OS",
  "CapsLock",
  "Dead",
  "Unidentified",
  "Process",
]);

/** The chord `e` types, e.g. `C-x`, `M-.`, `RET`, `G`; null for a lone modifier. */
export function chordOf(e: KeyboardEvent): string | null {
  // Super chords belong to the desktop.
  if (e.metaKey || NOT_A_CHORD.has(e.key)) return null;
  let base = NAMED[e.key];
  if (base) {
    if (e.shiftKey) base = `S-${base}`;
  } else if (e.key.length === 1) {
    // With a modifier held, Caps Lock shouldn't turn `C-x` into `C-X`.
    base =
      (e.ctrlKey || e.altKey) && /^[a-z]$/i.test(e.key)
        ? e.shiftKey
          ? e.key.toUpperCase()
          : e.key.toLowerCase()
        : e.key;
  } else if (/^F\d+$/.test(e.key)) {
    base = `<${e.key.toLowerCase()}>`;
  } else {
    return null;
  }
  return `${e.ctrlKey ? "C-" : ""}${e.altKey ? "M-" : ""}${base}`;
}

/** How long a half-typed sequence waits before the echo area shows it (`C-x-`). */
const ECHO_DELAY_MS = 600;

let pending: { owner: string; keys: string } | null = null;
let echoTimer: ReturnType<typeof setTimeout> | null = null;

function setPending(next: { owner: string; keys: string } | null): void {
  pending = next;
  if (echoTimer) clearTimeout(echoTimer);
  echoTimer = null;
  const ui = useUIStore.getState();
  if (!next) {
    if (ui.keyEcho !== null && !describing) ui.setKeyEcho(null);
    return;
  }
  echoTimer = setTimeout(() => {
    echoTimer = null;
    if (pending === next) useUIStore.getState().setKeyEcho(`${next.keys}-`);
  }, ECHO_DELAY_MS);
}

export type Fed =
  | { kind: "match"; binding: KeyBinding; keys: string }
  | { kind: "pending"; keys: string }
  | { kind: "undefined"; keys: string }
  | { kind: "quit" }
  | { kind: "none" };

/**
 * Add `chord` to `owner`'s pending sequence and look it up in `bindings`. `none`
 * means the key is not this dispatcher's business and should go on its way; a
 * sequence that started here and went nowhere is `undefined` (and consumed).
 */
export function feedKey(owner: string, chord: string, bindings: readonly KeyBinding[]): Fed {
  // C-g abandons any half-typed sequence, whoever started it.
  if (chord === "C-g" && pending) {
    setPending(null);
    return { kind: "quit" };
  }
  const prior = pending?.owner === owner ? pending.keys : null;
  const keys = prior ? `${prior} ${chord}` : chord;
  let prefix = false;
  for (const binding of bindings) {
    if (binding.external) continue;
    for (const k of binding.keys) {
      if (k === keys) {
        setPending(null);
        return { kind: "match", binding, keys };
      }
      if (k.startsWith(`${keys} `)) prefix = true;
    }
  }
  if (prefix) {
    setPending({ owner, keys });
    return { kind: "pending", keys };
  }
  if (prior) {
    setPending(null);
    return { kind: "undefined", keys };
  }
  return { kind: "none" };
}

/** A binding's handler; `false` means "not now" and lets the key go on its way. */
export type KeyHandler = (keys: string) => void | boolean;

type AnyKeyboardEvent = KeyboardEvent | ReactKeyboardEvent;

function nativeOf(e: AnyKeyboardEvent): KeyboardEvent {
  return "nativeEvent" in e ? e.nativeEvent : e;
}

function consume(e: AnyKeyboardEvent): void {
  e.preventDefault();
  e.stopPropagation();
}

/**
 * Run `e` through `bindings` and the matching handler. Returns whether the key was
 * consumed; an unconsumed key is left for the next listener (or the browser).
 */
export function dispatchKey<A extends string>(
  owner: KeyScope,
  e: AnyKeyboardEvent,
  bindings: readonly KeyBinding[],
  handlers: Record<A, KeyHandler>,
): boolean {
  const chord = chordOf(nativeOf(e));
  if (!chord) return false;
  return settle(e, feedKey(owner, chord, bindings), (binding, keys) => {
    const handler = binding.action ? handlers[binding.action as A] : undefined;
    return handler ? handler(keys) !== false : false;
  });
}

/** Act on a fed key: consume what this dispatcher owns, run a match through `run`. */
export function settle(
  e: AnyKeyboardEvent,
  fed: Fed,
  run: (binding: KeyBinding, keys: string) => boolean,
): boolean {
  switch (fed.kind) {
    case "none":
      return false;
    case "pending":
      consume(e);
      return true;
    case "quit":
      consume(e);
      useUIStore.getState().showFlash("Quit");
      return true;
    case "undefined":
      consume(e);
      useUIStore.getState().showFlash(`${fed.keys} is undefined`);
      return true;
    case "match":
      if (!run(fed.binding, fed.keys)) return false;
      consume(e);
      return true;
  }
}

/** Which buffer-level keymap applies right now, for `C-h m`, `C-h k`, and M-x. */
export function contextScope(): KeyScope {
  const ws = useWindowStore.getState();
  const key = selectedBuffer(ws);
  if (key === "help" && !ws.treeFocused) return "help";
  if (!useRepoStore.getState().repo) return "start";
  if (ws.treeFocused) return "tree";
  return isFileKey(key) ? "viewer" : key;
}

// ---------- repeat maps ----------

let repeat: Record<string, () => void> | null = null;

/**
 * After a command like `C-x C-=`, let single keys repeat it (Emacs's repeat maps):
 * `map`'s chords keep running until any other key, which then goes on as usual.
 */
export function armRepeat(map: Record<string, () => void>): void {
  repeat = map;
}

/** Feed a key to the armed repeat map; true when it ran (and consumed) the key. */
export function feedRepeat(e: KeyboardEvent): boolean {
  if (!repeat) return false;
  const chord = chordOf(e);
  if (!chord) return false;
  const run = repeat[chord];
  if (!run) {
    repeat = null;
    return false;
  }
  consume(e);
  run();
  return true;
}

// ---------- C-h k ----------

let describing = false;

/** `C-h k`: the next key sequence is described in the echo area instead of run. */
export function startDescribeKey(): void {
  describing = true;
  setPending(null);
  useUIStore.getState().setKeyEcho("Describe key: ");
}

export function isDescribingKey(): boolean {
  return describing;
}

/**
 * Feed a key to `C-h k`. Always consumes it; finishes once a sequence completes (or
 * can't), leaving the answer in the echo area. `name` turns a command id into the
 * name M-x knows it by.
 */
export function describeNextKey(
  e: KeyboardEvent,
  scope: KeyScope,
  bindings: readonly KeyBinding[],
  name: (binding: KeyBinding) => string | null,
): void {
  const chord = chordOf(e);
  if (!chord) return;
  consume(e);
  const fed = feedKey("describe", chord, bindings);
  if (fed.kind === "pending") {
    useUIStore.getState().setKeyEcho(`Describe key: ${fed.keys}-`);
    return;
  }
  describing = false;
  const ui = useUIStore.getState();
  ui.setKeyEcho(null);
  switch (fed.kind) {
    case "quit":
      ui.showFlash("Quit");
      return;
    case "match": {
      const command = name(fed.binding);
      ui.showFlash(
        command
          ? `${fed.keys} runs ${command}: ${fed.binding.doc}`
          : `${fed.keys}: ${fed.binding.doc}`,
      );
      return;
    }
    default: {
      const keys = fed.kind === "undefined" ? fed.keys : chord;
      // Plain keys in the viewer are vim's: motions, search, counts.
      ui.showFlash(
        scope === "viewer" && !/^[CM]-/.test(keys)
          ? `${keys} is vim's (the viewer is vim in normal mode)`
          : `${keys} is undefined`,
      );
    }
  }
}
