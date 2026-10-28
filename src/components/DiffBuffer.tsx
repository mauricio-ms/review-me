import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  fileNewRange,
  fileOldRange,
  hunkTarget,
  isFileReviewed,
  isHunkFlagged,
  isHunkIgnored,
  isHunkReviewed,
  isLineFlagged,
  isLineIgnored,
  isLineReviewed,
  isPureDeletionHunk,
  sectionForFile,
  sectionForHunk,
  type ReviewSection,
} from "../lib/coverage";
import type { ShowOptions } from "../lib/buffers";
import { setDiffTargetSource } from "../lib/diff-view";
import { dispatchKey, type KeyHandler } from "../lib/key-dispatch";
import { KEYMAP, type DiffAction } from "../lib/keymap";
import { flagTarget, hasNote, openNoteFor } from "../lib/notes";
import { leaveHistory } from "../lib/open-repo";
import { openFileFromDiff } from "../lib/project";
import {
  addFlag,
  addIgnore,
  reviewLines,
  reviewWholeFile,
  unmarkLines,
} from "../lib/review-actions";
import { refineHunk, type WordSeg } from "../lib/word-diff";
import DiffCleanState from "./DiffCleanState";
import PathLabel from "./PathLabel";
import { useNotesStore } from "../state/notes";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore } from "../state/ui";
import { hasKeyboard, isShown, useWindowStore } from "../state/windows";
import {
  comparisonLabel,
  shortOid,
  type ChangedFile,
  type Comparison,
  type DiffLine,
  type Hunk,
} from "../types/diff";
import type {
  AnchorKind,
  AnchorSide,
  FlagTag,
  IgnoredTag,
  ReviewedTag,
} from "../types/tags";

type Row =
  | { key: string; kind: "section"; section: ReviewSection; count: number }
  | { key: string; kind: "file"; section: ReviewSection; file: ChangedFile }
  | {
      key: string;
      kind: "hunk";
      section: ReviewSection;
      file: ChangedFile;
      hunk: Hunk;
    }
  | {
      key: string;
      kind: "line";
      section: ReviewSection;
      file: ChangedFile;
      hunk: Hunk;
      line: DiffLine;
      /** Intra-line word-diff segments, or null when there's nothing to refine. */
      segments: WordSeg[] | null;
    }
  | {
      key: string;
      kind: "note";
      section: ReviewSection;
      file: ChangedFile;
      /** The hunk the note sits under; null for a note on the whole file. */
      hunk: Hunk | null;
      flag: FlagTag;
    };

type Scope = {
  file: ChangedFile;
  lo: number;
  hi: number;
  kind: AnchorKind;
  side: AnchorSide;
};

const STATUS_GLYPH: Record<ChangedFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

/** Top-level sections, in fixed display order (magit untracked/unstaged/staged style). */
const SECTION_ORDER: ReviewSection[] = ["toReview", "flagged", "reviewed", "ignored"];
const SECTION_LABEL: Record<ReviewSection, string> = {
  toReview: "To review",
  flagged: "Flagged",
  reviewed: "Reviewed",
  ignored: "Ignored",
};

const LIST_PADDING_TOP = 6;
const VIRTUAL_OVERSCAN = 800;

function estimatedRowHeight(kind: Row["kind"]): number {
  switch (kind) {
    case "section":
      return 38;
    case "file":
      return 44;
    case "hunk":
      return 34;
    case "line":
      return 30;
    case "note":
      return 32;
  }
}

function measuredRowHeight(element: HTMLDivElement): number {
  const rectHeight = element.getBoundingClientRect().height;
  if (rectHeight <= 0) return 0;
  const style = window.getComputedStyle(element);
  return (
    rectHeight +
    (parseFloat(style.marginTop) || 0) +
    (parseFloat(style.marginBottom) || 0)
  );
}

