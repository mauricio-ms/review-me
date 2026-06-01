import { useEffect, useMemo, useRef, useState } from "react";

import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import type { ChangedFile, DiffLine, Hunk } from "../types/diff";

type Row =
  | { kind: "file"; file: ChangedFile }
  | { kind: "hunk"; file: ChangedFile; hunk: Hunk }
  | { kind: "line"; file: ChangedFile; hunk: Hunk; line: DiffLine };

const STATUS_GLYPH: Record<ChangedFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

function buildRows(files: ChangedFile[], expanded: Set<string>): Row[] {
  const rows: Row[] = [];
  for (const file of files) {
    rows.push({ kind: "file", file });
    if (expanded.has(file.path) && !file.binary) {
      for (const hunk of file.hunks) {
        rows.push({ kind: "hunk", file, hunk });
        for (const line of hunk.lines) rows.push({ kind: "line", file, hunk, line });
      }
    }
  }
  return rows;
}

export default function DiffBuffer() {
  const diff = useRepoStore((s) => s.diff);
  const status = useRepoStore((s) => s.status);
  const expandedFiles = useRepoStore((s) => s.expandedFiles);
  const toggleFile = useRepoStore((s) => s.toggleFile);
  const activeBuffer = useUIStore((s) => s.activeBuffer);
  const focusRequest = useUIStore((s) => s.focusRequest);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pending = useRef<string | null>(null);
  const [cursor, setCursor] = useState(0);

  const files = useMemo(() => diff?.files ?? [], [diff]);
  const rows = useMemo(
    () => buildRows(files, expandedFiles),
    [files, expandedFiles],
  );

  // Keep the cursor in range as rows expand/collapse.
  useEffect(() => {
    setCursor((c) => Math.min(Math.max(0, c), Math.max(0, rows.length - 1)));
  }, [rows.length]);

  // Grab focus when this buffer becomes active or a focus is requested.
  useEffect(() => {
    if (activeBuffer === "diff") rootRef.current?.focus({ preventScroll: true });
  }, [activeBuffer, focusRequest]);

  // Scroll the selected row into view.
  useEffect(() => {
    rowRefs.current[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const fileRowIndex = (path: string) =>
    rows.findIndex((r) => r.kind === "file" && r.file.path === path);

  const toggleAtCursor = () => {
    const row = rows[cursor];
    if (!row) return;
    toggleFile(row.file.path);
    const idx = fileRowIndex(row.file.path);
    if (idx >= 0) setCursor(idx);
  };

  const jumpTo = (predicate: (r: Row) => boolean, dir: 1 | -1) => {
    for (
      let i = cursor + dir;
      i >= 0 && i < rows.length;
      i += dir
    ) {
      if (predicate(rows[i])) {
        setCursor(i);
        return;
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key;

    if (pending.current === "g") {
      pending.current = null;
      if (key === "g") {
        e.preventDefault();
        setCursor(0);
      }
      return;
    }
    if (pending.current === "]" || pending.current === "[") {
      const dir = pending.current === "]" ? 1 : -1;
      pending.current = null;
      if (key === "h") {
        e.preventDefault();
        jumpTo((r) => r.kind === "hunk", dir);
      } else if (key === "f") {
        e.preventDefault();
        jumpTo((r) => r.kind === "file", dir);
      }
      return;
    }

    switch (key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        setCursor((c) => Math.min(rows.length - 1, c + 1));
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
        break;
      case "G":
        e.preventDefault();
        setCursor(Math.max(0, rows.length - 1));
        break;
      case "g":
      case "]":
      case "[":
        e.preventDefault();
        pending.current = key;
        break;
      case "Tab":
      case "Enter":
        e.preventDefault();
        toggleAtCursor();
        break;
    }
  };

  const loading = status.kind === "loading";
  const error = status.kind === "error" ? status.message : null;

  return (
    <div
      ref={rootRef}
      className="buffer diff-buffer"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="diff-header">
        <span className="diff-header-branch">{diff?.branch}</span>
        <span className="diff-header-sha">{diff?.head}</span>
        <span className="diff-header-count">
          {files.length === 0
            ? "working tree clean"
            : `${files.length} changed file${files.length === 1 ? "" : "s"}`}
        </span>
        {loading && <span className="diff-header-status">refreshing…</span>}
        {error && <span className="diff-header-error">{error}</span>}
      </div>

      <div className="diff-list">
        {rows.map((row, idx) => {
          const selected = idx === cursor;
          const ref = (el: HTMLDivElement | null) => {
            rowRefs.current[idx] = el;
          };
          if (row.kind === "file") {
            const f = row.file;
            const open = expandedFiles.has(f.path) && !f.binary;
            return (
              <div
                key={`f:${f.path}`}
                ref={ref}
                className={`diff-row diff-file-row status-${f.status} ${
                  selected ? "is-selected" : ""
                }`}
                onClick={() => setCursor(idx)}
                onDoubleClick={toggleAtCursor}
              >
                <span className="diff-caret">{f.binary ? " " : open ? "▾" : "▸"}</span>
                <span className="diff-status-glyph">{STATUS_GLYPH[f.status]}</span>
                <span className="diff-file-path">
                  {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                </span>
                {f.staged && <span className="diff-staged-dot" title="staged">●</span>}
                <span className="diff-file-stat">
                  {f.binary ? (
                    "binary"
                  ) : (
                    <>
                      <span className="stat-add">+{f.addedLines}</span>{" "}
                      <span className="stat-del">−{f.removedLines}</span>
                    </>
                  )}
                </span>
              </div>
            );
          }
          if (row.kind === "hunk") {
            return (
              <div
                key={`h:${row.hunk.id}`}
                ref={ref}
                className={`diff-row diff-hunk-row ${selected ? "is-selected" : ""}`}
                onClick={() => setCursor(idx)}
              >
                <span className="diff-hunk-header">{row.hunk.header}</span>
              </div>
            );
          }
          const line = row.line;
          return (
            <div
              key={`l:${row.hunk.id}:${idx}`}
              ref={ref}
              className={`diff-row diff-line-row line-${line.kind} ${
                selected ? "is-selected" : ""
              }`}
              onClick={() => setCursor(idx)}
            >
              <span className="diff-gutter">{line.oldLine ?? ""}</span>
              <span className="diff-gutter">{line.newLine ?? ""}</span>
              <span className="diff-line-sign">
                {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
              </span>
              <span className="diff-line-content">{line.content || " "}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
