import { useEffect, useLayoutEffect, useRef } from "react";

import { isFileKey, useWindowStore, type WindowId } from "../state/windows";
import FileView from "./FileView";
import HelpBuffer from "./HelpBuffer";

/**
 * The diff and the log are rendered once (portals into these elements, from
 * `AppShell`) and each moved into whichever window shows it: their cursor, folds and
 * scroll live in the component, which must never remount just because it moved. While
 * no window shows one, its element is detached — mounted, but laid out at zero size.
 */
const hosts = new Map<"diff" | "log", HTMLDivElement>();

export function bufferHost(name: "diff" | "log"): HTMLDivElement {
  let host = hosts.get(name);
  if (!host) {
    host = document.createElement("div");
    host.className = "buffer-host";
    hosts.set(name, host);
  }
  return host;
}

/**
 * What detaching a host forgets: the scroll offsets inside it, and the focus if it was
 * there — a move between windows (or StrictMode re-running the effect) is a detach and
 * a re-attach, and neither may cost the reader their place or the keyboard.
 */
const detached = new WeakMap<
  HTMLElement,
  { scrolls: [Element, number][]; focused: HTMLElement | null }
>();

/** Where a window holds a persistent buffer's element while it shows it. */
function BufferSlot({ name }: { name: "diff" | "log" }) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const host = bufferHost(name);
    if (!slot) return;
    slot.appendChild(host);
    const saved = detached.get(host);
    if (saved) {
      for (const [el, top] of saved.scrolls) el.scrollTop = top;
      saved.focused?.focus({ preventScroll: true });
      detached.delete(host);
    }
    return () => {
      if (host.parentNode !== slot) return;
      const scrolls: [Element, number][] = [];
      host.querySelectorAll("*").forEach((el) => {
        if (el.scrollTop > 0) scrolls.push([el, el.scrollTop]);
      });
      const active = document.activeElement;
      const focused = active instanceof HTMLElement && host.contains(active) ? active : null;
      detached.set(host, { scrolls, focused });
      slot.removeChild(host);
    };
  }, [name]);
  return <div ref={slotRef} className="buffer-slot" />;
}

/**
 * One Emacs window: a view onto a buffer. Focus landing anywhere in it — a click, or
 * a buffer taking the keyboard — makes it the selected one, and the tree lets go.
 */
export default function Window({ id }: { id: WindowId }) {
  const key = useWindowStore((s) => s.shown[id]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // A native listener: the diff and the log are portals, so their React focus events
  // bubble to `AppShell`, not here — but their DOM sits inside this window.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onFocusIn = () => {
      const ws = useWindowStore.getState();
      if (ws.treeFocused) ws.setTreeFocused(false);
    };
    root.addEventListener("focusin", onFocusIn);
    return () => root.removeEventListener("focusin", onFocusIn);
  }, []);

  return (
    <div ref={rootRef} className="window" data-window={id}>
      {key === "diff" || key === "log" ? (
        <BufferSlot name={key} />
      ) : key === "help" ? (
        <HelpBuffer />
      ) : key && isFileKey(key) ? (
        <FileView key={key} win={id} bufferId={key} />
      ) : null}
    </div>
  );
}
