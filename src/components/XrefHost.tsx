import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { navigateTo } from "../lib/xref";
import { useUIStore } from "../state/ui";
import { useXrefStore } from "../state/xref";
import { splitPath } from "./PathLabel";
import { useModalFocus } from "./useModalFocus";

export default function XrefHost() {
  const open = useXrefStore((s) => s.open);
  const title = useXrefStore((s) => s.title);
  const results = useXrefStore((s) => s.results);
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
      if (!result) return;
      closeStore();
      void navigateTo(result);
    },
    [closeStore, results],
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

  return (
    <div className="asset-picker-backdrop">
      <div
        ref={rootRef}
        className="asset-picker neo-picker xref-panel"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape" || (e.ctrlKey && e.key === "g")) {
            e.preventDefault();
            close();
          } else if (e.key === "ArrowDown" || e.key === "j" || (e.ctrlKey && e.key === "n")) {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp" || e.key === "k" || (e.ctrlKey && e.key === "p")) {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(selected);
          }
        }}
      >
        <div className="neo-title">Cross-reference</div>
        <div className="neo-count">{results.length}</div>
        <div className="neo-prompt">
          <span>›</span>
          <span className="xref-title">{title}</span>
        </div>
        <div className="neo-separator" />
        <div className="neo-list">
          {results.length === 0 ? (
            <div className="neo-empty">no results</div>
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
                  className={`xref-row ${idx === selected ? "is-selected" : ""} ${
                    r.confirmed ? "" : "is-unconfirmed"
                  }`}
                  onMouseEnter={() => setSelected(idx)}
                  onClick={() => choose(idx)}
                >
                  <span className="xref-loc">
                    <span className={`xref-kind kind-${r.kind}`}>
                      {r.kind === "definition" ? "def" : "ref"}
                    </span>
                    <span className="xref-name">
                      {splitPath(r.file)[1]}:{r.line}
                    </span>
                    <span className="xref-dir" title={r.file}>
                      <bdi>{splitPath(r.file)[0]}</bdi>
                    </span>
                  </span>
                  <span className="xref-snippet">{r.snippet}</span>
                </div>
              </Fragment>
            ))
          )}
        </div>
        <div className="neo-footer">
          <span>↑↓ move · ↵ go · Esc close</span>
        </div>
      </div>
    </div>
  );
}
