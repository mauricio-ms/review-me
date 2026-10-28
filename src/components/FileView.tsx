import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM, vim } from "@replit/codemirror-vim";
import CodeMirror from "@uiw/react-codemirror";

import { swallowColonKeymap, vimEscapeKeymap } from "../editor/cm-shared";
import { diffMarks, setDiffMarks } from "../editor/diff-marks";
import { flagDecorations, setFlagLines } from "../editor/flag-decorations";
import { gruberDarkerTheme } from "../editor/gruber-darker";
import { viewerKeymap } from "../editor/viewer-keymap";
import { defineNavVim } from "../editor/vim-nav";
import { xrefClick } from "../editor/xref-click";
import { ambientSource } from "../lib/project";
import { changeBlocks, changeForFile } from "../lib/project-diff";
import {
  applyPosition,
  positionOf,
  registerFileView,
  savePosition,
  topLine,
} from "../lib/project-view";
import { useFilesStore } from "../state/files";
import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore, type VimMode } from "../state/ui";
import { useWindowStore, type FileBufferId, type WindowId } from "../state/windows";
import { sameSource } from "../types/repo";
import PathLabel from "./PathLabel";

// Identity-stable: the CodeMirror wrapper reconfigures whenever this object changes.
const BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: false,
  highlightActiveLine: true,
  highlightSelectionMatches: true,
};

const VIM_MODE_MAP: Record<string, VimMode> = {
  normal: "normal",
  insert: "insert",
  visual: "visual",
  replace: "replace",
};

/**
 * Remember where window `win` stands in `buffer` as the reader moves and scrolls, so
 * coming back to the buffer — in this window — finds the same place. A document change
 * is a re-read (a refresh), not the reader moving; it keeps the place it had.
 */
function trackPosition(win: WindowId, buffer: FileBufferId): Extension {
  let frame: number | null = null;
  const save = (view: EditorView) => {
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    savePosition(win, buffer, { line: line.number, col: head - line.from, top: topLine(view) });
  };
  return [
    EditorView.updateListener.of((update) => {
      if (update.selectionSet && !update.docChanged) save(update.view);
    }),
    EditorView.domEventHandlers({
      scroll: (_event, view) => {
        if (frame != null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          save(view);
        });
      },
    }),
  ];
}

/**
 * One window's view of a file buffer: the path line, then the file read-only in
 * CodeMirror with vim, its syntax, its changes in the comparison under review, and its
 * flags. Keyed by buffer, so each buffer gets a fresh editor that opens at the place
 * this window left it.
 */
