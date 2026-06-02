import { useEffect, useMemo, useRef, useState } from "react";

import {
  fileNewRange,
  flagsOverlapping,
  hunkNewRange,
  isFileReviewed,
  isHunkFlagged,
  isHunkReviewed,
  isLineFlagged,
  isLineReviewed,
} from "../lib/coverage";
import {
  addFlag,
  removeFlags,
  reviewLines,
  reviewWholeFile,
  unreviewLines,
} from "../lib/review-actions";
import { refineHunk, type WordSeg } from "../lib/word-diff";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore } from "../state/ui";
import type { ChangedFile, DiffLine, Hunk } from "../types/diff";
import type { AnchorKind } from "../types/tags";

type Row =
  | { kind: "file"; file: ChangedFile }
  | { kind: "hunk"; file: ChangedFile; hunk: Hunk }
  | {
      kind: "line";
      file: ChangedFile;
      hunk: Hunk;
      line: DiffLine;
      /** Intra-line word-diff segments, or null when there's nothing to refine. */
      segments: WordSeg[] | null;
    };

type Scope = { file: ChangedFile; lo: number; hi: number; kind: AnchorKind };

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
        const segments = refineHunk(hunk.lines);
        hunk.lines.forEach((line, li) =>
          rows.push({ kind: "line", file, hunk, line, segments: segments[li] }),
        );
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
  const reviewed = useTagsStore((s) => s.reviewed);
  const flags = useTagsStore((s) => s.flags);
  const activeBuffer = useUIStore((s) => s.activeBuffer);
  const focusRequest = useUIStore((s) => s.focusRequest);
  const diffHighlight = useUIStore((s) => s.diffHighlight);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pending = useRef<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [visualAnchor, setVisualAnchor] = useState<number | null>(null);

  const files = useMemo(() => diff?.files ?? [], [diff]);
  const rows = useMemo(
    () => buildRows(files, expandedFiles),
    [files, expandedFiles],
  );

  useEffect(() => {
    setCursor((c) => Math.min(Math.max(0, c), Math.max(0, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => {
    if (activeBuffer === "diff") rootRef.current?.focus({ preventScroll: true });
  }, [activeBuffer, focusRequest]);

  useEffect(() => {
    rowRefs.current[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const selectionRange = (): [number, number] =>
    visualAnchor == null
      ? [cursor, cursor]
      : [Math.min(visualAnchor, cursor), Math.max(visualAnchor, cursor)];

  // The new-side line range + scope kind targeted by the current cursor/selection.
  const targetScope = (): Scope | null => {
    if (visualAnchor != null) {
      const [a, b] = selectionRange();
      const file = rows[cursor]?.file;
      if (!file) return null;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = a; i <= b; i++) {
        const r = rows[i];
        if (r.kind === "line" && r.file.path === file.path && r.line.newLine != null) {
          lo = Math.min(lo, r.line.newLine);
          hi = Math.max(hi, r.line.newLine);
        }
      }
      if (lo === Infinity) return cursorScope();
      return { file, lo, hi, kind: "range" };
    }
    return cursorScope();
  };

  const cursorScope = (): Scope | null => {
    const row = rows[cursor];
    if (!row) return null;
    if (row.kind === "file") {
      const r = fileNewRange(row.file);
      if (!r) return null;
      return { file: row.file, lo: r.lo, hi: r.hi, kind: "file" };
    }
    if (row.kind === "hunk") {
      const r = hunkNewRange(row.hunk);
      if (!r) return null;
      return { file: row.file, lo: r.lo, hi: r.hi, kind: "hunk" };
    }
    if (row.line.newLine != null) {
      return { file: row.file, lo: row.line.newLine, hi: row.line.newLine, kind: "range" };
    }
    const r = hunkNewRange(row.hunk);
    if (!r) return null;
    return { file: row.file, lo: r.lo, hi: r.hi, kind: "hunk" };
  };

  const exitVisual = () => setVisualAnchor(null);

  const doReview = () => {
    const row = rows[cursor];
    if (visualAnchor == null && row?.kind === "file") {
      void reviewWholeFile(row.file);
      return;
    }
    const scope = targetScope();
    if (scope) void reviewLines(scope.file.path, scope.lo, scope.hi, scope.kind);
    exitVisual();
  };

  const doUnreview = () => {
    const scope = targetScope();
    if (scope) void unreviewLines(scope.file.path, scope.lo, scope.hi);
    exitVisual();
  };

  const doFlag = () => {
    const scope = targetScope();
    if (!scope) return;
    const overlapping = flagsOverlapping(flags, scope.file.path, scope.lo, scope.hi);
    if (overlapping.length > 0) {
      void removeFlags(overlapping.map((t) => t.id));
    } else {
      void addFlag(scope.file.path, scope.lo, scope.hi, scope.kind);
    }
    exitVisual();
  };

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
    for (let i = cursor + dir; i >= 0 && i < rows.length; i += dir) {
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
      case "v":
      case "V":
        e.preventDefault();
        setVisualAnchor((a) => (a == null ? cursor : null));
        break;
      case "Escape":
        if (visualAnchor != null) {
          e.preventDefault();
          exitVisual();
        }
        break;
      case "r":
        e.preventDefault();
        doReview();
        break;
      case "u":
        e.preventDefault();
        doUnreview();
        break;
      case "f":
        e.preventDefault();
        doFlag();
        break;
    }
  };

  const loading = status.kind === "loading";
  const error = status.kind === "error" ? status.message : null;
  const [selLo, selHi] = selectionRange();
  const visual = visualAnchor != null;

  return (
    <div
      ref={rootRef}
      className={`buffer diff-buffer ${visual ? "is-visual" : ""}`}
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
        {visual && <span className="diff-header-visual">VISUAL</span>}
        {loading && <span className="diff-header-status">refreshing…</span>}
        {error && <span className="diff-header-error">{error}</span>}
      </div>

      <div className="diff-list">
        {rows.map((row, idx) => {
          const selected = idx === cursor;
          const inVisual = visual && idx >= selLo && idx <= selHi;
          const cls = `${selected ? "is-selected" : ""} ${inVisual ? "is-visual-sel" : ""}`;
          const ref = (el: HTMLDivElement | null) => {
            rowRefs.current[idx] = el;
          };
          if (row.kind === "file") {
            const f = row.file;
            const open = expandedFiles.has(f.path) && !f.binary;
            const fileReviewed = isFileReviewed(reviewed, f);
            const fileFlagged = flags.some((t) => t.anchor.file === f.path);
            return (
              <div
                key={`f:${f.path}`}
                ref={ref}
                className={`diff-row diff-file-row status-${f.status} ${cls}`}
                onClick={() => setCursor(idx)}
                onDoubleClick={toggleAtCursor}
              >
                <span className="diff-caret">{f.binary ? " " : open ? "▾" : "▸"}</span>
                <span className="diff-mark">
                  {fileReviewed && <span className="mark-reviewed">✓</span>}
                  {fileFlagged && <span className="mark-flagged">⚑</span>}
                </span>
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
            const hunkReviewed = isHunkReviewed(reviewed, row.file.path, row.hunk);
            const hunkFlagged = isHunkFlagged(flags, row.file.path, row.hunk);
            return (
              <div
                key={`h:${row.hunk.id}`}
                ref={ref}
                className={`diff-row diff-hunk-row ${cls}`}
                onClick={() => setCursor(idx)}
              >
                <span className="diff-mark">
                  {hunkReviewed && <span className="mark-reviewed">✓</span>}
                  {hunkFlagged && <span className="mark-flagged">⚑</span>}
                </span>
                <span className="diff-hunk-header">{row.hunk.header}</span>
              </div>
            );
          }
          const line = row.line;
          const lineReviewed =
            line.newLine != null && isLineReviewed(reviewed, row.file.path, line.newLine);
          const lineFlagged =
            line.newLine != null && isLineFlagged(flags, row.file.path, line.newLine);
          return (
            <div
              key={`l:${row.hunk.id}:${idx}`}
              ref={ref}
              className={`diff-row diff-line-row line-${line.kind} ${
                lineReviewed ? "is-reviewed" : ""
              } ${lineFlagged ? "is-flagged" : ""} ${cls}`}
              onClick={() => setCursor(idx)}
            >
              <span className="diff-gutter">{line.oldLine ?? ""}</span>
              <span className="diff-gutter">{line.newLine ?? ""}</span>
              <span className="diff-line-sign">
                {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
              </span>
              <span className="diff-line-content">
                {diffHighlight === "word" && row.segments && row.segments.length > 0
                  ? row.segments.map((seg, i) =>
                      seg.changed ? (
                        <span key={i} className="diff-word">
                          {seg.text}
                        </span>
                      ) : (
                        <span key={i}>{seg.text}</span>
                      ),
                    )
                  : line.content || " "}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
