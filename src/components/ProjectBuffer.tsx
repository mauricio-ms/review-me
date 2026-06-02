import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { java } from "@codemirror/lang-java";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM, vim } from "@replit/codemirror-vim";
import CodeMirror from "@uiw/react-codemirror";

import { leaderKeymap, vimEscapeKeymap } from "../editor/cm-shared";
import { flagDecorations, setFlagLines } from "../editor/flag-decorations";
import { defineXrefVim } from "../editor/vim-xref";
import { openProjectFile, loadDir, toggleDir } from "../lib/project";
import { setProjectView } from "../lib/project-view";
import { useProjectStore } from "../state/project";
import { useTagsStore } from "../state/tags";
import { useUIStore, type VimMode } from "../state/ui";
import type { TreeEntry } from "../types/repo";

type Node = { entry: TreeEntry; depth: number };

const VIM_MODE_MAP: Record<string, VimMode> = {
  normal: "normal",
  insert: "insert",
  visual: "visual",
  replace: "replace",
};

function buildVisible(
  dirs: Record<string, TreeEntry[]>,
  expanded: Set<string>,
): Node[] {
  const out: Node[] = [];
  const walk = (path: string, depth: number) => {
    for (const entry of dirs[path] ?? []) {
      out.push({ entry, depth });
      if (entry.isDir && expanded.has(entry.path)) walk(entry.path, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

export default function ProjectBuffer() {
  const dirs = useProjectStore((s) => s.dirs);
  const expanded = useProjectStore((s) => s.expanded);
  const openPath = useProjectStore((s) => s.openPath);
  const content = useProjectStore((s) => s.content);
  const flags = useTagsStore((s) => s.flags);
  const activeBuffer = useUIStore((s) => s.activeBuffer);
  const focusRequest = useUIStore((s) => s.focusRequest);
  const setVimMode = useUIStore((s) => s.setVimMode);

  const treeRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [cursor, setCursor] = useState(0);
  const [focusPane, setFocusPane] = useState<"tree" | "viewer">("tree");

  const nodes = useMemo(() => buildVisible(dirs, expanded), [dirs, expanded]);

  // Register gd/gr vim mappings once.
  useEffect(() => {
    defineXrefVim();
  }, []);

  // Load the repo root the first time project mode is shown.
  useEffect(() => {
    if (activeBuffer === "project" && !dirs[""]) void loadDir("");
  }, [activeBuffer, dirs]);

  useEffect(() => {
    setCursor((c) => Math.min(Math.max(0, c), Math.max(0, nodes.length - 1)));
  }, [nodes.length]);

  // Focus the active pane when the buffer is shown / focus is requested.
  useEffect(() => {
    if (activeBuffer !== "project") return;
    if (focusPane === "tree") treeRef.current?.focus({ preventScroll: true });
    else viewRef.current?.focus();
  }, [activeBuffer, focusRequest, focusPane]);

  // Push flagged line ranges for the open file into the viewer.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const ranges = flags
      .filter((f) => f.anchor.file === openPath && !f.anchor.stale)
      .map((f) => [f.anchor.startLine, f.anchor.endLine] as [number, number]);
    view.dispatch({ effects: setFlagLines.of(ranges) });
  }, [flags, openPath, content]);

  const extensions = useMemo(() => {
    const ext = [
      vim(),
      leaderKeymap,
      vimEscapeKeymap,
      flagDecorations,
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
    ];
    if (openPath?.endsWith(".java")) ext.push(java());
    return ext;
  }, [openPath]);

  const onCreateEditor = useCallback(
    (view: EditorView) => {
      viewRef.current = view;
      setProjectView(view);
      const cm = getCM(view);
      cm?.on("vim-mode-change", (e: { mode: string }) =>
        setVimMode(VIM_MODE_MAP[e.mode] ?? "normal"),
      );
    },
    [setVimMode],
  );

  const activate = (node: Node | undefined) => {
    if (!node) return;
    if (node.entry.isDir) {
      void toggleDir(node.entry.path);
    } else {
      void openProjectFile(node.entry.path);
      setFocusPane("viewer");
    }
  };

  const collapseOrParent = (node: Node | undefined) => {
    if (!node) return;
    if (node.entry.isDir && expanded.has(node.entry.path)) {
      void toggleDir(node.entry.path);
      return;
    }
    const parent = node.entry.path.split("/").slice(0, -1).join("/");
    const idx = nodes.findIndex((n) => n.entry.path === parent);
    if (idx >= 0) setCursor(idx);
  };

  const onTreeKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        setCursor((c) => Math.min(nodes.length - 1, c + 1));
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
        break;
      case "G":
        e.preventDefault();
        setCursor(Math.max(0, nodes.length - 1));
        break;
      case "Enter":
      case "l":
      case "ArrowRight":
        e.preventDefault();
        activate(nodes[cursor]);
        break;
      case "h":
      case "ArrowLeft":
        e.preventDefault();
        collapseOrParent(nodes[cursor]);
        break;
    }
  };

  return (
    <div className="buffer project-buffer">
      <div
        ref={treeRef}
        className={`project-tree ${focusPane === "tree" ? "is-focused" : ""}`}
        tabIndex={0}
        onKeyDown={onTreeKeyDown}
        onFocus={() => setFocusPane("tree")}
      >
        {nodes.length === 0 ? (
          <div className="project-tree-empty">loading…</div>
        ) : (
          nodes.map((node, idx) => (
            <div
              key={node.entry.path}
              className={`tree-row ${idx === cursor ? "is-selected" : ""} ${
                node.entry.path === openPath ? "is-open" : ""
              }`}
              style={{ paddingLeft: 8 + node.depth * 14 }}
              onClick={() => {
                setCursor(idx);
                activate(node);
              }}
            >
              <span className="tree-icon">
                {node.entry.isDir
                  ? expanded.has(node.entry.path)
                    ? "▾"
                    : "▸"
                  : ""}
              </span>
              <span className="tree-name">{node.entry.name}</span>
            </div>
          ))
        )}
      </div>

      <div
        className="project-viewer"
        onKeyDownCapture={(e) => {
          if (e.ctrlKey && e.key === "h") {
            e.preventDefault();
            e.stopPropagation();
            setFocusPane("tree");
          }
        }}
      >
        {content == null ? (
          <div className="project-viewer-empty">
            <div className="empty-title">no file open</div>
            <div className="empty-hint">
              Select a file in the tree, or press <kbd>Space</kbd> <kbd>f</kbd> to
              fuzzy-find. <kbd>Ctrl</kbd>+<kbd>h</kbd> returns to the tree.
            </div>
          </div>
        ) : (
          <>
            <div className="project-viewer-path">{openPath}</div>
            <CodeMirror
              value={content}
              extensions={extensions}
              theme="dark"
              height="100%"
              onCreateEditor={onCreateEditor}
              basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                highlightActiveLine: true,
                highlightSelectionMatches: true,
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