export default function FileView({ win, bufferId }: { win: WindowId; bufferId: FileBufferId }) {
  const buffer = useFilesStore((s) => s.buffers.find((b) => b.id === bufferId));
  const diff = useRepoStore((s) => s.diff);
  const flags = useTagsStore((s) => s.flags);
  const changedOnly = useProjectStore((s) => s.filter === "changed");
  const inlineDiff = useProjectStore((s) => s.inlineDiff);
  const inlineFlipped = useProjectStore((s) => s.inlineFlipped);
  const focused = useWindowStore((s) => s.selected === win && !s.treeFocused);
  const focusRequest = useUIStore((s) => s.focusRequest);
  const setVimMode = useUIStore((s) => s.setVimMode);

  // The view exists only once CodeMirror has mounted — after this component's first
  // effects — so it's state: every effect below re-runs when it arrives.
  const [view, setView] = useState<EditorView | null>(null);
  const [langExt, setLangExt] = useState<Extension | null>(null);

  const path = buffer?.path ?? null;
  const source = buffer?.source;
  const content = buffer?.content ?? null;
  // This file's changes in the comparison on screen, as the viewer marks them.
  const change = useMemo(
    () => (source ? changeForFile(diff, source, path) : null),
    [diff, path, source],
  );
  const blocks = useMemo(() => (change ? changeBlocks(change) : []), [change]);
  // Flags anchor lines of the comparison's new side; at another revision they'd sit on
  // the wrong lines.
  const readsNewSide = !!source && sameSource(source, ambientSource(diff?.comparison).source);

  // The viewer's vim mappings (`q` quits the window) are global to vim: defined once.
  useEffect(() => {
    defineNavVim();
  }, []);

  useEffect(() => {
    if (focused) view?.focus();
  }, [focused, focusRequest, view]);

  useEffect(() => () => registerFileView(win, bufferId, null), [bufferId, win]);

  useEffect(() => {
    if (!view) return;
    const ranges = readsNewSide
      ? flags
          .filter((f) => f.anchor.file === path && !f.anchor.stale)
          .map((f) => [f.anchor.startLine, f.anchor.endLine] as [number, number])
      : [];
    view.dispatch({ effects: setFlagLines.of(ranges) });
  }, [content, flags, path, readsNewSide, view]);

  // The change marks; `content` re-pushes them onto a re-read document. Browsing only
  // the changed files, the removed lines always show — there, what went matters as
  // much as what came.
  useEffect(() => {
    if (!view) return;
    const shown = blocks.map((b) => ({
      ...b,
      shown: inlineDiff !== inlineFlipped.has(b.id),
      showRemoved: changedOnly,
    }));
    view.dispatch({ effects: setDiffMarks.of(shown) });
  }, [blocks, changedOnly, content, inlineDiff, inlineFlipped, view]);

  // A re-read replaces the whole document, which drops the cursor at its start: put it
  // back where the reader was.
  const shownContent = useRef(content);
  useEffect(() => {
    if (!view || shownContent.current === content) return;
    shownContent.current = content;
    const pos = positionOf(win, bufferId);
    if (pos) applyPosition(view, pos);
  }, [bufferId, content, view, win]);

  // Lazily load the CodeMirror language for the file, dispatched by file name
  // (extension, plus special names like Dockerfile). The Gruber Darker theme supplies
  // colors; this just supplies the grammar.
  useEffect(() => {
    setLangExt(null);
    if (!path) return;
    const name = path.split("/").pop() ?? path;
    const desc = LanguageDescription.matchFilename(languages, name);
    if (!desc) return;
    let cancelled = false;
    void desc.load().then((support) => {
      if (!cancelled) setLangExt(support);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const tracker = useMemo(() => trackPosition(win, bufferId), [bufferId, win]);
  const extensions = useMemo(() => {
    const ext = [
      vim(),
      swallowColonKeymap,
      vimEscapeKeymap,
      viewerKeymap,
      xrefClick,
      diffMarks,
      flagDecorations,
      tracker,
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
    ];
    if (langExt) ext.push(langExt);
    return ext;
  }, [langExt, tracker]);

  const onCreateEditor = useCallback(
    (created: EditorView) => {
      registerFileView(win, bufferId, created);
      applyPosition(created, positionOf(win, bufferId) ?? { line: 1, col: 0 });
      getCM(created)?.on("vim-mode-change", (e: { mode: string }) =>
        setVimMode(VIM_MODE_MAP[e.mode] ?? "normal"),
      );
      setView(created);
    },
    [bufferId, setVimMode, win],
  );

  if (!buffer) return null;

  return (
    <div className="project-viewer">
      <div className="project-viewer-path">
        <PathLabel className="project-viewer-file" path={buffer.path} />
        {change && (
          <span
            className="project-viewer-change"
            title="changed in the comparison on screen — M-x hunk shows the diff at the cursor, M-x hunks every one"
          >
            <span className="stat-add">+{change.addedLines}</span>{" "}
            <span className="stat-del">−{change.removedLines}</span>
          </span>
        )}
        {buffer.sourceLabel && (
          <span
            className="project-viewer-rev"
            title="reading a committed revision, not the working tree"
          >
            @ {buffer.sourceLabel}
          </span>
        )}
      </div>
      {content == null ? (
        <div className="project-viewer-empty">reading {buffer.path}…</div>
      ) : (
        <CodeMirror
          value={content}
          extensions={extensions}
          theme={gruberDarkerTheme}
          height="100%"
          onCreateEditor={onCreateEditor}
          basicSetup={BASIC_SETUP}
        />
      )}
    </div>
  );
}
