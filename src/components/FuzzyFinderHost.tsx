import { useCallback, useEffect, useRef, useState } from "react";

import { openFileInProject } from "../lib/project";
import { fuzzyFiles } from "../lib/tauri";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import type { FileMatch } from "../types/repo";
import { useModalFocus } from "./useModalFocus";

const LIMIT = 60;

/** Render a path with the fuzzy-matched characters emphasized. */
function highlight(path: string, indices: number[]) {
  if (indices.length === 0) return path;
  const hit = new Set(indices);
  return [...path].map((ch, i) =>
    hit.has(i) ? (
      <b key={i} className="fz-hit">
        {ch}
      </b>
    ) : (
      <span key={i}>{ch}</span>
    ),
  );
}

export default function FuzzyFinderHost() {
  const open = useUIStore((s) => s.picker === "fuzzyFiles");
  const closePicker = useUIStore((s) => s.closePicker);
  const requestFocus = useUIStore((s) => s.requestFocus);
  const repoPath = useRepoStore((s) => s.repoPath);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  useModalFocus({ open, rootRef: modalRef, initialFocusRef: inputRef });

  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<FileMatch[]>([]);
  const [selected, setSelected] = useState(0);

  // Debounced fuzzy query against the backend.
  useEffect(() => {
    if (!open || !repoPath) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void fuzzyFiles(repoPath, query, LIMIT).then((matches) => {
        if (!cancelled) {
          setRows(matches);
          setSelected(0);
        }
      });
    }, 70);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open, query, repoPath]);

  // Reset when reopened.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const close = useCallback(() => {
    closePicker();
    requestFocus();
  }, [closePicker, requestFocus]);

  const openSelected = useCallback(
    (row: FileMatch | undefined) => {
      if (!row) return;
      void openFileInProject(row.path);
      closePicker();
    },
    [closePicker],
  );

  const move = (delta: number) => {
    if (rows.length === 0) return;
    setSelected((c) => (c + delta + rows.length) % rows.length);
  };

  if (!open) return null;

  const count = rows.length === 0 ? "0" : `${selected + 1}/${rows.length}`;

  return (
    <div className="asset-picker-backdrop">
      <div
        ref={modalRef}
        className="asset-picker neo-picker fuzzy-finder"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Enter") {
            e.preventDefault();
            openSelected(rows[selected]);
          }
        }}
      >
        <div className="neo-title">Find file</div>
        <div className="neo-count">{count}</div>
        <div className="neo-prompt">
          <span>›</span>
          <input
            ref={inputRef}
            value={query}
            spellCheck={false}
            autoComplete="off"
            placeholder="fuzzy file name…"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Find file"
          />
        </div>
        <div className="neo-separator" />
        <div className="neo-list">
          {rows.length === 0 ? (
            <div className="neo-empty">no matching files</div>
          ) : (
            rows.map((row, idx) => (
              <div
                key={row.path}
                className={`neo-row fz-row ${idx === selected ? "is-selected" : ""}`}
                onMouseEnter={() => setSelected(idx)}
                onClick={() => openSelected(row)}
              >
                <span className="neo-icon"></span>
                <span className="fz-path">{highlight(row.path, row.indices)}</span>
              </div>
            ))
          )}
        </div>
        <div className="neo-footer">
          <span>↑↓ move · ↵ open · Esc cancel</span>
        </div>
      </div>
    </div>
  );
}
