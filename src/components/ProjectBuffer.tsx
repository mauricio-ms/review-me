import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM, vim } from "@replit/codemirror-vim";
import CodeMirror from "@uiw/react-codemirror";

import { leaderKeymap, vimEscapeKeymap } from "../editor/cm-shared";
import { flagDecorations, setFlagLines } from "../editor/flag-decorations";
import { gruberDarkerTheme } from "../editor/gruber-darker";
import { defineNavVim } from "../editor/vim-nav";
import { defineXrefVim } from "../editor/vim-xref";
import { xrefClick } from "../editor/xref-click";
import { fileIcon } from "../lib/file-icons";
import { backToDiff, openProjectFile, loadDir, toggleDir } from "../lib/project";
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
  const [langExt, setLangExt] = useState<Extension | null>(null);

  const nodes = useMemo(() => buildVisible(dirs, expanded), [dirs, expanded]);

  // Register the project viewer's vim mappings once (gd/gr, q→diff).
  useEffect(() => {
    defineXrefVim();
    defineNavVim();
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

  // Lazily load the CodeMirror language for the open file, dispatched by file
  // name (extension, plus special names like Dockerfile). The Gruber Darker
  // theme supplies colors; this just supplies the grammar.
  useEffect(() => {
    setLangExt(null);
    if (!openPath) return;
    const name = openPath.split("/").pop() ?? openPath;
    const desc = LanguageDescription.matchFilename(languages, name);
    if (!desc) return;
    let cancelled = false;
    void desc.load().then((support) => {
      if (!cancelled) setLangExt(support);
    });
    return () => {
      cancelled = true;
    };
  }, [openPath]);

  const extensions = useMemo(() => {
    const ext = [
      vim(),
      leaderKeymap,
      vimEscapeKeymap,
      xrefClick,
      flagDecorations,
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
    ];
    if (langExt) ext.push(langExt);
    return ext;
  }, [langExt]);

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
      case "Tab": {
        // Toggle the folder under the cursor (no-op on files).
        e.preventDefault();
        const node = nodes[cursor];
        if (node?.entry.isDir) void toggleDir(node.entry.path);
        break;
      }
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
      case "q":
        e.preventDefault();
        backToDiff();
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
          nodes.map((node, idx) => {
            const icon = fileIcon(
              node.entry.name,
              node.entry.isDir,
              expanded.has(node.entry.path),
            );
            return (
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
                <span className="tree-icon" style={{ color: icon.color }}>
                  {icon.glyph}
                </span>
                <span className="tree-name">{node.entry.name}</span>
              </div>
            );
          })
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
              fuzzy-find. <kbd>Ctrl</kbd>+<kbd>h</kbd> returns to the tree;{" "}
              <kbd>q</kbd> returns to the diff.
            </div>
          </div>
        ) : (
          <>
            <div className="project-viewer-path">{openPath}</div>
            <CodeMirror
              value={content}
              extensions={extensions}
              theme={gruberDarkerTheme}
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