/** Find the row whose vertical span contains `offset`. */
function rowAtOffset(offsets: Float64Array, offset: number): number {
  const rowCount = offsets.length - 1;
  if (rowCount <= 0) return 0;
  let lo = 0;
  let hi = rowCount - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsets[mid + 1] <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** What "nothing to show" means depends on what's being compared. */
function emptyLabel(comparison: Comparison | undefined): string {
  if (comparison?.kind === "branches") {
    return `no changes between ${comparison.baseName} and ${comparison.targetName}`;
  }
  if (comparison?.kind === "commit") {
    return `${comparison.shortOid} changes nothing`;
  }
  return "working tree clean";
}

/** The revision range in the header: what the diff was taken between. */
function headerRange(comparison: Comparison | undefined): string {
  switch (comparison?.kind) {
    case "branches":
      return `merge-base ${shortOid(comparison.mergeBase)} → ${shortOid(
        comparison.targetOid,
      )}`;
    case "commit":
      return comparison.parentOid
        ? `${comparison.isMerge ? "first parent" : "parent"} ${shortOid(
            comparison.parentOid,
          )} → ${comparison.shortOid}`
        : `root commit ${comparison.shortOid}`;
    default:
      return comparison?.head ?? "";
  }
}

/**
 * Where each of a file's notes (flags carrying one) is shown: a note on lines sits
 * under the first hunk it touches; a note on the whole file, or on lines outside every
 * hunk (flagged from project mode), sits under the file row.
 */
function placeNotes(
  file: ChangedFile,
  flags: FlagTag[],
): { fileNotes: FlagTag[]; hunkNotes: Map<string, FlagTag[]> } {
  const fileNotes: FlagTag[] = [];
  const hunkNotes = new Map<string, FlagTag[]>();
  const notes = flags
    .filter((f) => f.anchor.file === file.path && !f.anchor.stale && hasNote(f))
    .sort((a, b) => a.anchor.startLine - b.anchor.startLine);
  for (const flag of notes) {
    const { kind, side, startLine, endLine } = flag.anchor;
    const hunk =
      kind === "file" || side === "file"
        ? undefined
        : file.hunks.find((h) => {
            const t = hunkTarget(h);
            return t != null && t.side === side && t.lo <= endLine && t.hi >= startLine;
          });
    if (!hunk) {
      fileNotes.push(flag);
      continue;
    }
    const list = hunkNotes.get(hunk.id) ?? [];
    list.push(flag);
    hunkNotes.set(hunk.id, list);
  }
  return { fileNotes, hunkNotes };
}

function buildRows(
  files: ChangedFile[],
  expanded: Set<string>,
  collapsedHunks: Set<string>,
  collapsedSections: Set<ReviewSection>,
  reviewed: ReviewedTag[],
  flags: FlagTag[],
  ignored: IgnoredTag[],
): Row[] {
  // Bucket each file's hunks (or the whole file, when hunkless) into sections,
  // preserving file order within a section and hunk order within a file. A hunk
  // lands in exactly one section; a file recurs once per section it has hunks in.
  type Entry = { file: ChangedFile; hunks: Hunk[] };
  const buckets: Record<ReviewSection, Entry[]> = {
    toReview: [],
    flagged: [],
    reviewed: [],
    ignored: [],
  };

  for (const file of files) {
    const reviewable = file.hunks.some((h) => hunkTarget(h) != null);
    if (file.binary || !reviewable) {
      // Binary / hunkless files are reviewed as a single file-scope unit.
      buckets[sectionForFile(reviewed, flags, ignored, file.path)].push({
        file,
        hunks: [],
      });
      continue;
    }
    const perSection: Record<ReviewSection, Hunk[]> = {
      toReview: [],
      flagged: [],
      reviewed: [],
      ignored: [],
    };
    for (const hunk of file.hunks) {
      // A hunk with no reviewable lines (neither added nor removed) → To review.
      const sec = hunkTarget(hunk)
        ? sectionForHunk(reviewed, flags, ignored, file.path, hunk)
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
  // A file recurs once per section it has hunks in; its whole-file notes show once.
  const fileNotesShown = new Set<string>();
  for (const section of SECTION_ORDER) {
    const entries = buckets[section];
    if (entries.length === 0) continue; // hide empty sections (magit-style)
    // Count reviewable units: hunks, or the file itself when it has none.
    const count = entries.reduce((n, e) => n + (e.hunks.length || 1), 0);
    rows.push({ key: `s:${section}`, kind: "section", section, count });
    if (collapsedSections.has(section)) continue;
    for (const { file, hunks } of entries) {
      rows.push({ key: `f:${section}:${file.path}`, kind: "file", section, file });
      // A binary file never expands, so its notes show regardless.
      if (!expanded.has(file.path) && !file.binary) continue;
      const { fileNotes, hunkNotes } = placeNotes(file, flags);
      if (!fileNotesShown.has(file.path)) {
        fileNotesShown.add(file.path);
        for (const flag of fileNotes) {
          rows.push({
            key: `n:${section}:${flag.id}`,
            kind: "note",
            section,
            file,
            hunk: null,
            flag,
          });
        }
      }
      if (!file.binary) {
        for (const hunk of hunks) {
          rows.push({
            key: `h:${section}:${hunk.id}`,
            kind: "hunk",
            section,
            file,
            hunk,
          });
          // Notes stay visible with their hunk folded: they're what you came back for.
          for (const flag of hunkNotes.get(hunk.id) ?? []) {
            rows.push({
              key: `n:${section}:${flag.id}`,
              kind: "note",
              section,
              file,
              hunk,
              flag,
            });
          }
          if (collapsedHunks.has(hunk.id)) continue;
          const segments = refineHunk(hunk.lines);
          hunk.lines.forEach((line, li) =>
            rows.push({
              key: `l:${section}:${hunk.id}:${li}`,
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
  const comparison = diff?.comparison;
  const comparisonEpoch = useRepoStore((s) => s.comparisonEpoch);
  const status = useRepoStore((s) => s.status);
  const expandedFiles = useRepoStore((s) => s.expandedFiles);
  const collapsedHunks = useRepoStore((s) => s.collapsedHunks);
  const collapsedSections = useRepoStore((s) => s.collapsedSections);
  const toggleFile = useRepoStore((s) => s.toggleFile);
  const toggleHunk = useRepoStore((s) => s.toggleHunk);
  const toggleSection = useRepoStore((s) => s.toggleSection);
  const reviewed = useTagsStore((s) => s.reviewed);
  const flags = useTagsStore((s) => s.flags);
  const ignored = useTagsStore((s) => s.ignored);
  // Whether a window shows this buffer, and whether that window has the keyboard.
  const visible = useWindowStore((s) => isShown(s, "diff"));
  const focused = useWindowStore((s) => hasKeyboard(s, "diff"));
  const focusRequest = useUIStore((s) => s.focusRequest);
  const diffHighlight = useUIStore((s) => s.diffHighlight);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const rowRefCallbacks = useRef(
    new Map<string, (element: HTMLDivElement | null) => void>(),
  );
  const rowResizeObserver = useRef<ResizeObserver | null>(null);
  const rowHeights = useRef(new Map<string, number>());
  const measurementFrame = useRef<number | null>(null);
  const viewportFrame = useRef<number | null>(null);
  // Set when we move the cursor to keep it on screen after a manual scroll, so the
  // cursor effect below doesn't re-center and fight the scroll (Ctrl-E / Ctrl-R).
  const skipScrollIntoView = useRef(false);
  const [cursor, setCursor] = useState(0);
  const [visualAnchor, setVisualAnchor] = useState<number | null>(null);
  const [measurementEpoch, setMeasurementEpoch] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });

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
        ignored,
      ),
    [files, expandedFiles, collapsedHunks, collapsedSections, reviewed, flags, ignored],
  );
  const rowOffsets = useMemo(() => {
    const offsets = new Float64Array(rows.length + 1);
    for (let i = 0; i < rows.length; i++) {
      offsets[i + 1] =
        offsets[i] +
        (rowHeights.current.get(rows[i].key) ?? estimatedRowHeight(rows[i].kind));
    }
    return offsets;
  }, [rows, measurementEpoch]);
  const rowGroupEnds = useMemo(() => {
    const ends = new Int32Array(rows.length);
    let section = -1;
    let file = -1;
    let hunk = -1;
    const close = (index: number) => {
      if (hunk >= 0) ends[hunk] = index;
      if (file >= 0) ends[file] = index;
      if (section >= 0) ends[section] = index;
    };
    for (let i = 0; i < rows.length; i++) {
      ends[i] = i;
      if (rows[i].kind === "section") {
        close(i - 1);
        section = i;
        file = -1;
        hunk = -1;
      } else if (rows[i].kind === "file") {
        if (hunk >= 0) ends[hunk] = i - 1;
        if (file >= 0) ends[file] = i - 1;
        file = i;
        hunk = -1;
      } else if (rows[i].kind === "hunk") {
        if (hunk >= 0) ends[hunk] = i - 1;
        hunk = i;
      }
    }
    close(rows.length - 1);
    return ends;
  }, [rows]);
  const loading = status.kind === "loading";
  const error = status.kind === "error" ? status.message : null;
  const isClean = diff != null && files.length === 0 && error == null;
  const previousCursor = useRef(cursor);
  const previousRows = useRef(rows);
  const currentCursorKey = useRef<string | null>(null);
  const cursorScrollTarget = useRef<string | null>(null);
  const cursorScrollMeasured = useRef(false);
  currentCursorKey.current = rows[cursor]?.key ?? null;

  // The mode line names the file (and line) under the cursor: the full path, which the
  // rows above it may have scrolled away.
  const cursorRow = rows[cursor];
  const cursorFile = cursorRow && cursorRow.kind !== "section" ? cursorRow.file.path : null;
  const cursorLine =
    cursorRow?.kind === "line" ? (cursorRow.line.newLine ?? cursorRow.line.oldLine) : null;
  const setDiffCursor = useUIStore((s) => s.setDiffCursor);
  useEffect(() => {
    setDiffCursor(cursorFile ? { path: cursorFile, line: cursorLine } : null);
  }, [cursorFile, cursorLine, setDiffCursor]);

  const cacheRenderedRowHeights = () => {
    rowElements.current.forEach((element, key) => {
      const height = measuredRowHeight(element);
      if (height > 0) rowHeights.current.set(key, height);
    });
  };

  const hasCurrentMeasurement = (key: string): boolean => {
    const element = rowElements.current.get(key);
    const cached = rowHeights.current.get(key);
    return (
      element != null &&
      cached != null &&
      Math.abs(measuredRowHeight(element) - cached) <= 0.5
    );
  };

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      // Rows whose height differs from what the offsets laid them out at (their cached
      // height, or the estimate): each moved everything below it by `delta`.
      const resized: { top: number; delta: number }[] = [];
      for (const entry of entries) {
        const element = entry.target as HTMLDivElement;
        const key = element.dataset.rowKey;
        if (!key) continue;
        const height = measuredRowHeight(element);
        // This buffer stays mounted while no window shows it, detached at zero size.
        // Ignore those zero-size observations so they cannot poison scroll offsets.
        if (height <= 0) continue;
        const previous = rowHeights.current.get(key);
        if (previous == null || Math.abs(previous - height) > 0.5) {
          const assumed =
            previous ?? estimatedRowHeight(element.dataset.rowKind as Row["kind"]);
          resized.push({ top: element.getBoundingClientRect().top, delta: height - assumed });
          rowHeights.current.set(key, height);
          changed = true;
        }
        if (key === cursorScrollTarget.current && !cursorScrollMeasured.current) {
          cursorScrollMeasured.current = true;
          changed = true;
        }
      }
      // Undo the move of whatever started above the viewport, before paint, so rows
      // measured while scrolling up (wrapped lines taller than estimated) don't shove the
      // content under the reader. "Above" is judged by where a row sat before this batch:
      // in document order, every resized row above it has already pushed it down. The list
      // opts out of native scroll anchoring, so this is the only correction applied.
      const list = listRef.current;
      if (list && list.clientHeight > 0 && resized.length > 0) {
        const viewTop = list.getBoundingClientRect().top;
        resized.sort((a, b) => a.top - b.top);
        let shift = 0;
        for (const { top, delta } of resized) {
          if (top - shift >= viewTop) break;
          shift += delta;
        }
        if (Math.abs(shift) > 0.5) list.scrollTop += shift;
      }
      if (changed && measurementFrame.current == null) {
        measurementFrame.current = requestAnimationFrame(() => {
          measurementFrame.current = null;
          setMeasurementEpoch((epoch) => epoch + 1);
        });
      }
    });
    rowResizeObserver.current = observer;
    rowElements.current.forEach((element) => observer.observe(element));
    return () => {
      observer.disconnect();
      rowResizeObserver.current = null;
      if (measurementFrame.current != null) {
        cancelAnimationFrame(measurementFrame.current);
        measurementFrame.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    let lastWidth = element.clientWidth;
    const syncViewport = () => {
      // Detached (no window shows it): keep the last rows rendered so coming back
      // shows the same rows rather than re-rendering from the top.
      if (element.clientHeight <= 0) return;
      setViewport((current) => {
        const next = { top: element.scrollTop, height: element.clientHeight };
        return current.top === next.top && current.height === next.height ? current : next;
      });
    };
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth;
      if (width > 0 && lastWidth > 0 && width !== lastWidth) {
        const cursorKey = currentCursorKey.current;
        const cursorWasRendered = cursorKey != null && rowElements.current.has(cursorKey);
        rowHeights.current.clear();
        cacheRenderedRowHeights();
        cursorScrollTarget.current = cursorWasRendered ? cursorKey : null;
        cursorScrollMeasured.current = cursorKey != null && hasCurrentMeasurement(cursorKey);
        setMeasurementEpoch((epoch) => epoch + 1);
      }
      if (width > 0) lastWidth = width;
      syncViewport();
    });
    observer.observe(element);
    syncViewport();
    return () => {
      observer.disconnect();
      if (viewportFrame.current != null) {
        cancelAnimationFrame(viewportFrame.current);
        viewportFrame.current = null;
      }
    };
  }, [isClean]);

  // A different comparison starts its heights from estimates again. A refresh keeps
  // them: the same rows are usually the same height, and any that changed are
  // re-measured (and scroll-corrected) as they render, so the view doesn't jump.
  useLayoutEffect(() => {
    rowHeights.current.clear();
    cacheRenderedRowHeights();
    setMeasurementEpoch((epoch) => epoch + 1);
  }, [comparisonEpoch]);

  useEffect(() => {
    setCursor((c) => Math.min(Math.max(0, c), Math.max(0, rows.length - 1)));
  }, [rows.length]);

  // A different comparison is a different list of things — row 3 of the old one
  // means nothing in the new one.
  useEffect(() => {
    setCursor(0);
    setVisualAnchor(null);
  }, [comparisonEpoch]);

  useEffect(() => {
    if (focused) rootRef.current?.focus({ preventScroll: true });
  }, [focused, focusRequest]);

  useLayoutEffect(() => {
    const cursorChanged = previousCursor.current !== cursor;
    const rowsChanged = previousRows.current !== rows;
    previousCursor.current = cursor;
    previousRows.current = rows;
    if (skipScrollIntoView.current) {
      skipScrollIntoView.current = false;
      cursorScrollTarget.current = null;
      cursorScrollMeasured.current = false;
      return;
    }
    const element = listRef.current;
    const row = rows[cursor];
    if (!visible || !element || element.clientHeight <= 0 || !row) {
      cursorScrollTarget.current = null;
      cursorScrollMeasured.current = false;
      return;
    }
    if (cursorChanged || rowsChanged) {
      cursorScrollTarget.current = row.key;
      cursorScrollMeasured.current = hasCurrentMeasurement(row.key);
    }
    if (cursorScrollTarget.current !== row.key) return;
    const top = LIST_PADDING_TOP + rowOffsets[cursor];
    const bottom = LIST_PADDING_TOP + rowOffsets[cursor + 1];
    const viewTop = element.scrollTop;
    const viewBottom = viewTop + element.clientHeight;
    let next = viewTop;
    if (top < viewTop) next = top;
    else if (bottom > viewBottom) {
      next =
        bottom - top > element.clientHeight
          ? top
          : Math.max(0, bottom - element.clientHeight);
    }
    if (next !== viewTop) {
      element.scrollTop = next;
      setViewport({ top: next, height: element.clientHeight });
    }
    cursorScrollMeasured.current = hasCurrentMeasurement(row.key);
    if (cursorScrollMeasured.current) {
      cursorScrollTarget.current = null;
      cursorScrollMeasured.current = false;
    }
  }, [cursor, rowOffsets, rows, visible]);

  const selectionRange = (): [number, number] =>
    visualAnchor == null
      ? [cursor, cursor]
      : [Math.min(visualAnchor, cursor), Math.max(visualAnchor, cursor)];

  // Row-index span of the section the cursor sits in (section → all its rows,
  // file → all its rows, hunk → header + its lines, line → just itself).
  // Drives the cursor-follows highlight.
  const sectionRange = (): [number, number] => {
    const row = rows[cursor];
    if (!row) return [cursor, cursor];
    return [cursor, rowGroupEnds[cursor]];
  };

  // The line range + scope kind/side targeted by the current cursor/selection. A
  // selection over added/context lines tags the new side; over a pure deletion's
  // removed lines, the old side.
  const targetScope = (): Scope | null => {
    if (visualAnchor != null) {
      const [a, b] = selectionRange();
      const anchor = rows[cursor];
      const file = anchor && anchor.kind !== "section" ? anchor.file : null;
      if (!file) return null;
      let newLo = Infinity;
      let newHi = -Infinity;
      let oldLo = Infinity;
      let oldHi = -Infinity;
      for (let i = a; i <= b; i++) {
        const r = rows[i];
        if (r.kind !== "line" || r.file.path !== file.path) continue;
        if (r.line.newLine != null) {
          newLo = Math.min(newLo, r.line.newLine);
          newHi = Math.max(newHi, r.line.newLine);
        } else if (
          r.line.kind === "removed" &&
          r.line.oldLine != null &&
          isPureDeletionHunk(r.hunk)
        ) {
          oldLo = Math.min(oldLo, r.line.oldLine);
          oldHi = Math.max(oldHi, r.line.oldLine);
        }
      }
      if (newLo !== Infinity)
        return { file, lo: newLo, hi: newHi, kind: "range", side: "new" };
      if (oldLo !== Infinity)
        return { file, lo: oldLo, hi: oldHi, kind: "range", side: "old" };
      return cursorScope();
    }
    return cursorScope();
  };

  const cursorScope = (): Scope | null => {
    const row = rows[cursor];
    if (!row || row.kind === "section") return null;
    if (row.kind === "file") {
      if (row.file.binary) {
        return { file: row.file, lo: 0, hi: 0, kind: "file", side: "file" };
      }
      const nr = fileNewRange(row.file);
      if (nr) return { file: row.file, lo: nr.lo, hi: nr.hi, kind: "file", side: "new" };
      const or = fileOldRange(row.file);
      if (or) return { file: row.file, lo: or.lo, hi: or.hi, kind: "file", side: "old" };
      return null;
    }
    if (row.kind === "hunk") {
      const t = hunkTarget(row.hunk);
      if (!t) return null;
      return { file: row.file, lo: t.lo, hi: t.hi, kind: "hunk", side: t.side };
    }
    // A note row stands for its flag's lines: `u` there unmarks them, `M-x note` edits it.
    if (row.kind === "note") {
      const { lo, hi, kind, side } = flagTarget(row.flag);
      return { file: row.file, lo, hi, kind, side };
    }
    if (row.line.newLine != null) {
      return {
        file: row.file,
        lo: row.line.newLine,
        hi: row.line.newLine,
        kind: "range",
        side: "new",
      };
    }
    if (
      row.line.kind === "removed" &&
      row.line.oldLine != null &&
      isPureDeletionHunk(row.hunk)
    ) {
      return {
        file: row.file,
        lo: row.line.oldLine,
        hi: row.line.oldLine,
        kind: "range",
        side: "old",
      };
    }
    const t = hunkTarget(row.hunk);
    if (!t) return null;
    return { file: row.file, lo: t.lo, hi: t.hi, kind: "hunk", side: t.side };
  };

  const exitVisual = () => setVisualAnchor(null);

  // `M-x note` reads the cursor's target through this handle; re-registered every render
  // so it always sees the current cursor and selection.
  useEffect(() => {
    setDiffTargetSource(() => {
      const scope = targetScope();
      return scope
        ? {
            file: scope.file.path,
            lo: scope.lo,
            hi: scope.hi,
            kind: scope.kind,
            side: scope.side,
          }
        : null;
    });
  });
  useEffect(() => () => setDiffTargetSource(null), []);

  // Opening a note consumes the selection, as marking it would.
  const noteOpen = useNotesStore((s) => s.editing != null);
  useEffect(() => {
    if (noteOpen) setVisualAnchor(null);
  }, [noteOpen]);

  const doReview = () => {
    const row = rows[cursor];
    if (visualAnchor == null && row?.kind === "file") {
      void reviewWholeFile(row.file);
      return;
    }
    const scope = targetScope();
    if (scope)
      void reviewLines(scope.file.path, scope.lo, scope.hi, scope.kind, scope.side);
    exitVisual();
  };

  const doUnmark = () => {
    const scope = targetScope();
    if (scope) void unmarkLines(scope.file.path, scope.lo, scope.hi, scope.side);
    exitVisual();
  };

  const doFlag = () => {
    const scope = targetScope();
    if (!scope) return;
    void addFlag(scope.file.path, scope.lo, scope.hi, scope.kind, scope.side);
    exitVisual();
  };

  const doIgnore = () => {
    const scope = targetScope();
    if (!scope) return;
    void addIgnore(scope.file.path, scope.lo, scope.hi, scope.kind, scope.side);
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
    if (row.kind === "note" && row.hunk == null) {
      toggleFile(row.file.path);
      const idx = fileRowIndex(row.section, row.file.path);
      if (idx >= 0) setCursor(idx);
      return;
    }
    // hunk, line or a hunk's note: fold this hunk and land the cursor on its header.
    const hunk = row.hunk;
    if (!hunk) return;
    toggleHunk(hunk.id);
    const idx = rows.findIndex((r) => r.kind === "hunk" && r.hunk.id === hunk.id);
    if (idx >= 0) setCursor(idx);
  };

  // Open the file under the cursor as a buffer, at the line the cursor maps to (line →
  // that line, hunk → its start, file → first change). The scope's side also picks the
  // revision: old-side content (a deletion) only exists in the base, so opening it
  // must not fall back to the working tree.
  // `o` opens it in the other window, `C-o` only shows it there (the diff keeps the
  // keyboard, so you can go on down the hunks with the file beside them).
  const openAtCursor = (options: ShowOptions = {}) => {
    const row = rows[cursor];
    if (!row || row.kind === "section") return;
    const scope = cursorScope();
    const line = scope ? scope.lo : 1;
    const side = scope?.side === "old" ? "old" : "new";
    openFileFromDiff(row.file.path, side, line, options);
  };

  const jumpTo = (predicate: (r: Row) => boolean, dir: 1 | -1) => {
    for (let i = cursor + dir; i >= 0 && i < rows.length; i += dir) {
      if (predicate(rows[i])) {
        setCursor(i);
        return;
      }
    }
  };

  // Scroll the content one line without moving the cursor (magit/vim C-e/C-y). If the
  // scroll pushes the selected row out of view, hop the cursor to the nearest still-
  // visible row so it never disappears.
  const scrollByLine = (dir: 1 | -1) => {
    const el = listRef.current;
    if (!el) return;
    // One *visual* line, read off the list's line-height — a row that wraps is several
    // lines tall, so its own height would scroll too far.
    const lineH = parseFloat(window.getComputedStyle(el).lineHeight) || 24;
    el.scrollTop += dir * lineH;
    keepCursorVisible(el);
  };

  const keepCursorVisible = (el: HTMLDivElement) => {
    if (cursor < 0 || cursor >= rows.length) return;
    const viewTop = el.scrollTop;
    const viewBottom = viewTop + el.clientHeight;
    const top = LIST_PADDING_TOP + rowOffsets[cursor];
    const bottom = LIST_PADDING_TOP + rowOffsets[cursor + 1];
    if (bottom > viewTop && top < viewBottom) return; // still (partially) visible
    let target: number;
    if (bottom <= viewTop) {
      // Scrolled down past the cursor: first row visible from the top.
      target = rowAtOffset(rowOffsets, Math.max(0, viewTop - LIST_PADDING_TOP));
    } else {
      // Scrolled up past the cursor: last row visible from the bottom.
      target = rowAtOffset(
        rowOffsets,
        Math.max(0, viewBottom - LIST_PADDING_TOP - 1),
      );
    }
    if (target !== cursor) {
      skipScrollIntoView.current = true;
      setCursor(target);
    }
  };

  const onListScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (viewportFrame.current != null) return;
    viewportFrame.current = requestAnimationFrame(() => {
      viewportFrame.current = null;
      setViewport({ top: element.scrollTop, height: element.clientHeight });
    });
  };

  const refForRow = (row: Row) => {
    const { key, kind } = row;
    const existing = rowRefCallbacks.current.get(key);
    if (existing) return existing;
    const callback = (element: HTMLDivElement | null) => {
      const previous = rowElements.current.get(key);
      if (previous && previous !== element) rowResizeObserver.current?.unobserve(previous);
      if (element) {
        element.dataset.rowKey = key;
        element.dataset.rowKind = kind;
        rowElements.current.set(key, element);
        rowResizeObserver.current?.observe(element);
      } else {
        rowElements.current.delete(key);
        rowRefCallbacks.current.delete(key);
      }
    };
    rowRefCallbacks.current.set(key, callback);
    return callback;
  };

  const handlers: Record<DiffAction, KeyHandler> = {
    down: () => setCursor((c) => Math.min(rows.length - 1, c + 1)),
    up: () => setCursor((c) => Math.max(0, c - 1)),
    first: () => setCursor(0),
    last: () => setCursor(Math.max(0, rows.length - 1)),
    "next-hunk": () => jumpTo((r) => r.kind === "hunk", 1),
    "prev-hunk": () => jumpTo((r) => r.kind === "hunk", -1),
    "next-file": () => jumpTo((r) => r.kind === "file", 1),
    "prev-file": () => jumpTo((r) => r.kind === "file", -1),
    "next-section": () => jumpTo((r) => r.kind === "section", 1),
    "prev-section": () => jumpTo((r) => r.kind === "section", -1),
    toggle: toggleAtCursor,
    open: () => openAtCursor(),
    "open-other": () => openAtCursor({ other: true }),
    "display-other": () => openAtCursor({ other: true, select: false }),
    visual: () => setVisualAnchor((a) => (a == null ? cursor : null)),
    // Nothing selected: let the key go on (C-g has already said "Quit").
    escape: () => {
      if (visualAnchor == null) return false;
      exitVisual();
    },
    review: doReview,
    flag: doFlag,
    ignore: doIgnore,
    unmark: doUnmark,
    "scroll-down": () => scrollByLine(1),
    // C-r must be consumed: in tauri dev (Vite) it reloads the page.
    "scroll-up": () => scrollByLine(-1),
    // A commit or the branch's whole range is entered from the commits buffer; `q`
    // goes back to it (magit's quit-window). Nothing to leave in the worktree.
    quit: () => {
      if (!comparison || comparison.kind === "worktree") return false;
      leaveHistory();
    },
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    dispatchKey("diff", e, KEYMAP.diff, handlers);
  };

  const [selLo, selHi] = selectionRange();
  const visual = visualAnchor != null;
  const [secLo, secHi] = visual ? [-1, -1] : sectionRange();
  const totalHeight = rowOffsets[rowOffsets.length - 1] ?? 0;
  const renderStart =
    rows.length === 0
      ? 0
      : rowAtOffset(
          rowOffsets,
          Math.max(0, viewport.top - LIST_PADDING_TOP - VIRTUAL_OVERSCAN),
        );
  const renderEnd =
    rows.length === 0
      ? 0
      : Math.min(
          rows.length,
          rowAtOffset(
            rowOffsets,
            Math.max(
              0,
              viewport.top + viewport.height - LIST_PADDING_TOP + VIRTUAL_OVERSCAN,
            ),
          ) + 1,
        );

  return (
    <div
      ref={rootRef}
      className={`buffer diff-buffer ${visual ? "is-visual" : ""}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="diff-header">
        <span className="diff-header-branch">
          {comparison ? comparisonLabel(comparison) : ""}
        </span>
        <span className="diff-header-sha">{headerRange(comparison)}</span>
        <span className="diff-header-count">
          {files.length === 0
            ? emptyLabel(comparison)
            : `${files.length} changed file${files.length === 1 ? "" : "s"}`}
        </span>
        {visual && <span className="diff-header-visual">VISUAL</span>}
        {loading && <span className="diff-header-status">refreshing…</span>}
        {error && <span className="diff-header-error">{error}</span>}
      </div>

      {isClean ? (
        <DiffCleanState />
      ) : (
      <div className="diff-list" ref={listRef} onScroll={onListScroll}>
        {renderStart > 0 && (
          <div
            className="diff-virtual-spacer"
            style={{ height: rowOffsets[renderStart] }}
          />
        )}
        {rows.slice(renderStart, renderEnd).map((row, visibleIndex) => {
          const idx = renderStart + visibleIndex;
          const selected = idx === cursor;
          const inVisual = visual && idx >= selLo && idx <= selHi;
          const inSection = !visual && idx >= secLo && idx <= secHi;
          const cls = `${selected ? "is-selected" : ""} ${
            inSection ? "is-section" : ""
          } ${inVisual ? "is-visual-sel" : ""}`;
          const ref = refForRow(row);
          if (row.kind === "section") {
            const collapsed = collapsedSections.has(row.section);
            return (
              <div
                key={row.key}
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
            const fileIgnored = ignored.some((t) => t.anchor.file === f.path);
            const fileNotes = flags.filter(
              (t) => t.anchor.file === f.path && hasNote(t),
            ).length;
            return (
              <div
                key={row.key}
                ref={ref}
                className={`diff-row diff-file-row status-${f.status} ${cls}`}
                onClick={() => setCursor(idx)}
                onDoubleClick={toggleAtCursor}
              >
                <span className="diff-caret">{f.binary ? " " : open ? "▾" : "▸"}</span>
                <span className="diff-mark">
                  {fileReviewed && <span className="mark-reviewed">✓</span>}
                  {fileFlagged && <span className="mark-flagged">⚑</span>}
                  {fileIgnored && <span className="mark-ignored">⊘</span>}
                </span>
                <span className="diff-status-glyph">{STATUS_GLYPH[f.status]}</span>
                <PathLabel className="diff-file-path" path={f.path} oldPath={f.oldPath} />
                {fileNotes > 0 && (
                  <span className="diff-file-notes" title={`${fileNotes} with a note`}>
                    ✎ {fileNotes}
                  </span>
                )}
                {f.staged === true && (
                  <span className="diff-staged-dot" title="staged">
                    ●
                  </span>
                )}
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
            const hunkIgnored = isHunkIgnored(ignored, row.file.path, row.hunk);
            const open = !collapsedHunks.has(row.hunk.id);
            return (
              <div
                key={row.key}
                ref={ref}
                className={`diff-row diff-hunk-row ${cls}`}
                onClick={() => setCursor(idx)}
                onDoubleClick={toggleAtCursor}
              >
                <span className="diff-caret">{open ? "▾" : "▸"}</span>
                <span className="diff-mark">
                  {hunkReviewed && <span className="mark-reviewed">✓</span>}
                  {hunkFlagged && <span className="mark-flagged">⚑</span>}
                  {hunkIgnored && <span className="mark-ignored">⊘</span>}
                </span>
                <span className="diff-hunk-header">{row.hunk.header}</span>
              </div>
            );
          }
          if (row.kind === "note") {
            const a = row.flag.anchor;
            const where =
              a.side === "file"
                ? "whole file"
                : a.startLine === a.endLine
                  ? `line ${a.startLine}`
                  : `lines ${a.startLine}–${a.endLine}`;
            return (
              <div
                key={row.key}
                ref={ref}
                className={`diff-row diff-note-row ${row.hunk ? "" : "is-file-note"} ${cls}`}
                onClick={() => setCursor(idx)}
                onDoubleClick={() => openNoteFor(row.flag)}
              >
                <span className="diff-note-glyph">✎</span>
                <span className="diff-note-where">
                  {where}
                  {a.side === "old" ? " (removed)" : ""}
                </span>
                <span className="diff-note-text">{row.flag.note}</span>
              </div>
            );
          }
          const line = row.line;
          // Added/context lines highlight on the new side; a pure deletion's removed
          // lines highlight on the old side.
          let lineSide: AnchorSide | null = null;
          let lineNo = 0;
          if (line.newLine != null) {
            lineSide = "new";
            lineNo = line.newLine;
          } else if (
            line.kind === "removed" &&
            line.oldLine != null &&
            isPureDeletionHunk(row.hunk)
          ) {
            lineSide = "old";
            lineNo = line.oldLine;
          }
          const lineReviewed =
            lineSide != null &&
            isLineReviewed(reviewed, row.file.path, lineNo, lineSide);
          const lineFlagged =
            lineSide != null && isLineFlagged(flags, row.file.path, lineNo, lineSide);
          const lineIgnored =
            lineSide != null && isLineIgnored(ignored, row.file.path, lineNo, lineSide);
          return (
            <div
              key={row.key}
              ref={ref}
              className={`diff-row diff-line-row line-${line.kind} ${
                lineReviewed ? "is-reviewed" : ""
              } ${lineFlagged ? "is-flagged" : ""} ${
                lineIgnored ? "is-ignored" : ""
              } ${cls}`}
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
        {renderEnd < rows.length && (
          <div
            className="diff-virtual-spacer"
            style={{ height: totalHeight - rowOffsets[renderEnd] }}
          />
        )}
      </div>
      )}
    </div>
  );
}
