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
  sectionForFile,
  sectionForHunk,
  type ReviewSection,
} from "../lib/coverage";
import { openFileInProject } from "../lib/project";
import { setProjectCursor } from "../lib/project-view";
import {
  addFlag,
  removeFlags,
  reviewLines,
  reviewWholeFile,
  unreviewLines,
} from "../lib/review-actions";
import { refineHunk, type WordSeg } from "../lib/word-diff";
import DiffCleanState from "./DiffCleanState";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore } from "../state/ui";
import type { ChangedFile, DiffLine, Hunk } from "../types/diff";
import type { AnchorKind, FlagTag, ReviewedTag } from "../types/tags";

type Row =
  | { kind: "section"; section: ReviewSection; count: number }
  | { kind: "file"; section: ReviewSection; file: ChangedFile }
  | { kind: "hunk"; section: ReviewSection; file: ChangedFile; hunk: Hunk }
  | {
      kind: "line";
      section: ReviewSection;
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

/** Top-level sections, in fixed display order (magit untracked/unstaged/staged style). */
const SECTION_ORDER: ReviewSection[] = ["toReview", "flagged", "reviewed"];
const SECTION_LABEL: Record<ReviewSection, string> = {
  toReview: "To review",
  flagged: "Flagged",
  reviewed: "Reviewed",
};

function buildRows(
  files: ChangedFile[],
  expanded: Set<string>,
  collapsedHunks: Set<string>,
  collapsedSections: Set<ReviewSection>,
  reviewed: ReviewedTag[],
  flags: FlagTag[],
): Row[] {
  // Bucket each file's hunks (or the whole file, when hunkless) into sections,
  // preserving file order within a section and hunk order within a file. A hunk
  // lands in exactly one section; a file recurs once per section it has hunks in.
  type Entry = { file: ChangedFile; hunks: Hunk[] };
  const buckets: Record<ReviewSection, Entry[]> = {
    toReview: [],
    flagged: [],
    reviewed: [],
  };

  for (const file of files) {
    const reviewable = file.hunks.some((h) => hunkNewRange(h) != null);
    if (file.binary || !reviewable) {
      // Binary / pure-deletion files can't be hunk-reviewed; classify the file.
      buckets[sectionForFile(flags, file.path)].push({ file, hunks: [] });
      continue;
    }
    const perSection: Record<ReviewSection, Hunk[]> = {
      toReview: [],
      flagged: [],
      reviewed: [],
    };
    for (const hunk of file.hunks) {
      // Pure-deletion hunks have no new-side lines to tag → To review.
      const sec = hunkNewRange(hunk)
        ? sectionForHunk(reviewed, flags, file.path, hunk)
        : "toReview";
      perSection[sec].push(hunk);
    }
    for (const sec of SECTION_ORDER) {
      if (perSection[sec].length > 0) {
        buckets[sec].push({ file, hunks: perSection[sec] });
      }
    }
  }

  const rows: Row[] = [];
  for (const section of SECTION_ORDER) {
    const entries = buckets[section];
    if (entries.length === 0) continue; // hide empty sections (magit-style)
    // Count reviewable units: hunks, or the file itself when it has none.
    const count = entries.reduce((n, e) => n + (e.hunks.length || 1), 0);
    rows.push({ kind: "section", section, count });
    if (collapsedSections.has(section)) continue;
    for (const { file, hunks } of entries) {
      rows.push({ kind: "file", section, file });
      if (expanded.has(file.path) && !file.binary) {
        for (const hunk of hunks) {
          rows.push({ kind: "hunk", section, file, hunk });
          if (collapsedHunks.has(hunk.id)) continue;
          const segments = refineHunk(hunk.lines);
          hunk.lines.forEach((line, li) =>
            rows.push({
              kind: "line",
              section,
              file,
              hunk,
              line,
              segments: segments[li],
            }),
          );
        }
      }
    }
  }
  return rows;
}

export default function DiffBuffer() {
  const diff = useRepoStore((s) => s.diff);
  const status = useRepoStore((s) => s.status);
  const expandedFiles = useRepoStore((s) => s.expandedFiles);
  const collapsedHunks = useRepoStore((s) => s.collapsedHunks);
  const collapsedSections = useRepoStore((s) => s.collapsedSections);
  const toggleFile = useRepoStore((s) => s.toggleFile);
  const toggleHunk = useRepoStore((s) => s.toggleHunk);
  const toggleSection = useRepoStore((s) => s.toggleSection);
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
    () =>
      buildRows(
        files,
        expandedFiles,
        collapsedHunks,
        collapsedSections,
        reviewed,
        flags,
      ),
    [files, expandedFiles, collapsedHunks, collapsedSections, reviewed, flags],
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

  // Row-index span of the section the cursor sits in (section → all its rows,
  // file → all its rows, hunk → header + its lines, line → just itself).
  // Drives the cursor-follows highlight.
  const sectionRange = (): [number, number] => {
    const row = rows[cursor];
    if (!row || row.kind === "line") return [cursor, cursor];
    let end = cursor + 1;
    if (row.kind === "section") {
      while (end < rows.length && rows[end].kind !== "section") end++;
    } else if (row.kind === "file") {
      while (
        end < rows.length &&
        rows[end].kind !== "file" &&
        rows[end].kind !== "section"
      )
        end++;
    } else {
      while (end < rows.length && rows[end].kind === "line") end++;
    }
    return [cursor, end - 1];
  };

  // The new-side line range + scope kind targeted by the current cursor/selection.
  const targetScope = (): Scope | null => {
    if (visualAnchor != null) {
      const [a, b] = selectionRange();
      const anchor = rows[cursor];
      const file = anchor && anchor.kind !== "section" ? anchor.file : null;
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
    if (!row || row.kind === "section") return null;
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

  // A path can now recur across sections, so re-find the file row by (section, path).
  const fileRowIndex = (section: ReviewSection, path: string) =>
    rows.findIndex(
      (r) => r.kind === "file" && r.section === section && r.file.path === path,
    );

  const toggleAtCursor = () => {
    const row = rows[cursor];
    if (!row) return;
    if (row.kind === "section") {
      // Fold the whole section; the header stays put, so keep the cursor on it.
      toggleSection(row.section);
      return;
    }
    if (row.kind === "file") {
      toggleFile(row.file.path);
      const idx = fileRowIndex(row.section, row.file.path);
      if (idx >= 0) setCursor(idx);
      return;
    }
    // hunk or line: fold this hunk and land the cursor on its header row.
    toggleHunk(row.hunk.id);
    const idx = rows.findIndex(
      (r) => r.kind === "hunk" && r.hunk.id === row.hunk.id,
    );
    if (idx >= 0) setCursor(idx);
  };

  // Open the file under the cursor in project mode, positioned at the new-side
  // line the cursor maps to (line → that line, hunk → its start, file → first change).
  const openAtCursor = () => {
    const row = rows[cursor];
    if (!row || row.kind === "section") return;
    const scope = cursorScope();
    const line = scope ? scope.lo : 1;
    void openFileInProject(row.file.path).then(() => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setProjectCursor(line)),
      );
    });
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
      } else if (key === "s") {
        e.preventDefault();
        jumpTo((r) => r.kind === "section", dir);
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
        e.preventDefault();
        toggleAtCursor();
        break;
      case "Enter":
        e.preventDefault();
        openAtCursor();
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
  const isClean = diff != null && files.length === 0 && error == null;
  const [selLo, selHi] = selectionRange();
  const visual = visualAnchor != null;
  const [secLo, secHi] = visual ? [-1, -1] : sectionRange();

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

      {isClean ? (
        <DiffCleanState />
      ) : (
      <div className="diff-list">
        {rows.map((row, idx) => {
          const selected = idx === cursor;
          const inVisual = visual && idx >= selLo && idx <= selHi;
          const inSection = !visual && idx >= secLo && idx <= secHi;
          const cls = `${selected ? "is-selected" : ""} ${
            inSection ? "is-section" : ""
          } ${inVisual ? "is-visual-sel" : ""}`;
          const ref = (el: HTMLDivElement | null) => {
            rowRefs.current[idx] = el;
          };
          if (row.kind === "section") {
            const collapsed = collapsedSections.has(row.section);
            return (
              <div
                key={`s:${row.section}`}
                ref={ref}
                className={`diff-row diff-section-header section-${row.section} ${cls}`}
                onClick={() => setCursor(idx)}
                onDoubleClick={toggleAtCursor}
              >
                <span className="diff-caret">{collapsed ? "▸" : "▾"}</span>
                <span className="diff-section-label">{SECTION_LABEL[row.section]}</span>
                <span className="diff-section-count">{row.count}</span>
              </div>
            );
          }
          if (row.kind === "file") {
            const f = row.file;
            const open = expandedFiles.has(f.path) && !f.binary;
            const fileReviewed = isFileReviewed(reviewed, f);
            const fileFlagged = flags.some((t) => t.anchor.file === f.path);
            return (
              <div
                key={`f:${row.section}:${f.path}`}
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
            const open = !collapsedHunks.has(row.hunk.id);
            return (
              <div
                key={`h:${row.hunk.id}`}
                ref={ref}
                className={`diff-row diff-hunk-row ${cls}`}
                onClick={() => setCursor(idx)}
                onDoubleClick={toggleAtCursor}
              >
                <span className="diff-caret">{open ? "▾" : "▸"}</span>
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
      )}
    </div>
  );
}
