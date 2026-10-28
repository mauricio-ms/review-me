import { useUIStore } from "../state/ui";
import { armRepeat } from "./key-dispatch";

/**
 * The base text size (`--fs` in styles.css; the UI and small sizes derive from it),
 * scaled with `C-x C-=` / `C-x C--` / `C-x C-0` like Emacs's text-scale-adjust, and
 * remembered on this machine.
 */

const STORAGE_KEY = "review-me.text-size";
const DEFAULT_PX = 16;
const MIN_PX = 10;
const MAX_PX = 32;

let current = DEFAULT_PX;

function apply(px: number): void {
  current = Math.min(MAX_PX, Math.max(MIN_PX, Math.round(px)));
  document.documentElement.style.setProperty("--fs", `${current}px`);
}

/** Restore the remembered size; call once before the first render. */
export function initTextScale(): void {
  let saved: number | null = null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    saved = raw ? Number.parseInt(raw, 10) : null;
  } catch {
    // No storage (private mode, blocked): the default it is.
  }
  apply(saved && Number.isFinite(saved) ? saved : DEFAULT_PX);
}

function remember(): void {
  try {
    if (current === DEFAULT_PX) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(current));
  } catch {
    // Best effort: the size still applies for this session.
  }
}

/**
 * One step bigger (`+1`), smaller (`-1`), or back to the default (`0`). Afterwards `=`,
 * `+`, `-` and `0` alone keep adjusting until another key, as in Emacs.
 */
export function adjustTextScale(step: 1 | -1 | 0): void {
  apply(step === 0 ? DEFAULT_PX : current + step);
  remember();
  useUIStore
    .getState()
    .showFlash(`Text size ${current}px — use =, -, 0 for further adjustment`);
  armRepeat({
    "=": () => adjustTextScale(1),
    "+": () => adjustTextScale(1),
    "-": () => adjustTextScale(-1),
    "0": () => adjustTextScale(0),
  });
}
