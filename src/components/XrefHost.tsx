import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { dispatchKey, type KeyHandler } from "../lib/key-dispatch";
import { KEYMAP, type MinibufferAction } from "../lib/keymap";
import { navigateTo } from "../lib/xref";
import { useUIStore } from "../state/ui";
import { useXrefStore } from "../state/xref";
import { splitPath } from "./PathLabel";
import { useModalFocus } from "./useModalFocus";

export default function XrefHost() {
  const open = useXrefStore((s) => s.open);
  const title = useXrefStore((s) => s.title);
  const results = useXrefStore((s) => s.results);
  const choice = useXrefStore((s) => s.choice);
  const other = useXrefStore((s) => s.other);
  const closeStore = useXrefStore((s) => s.close);
  const requestFocus = useUIStore((s) => s.requestFocus);

  const rootRef = useRef<HTMLDivElement | null>(null);
  useModalFocus({ open, rootRef });
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (open) setSelected(0);
  }, [open, results]);

  const close = useCallback(() => {
    closeStore();
    requestFocus();
  }, [closeStore, requestFocus]);

  const choose = useCallback(
    (idx: number) => {
      const result = results[idx];
      if (!result || !choice) return;
      closeStore();
      navigateTo(result, choice, other);
    },
    [choice, closeStore, other, results],
  );

  const move = (delta: number) => {
    if (results.length === 0) return;
    setSelected((c) => (c + delta + results.length) % results.length);
  };

  if (!open) return null;

  // The backend already ranks proven hits first, so the split is a boundary rather
  // than a regrouping — which keeps `selected` indexing straight into `results`.
  const firstUnproven = results.findIndex((r) => !r.confirmed);
  const hasUnproven = firstUnproven >= 0;

  const handlers: Record<MinibufferAction, KeyHandler> = {
    next: () => move(1),
    prev: () => move(-1),
    complete: () => false,
    accept: () => choose(selected),
    quit: close,
    "yank-symbol": () => false,
    yes: () => false,
    no: () => false,
  };

  return (
    <div
      ref={rootRef}
      className="minibuffer mb-picker xref-panel"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={(e) => {
        // No input to type into, so j / k move too.
        if (!e.ctrlKey && !e.altKey && (e.key === "j" || e.key === "k")) {
          e.preventDefault();
          move(e.key === "j" ? 1 : -1);
          return;
        }
        dispatchKey("minibuffer", e, KEYMAP.minibuffer, handlers);
      }}
    >
      <div className="mb-line">
        <span className="mb-count">{results.length}</span>
        <span className="mb-prompt">{title}</span>
        <span className="mb-hint">RET go · C-g quit</span>
      </div>
      <div className="mb-list" role="listbox" aria-label={title}>
        {results.length === 0 ? (
          <div className="mb-empty">no results</div>
        ) : (
          results.map((r, idx) => (
            <Fragment key={`${r.file}:${r.line}:${r.col}`}>
              {hasUnproven && idx === 0 && r.confirmed && (
                <div className="xref-group">confirmed</div>
              )}
              {idx === firstUnproven && (
                <div className="xref-group is-unconfirmed">
                  unconfirmed — same name, couldn't be proven
                </div>
              )}
              <div
                role="option"
                aria-selected={idx === selected}
                ref={(el) => {
                  if (el && idx === selected) el.scrollIntoView({ block: "nearest" });
                }}
                className={`xref-row ${idx === selected ? "is-selected" : ""} ${
                  r.confirmed ? "" : "is-unconfirmed"
                }`}
                onMouseEnter={() => setSelected(idx)}
                onClick={() => choose(idx)}
              >
                <span className={`xref-kind kind-${r.kind}`}>
                  {r.kind === "definition" ? "def" : "ref"}
                </span>
                <span className="xref-name">
                  {splitPath(r.file)[1]}:{r.line}
                </span>
                <span className="xref-dir" title={r.file}>
                  <bdi>{splitPath(r.file)[0]}</bdi>
                </span>
                <span className="xref-snippet">{r.snippet.trim()}</span>
              </div>
            </Fragment>
          ))
        )}
      </div>
    </div>
  );
}
