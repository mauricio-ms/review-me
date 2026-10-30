import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { dispatchKey, type KeyHandler } from "../lib/key-dispatch";
import { KEYMAP, type MinibufferAction } from "../lib/keymap";
import {
  compileSwiper,
  nearestHit,
  quoteSwiper,
  swipe,
  type Span,
  type SwiperHit,
} from "../lib/swiper";
import { useMinibufferStore, type SwiperRequest } from "../state/minibuffer";
import { useUIStore } from "../state/ui";
import { useModalFocus } from "./useModalFocus";

/** How many matching lines show at once, as ivy's `ivy-height`. */
const HEIGHT = 10;

/** The last search accepted, which `C-s` in an empty search brings back (`C-s C-s`). */
let lastQuery = "";

/** `text` with its matched spans marked. */
function marked(text: string, spans: Span[]): ReactNode {
  if (spans.length === 0) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [from, to] of spans) {
    if (from < at) continue;
    if (from > at) out.push(text.slice(at, from));
    out.push(
      <mark key={from} className="mb-match">
        {text.slice(from, to)}
      </mark>,
    );
    at = to;
  }
  out.push(text.slice(at));
  return out;
}

/**
 * Swiper in the minibuffer: `N/M Swiper:` and the input, over a window of the lines that
 * match — numbered, matches marked — following the selection as ivy's does. The buffer
 * searched follows the selected line (`request.onMove`); leaving any other way than
 * `RET` on a line is a cancel, which puts it back.
 */
export default function SwiperPrompt({ request }: { request: SwiperRequest }) {
  const closeMinibuffer = useMinibufferStore((s) => s.close);
  const requestFocus = useUIStore((s) => s.requestFocus);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useModalFocus({ open: true, rootRef, initialFocusRef: inputRef });

  const [query, setQuery] = useState("");
  // The selected line rather than its place in the list: narrowing keeps the selection
  // on it, or moves it on to the next line that still matches.
  const [line, setLine] = useState(request.start);
  const matcher = useMemo(() => compileSwiper(query), [query]);
  const hits = useMemo(() => swipe(request.lines, matcher), [matcher, request.lines]);
  const selected = nearestHit(hits, line);
  const hit = selected >= 0 ? hits[selected] : null;

  const { onMove } = request;
  useEffect(() => onMove(hit, matcher), [hit, matcher, onMove]);

  // Closed by anything else (the repository closing under it) is a cancel too.
  const settled = useRef(false);
  useEffect(
    () => () => {
      if (!settled.current) request.onCancel();
    },
    [request],
  );

  const settle = () => {
    settled.current = true;
    closeMinibuffer();
    requestFocus();
  };

  const accept = (on: SwiperHit | null) => {
    settle();
    if (!on) {
      request.onCancel();
      return;
    }
    if (query.trim()) lastQuery = query;
    request.onAccept(on);
  };

  const move = (delta: number) => {
    if (hits.length === 0) return;
    setLine(hits[(selected + delta + hits.length) % hits.length].index);
  };

  const handlers: Record<MinibufferAction, KeyHandler> = {
    next: (keys) => {
      if (keys === "C-s" && !query && lastQuery) setQuery(lastQuery);
      else move(1);
    },
    prev: () => move(-1),
    // Nothing to complete: the lines are the candidates.
    complete: () => {},
    "yank-symbol": () => {
      if (request.atPoint) setQuery(quoteSwiper(request.atPoint));
    },
    accept: () => accept(hit),
    quit: () => {
      settle();
      request.onCancel();
    },
    // Typed as text: there's no question here.
    yes: () => false,
    no: () => false,
  };

  // The selected line kept mid-window, as ivy does, until the list runs out.
  const first = Math.max(0, Math.min(selected - Math.floor(HEIGHT / 2), hits.length - HEIGHT));
  const shown = hits.slice(first, first + HEIGHT);
  const digits = String(request.lines.length).length;

  return (
    <div
      ref={rootRef}
      className="minibuffer"
      role="dialog"
      aria-label="Swiper"
      tabIndex={-1}
      onKeyDown={(e) => dispatchKey("minibuffer", e, KEYMAP.minibuffer, handlers)}
    >
      <div className="mb-line">
        <span className="mb-count">
          {hit ? selected + 1 : 0}/{hits.length}
        </span>
        <label className="mb-prompt" htmlFor="swiper-input">
          Swiper:
        </label>
        <input
          id="swiper-input"
          ref={inputRef}
          className="mb-input"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div
        className="mb-list swiper-list"
        role="listbox"
        aria-label="Matching lines"
        style={{ "--swiper-digits": `${digits}ch` } as CSSProperties}
      >
        {hits.length === 0 ? (
          <div className="mb-empty">[No match]</div>
        ) : (
          shown.map((h) => (
            <div
              key={h.index}
              role="option"
              aria-selected={h === hit}
              className={`mb-row swiper-row${h === hit ? " is-selected" : ""}`}
              onClick={() => accept(h)}
            >
              <span className="swiper-number">{h.index + 1}</span>
              <span className="swiper-text">{marked(request.lines[h.index], h.spans)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
