import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";

import {
  isFileKey,
  useWindowStore,
  type Layout,
  type SplitPath,
  type WindowId,
} from "../state/windows";
import { focusTree } from "../lib/windows";
import { useProjectStore } from "../state/project";
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
 * The project buffer with no file open. There is no viewer to take the keyboard, so the
 * tree does whenever this window would.
 */
function NoFileOpen({ win }: { win: WindowId }) {
  const sourceLabel = useProjectStore((s) => s.sourceLabel);
  const wantsKeyboard = useWindowStore((s) => s.selected === win && !s.treeFocused);
  useEffect(() => {
    if (wantsKeyboard) focusTree();
  }, [wantsKeyboard]);
  return (
    <div className="project-viewer">
      <div className="project-viewer-empty">
        <div className="empty-title">no file open{sourceLabel ? ` — ${sourceLabel}` : ""}</div>
        <div className="empty-hint">
          Select a file in the tree, or <kbd>C-x C-f</kbd> to find one; <kbd>c</kbd> in the
          tree lists only the changed files. <kbd>C-x o</kbd> switches between the tree and
          the viewer; <kbd>q</kbd> returns to the diff.
        </div>
      </div>
    </div>
  );
}

/**
 * One Emacs window: a view onto a buffer. Focus landing anywhere in it — a click, or
 * a buffer taking the keyboard — makes it the selected one, and the tree lets go.
 */
function Window({
  id,
  className,
  style,
}: {
  id: WindowId;
  className: string;
  style: CSSProperties;
}) {
  const key = useWindowStore((s) => s.shown[id]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // A native listener: the diff and the log are portals, so their React focus events
  // bubble to `AppShell`, not here — but their DOM sits inside this window.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onFocusIn = () => useWindowStore.getState().select(id);
    root.addEventListener("focusin", onFocusIn);
    return () => root.removeEventListener("focusin", onFocusIn);
  }, [id]);

  return (
    <div ref={rootRef} className={className} style={style} data-window={id}>
      {key === "diff" || key === "log" ? (
        <BufferSlot name={key} />
      ) : key === "help" ? (
        <HelpBuffer />
      ) : key === "project" ? (
        <NoFileOpen win={id} />
      ) : key && isFileKey(key) ? (
        <FileView key={key} win={id} bufferId={key} />
      ) : null}
    </div>
  );
}

/** Where a window sits in the frame, in fractions of the windows' area. */
type Tile = { id: WindowId; x: number; y: number; w: number; h: number };
/** A split's boundary, which dragging moves: its split, and the split's own area. */
type Divider = { path: SplitPath; dir: "row" | "column"; at: number } & Omit<Tile, "id">;

function tileLayout(
  layout: Layout,
  area: Omit<Tile, "id">,
  path: SplitPath,
  tiles: Tile[],
  dividers: Divider[],
): void {
  if (layout.kind === "window") {
    tiles.push({ id: layout.id, ...area });
    return;
  }
  const { x, y, w, h } = area;
  if (layout.dir === "row") {
    const cut = w * layout.ratio;
    tileLayout(layout.first, { x, y, w: cut, h }, [...path, 0], tiles, dividers);
    tileLayout(layout.second, { x: x + cut, y, w: w - cut, h }, [...path, 1], tiles, dividers);
    dividers.push({ path, dir: "row", at: x + cut, ...area });
  } else {
    const cut = h * layout.ratio;
    tileLayout(layout.first, { x, y, w, h: cut }, [...path, 0], tiles, dividers);
    tileLayout(layout.second, { x, y: y + cut, w, h: h - cut }, [...path, 1], tiles, dividers);
    dividers.push({ path, dir: "column", at: y + cut, ...area });
  }
}

const pct = (n: number) => `${n * 100}%`;

/**
 * The windows, as the layout splits them. Each window is placed by its tile rather than
 * nested in its split, so splitting or closing one never remounts the others (nor their
 * editors). Dragging a boundary moves it; with more than one window, the selected one
 * is marked.
 */
export function WindowArea() {
  const layout = useWindowStore((s) => s.layout);
  const selected = useWindowStore((s) => s.selected);
  const setRatio = useWindowStore((s) => s.setRatio);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const { tiles, dividers } = useMemo(() => {
    const tiles: Tile[] = [];
    const dividers: Divider[] = [];
    tileLayout(layout, { x: 0, y: 0, w: 1, h: 1 }, [], tiles, dividers);
    return { tiles, dividers };
  }, [layout]);
  const split = tiles.length > 1;

  const startDrag = (divider: Divider) => (e: React.PointerEvent<HTMLDivElement>) => {
    const area = areaRef.current?.getBoundingClientRect();
    if (!area) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const ratio =
        divider.dir === "row"
          ? (ev.clientX - area.left - divider.x * area.width) / (divider.w * area.width)
          : (ev.clientY - area.top - divider.y * area.height) / (divider.h * area.height);
      setRatio(divider.path, ratio);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  return (
    <div ref={areaRef} className={`windows${split ? " is-split" : ""}`}>
      {tiles.map((t) => (
        <Window
          key={t.id}
          id={t.id}
          className={`window${split && t.id === selected ? " is-selected" : ""}${
            t.x > 0 ? " has-left" : ""
          }${t.y > 0 ? " has-top" : ""}`}
          style={{ left: pct(t.x), top: pct(t.y), width: pct(t.w), height: pct(t.h) }}
        />
      ))}
      {dividers.map((d) => (
        <div
          key={`split-${d.path.join("")}`}
          className={`window-divider is-${d.dir}`}
          role="separator"
          aria-orientation={d.dir === "row" ? "vertical" : "horizontal"}
          style={
            d.dir === "row"
              ? { left: pct(d.at), top: pct(d.y), height: pct(d.h) }
              : { top: pct(d.at), left: pct(d.x), width: pct(d.w) }
          }
          onPointerDown={startDrag(d)}
        />
      ))}
    </div>
  );
}
