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
import { defineNavVim } from "../editor/vim-nav";
import { viewerKeymap } from "../editor/viewer-keymap";
import { xrefClick } from "../editor/xref-click";
import { fileReviewState } from "../lib/coverage";
import { fileIcon } from "../lib/file-icons";
import { recordJump } from "../lib/jumps";
import { dispatchKey, type KeyHandler } from "../lib/key-dispatch";
import { KEYMAP, type TreeAction } from "../lib/keymap";
import {
  backToDiff,
  loadDir,
  openFileFromDiff,
  openProjectFile,
  toggleDir,
} from "../lib/project";
import { changeBlocks, changeForOpenFile } from "../lib/project-diff";
import { setProjectView } from "../lib/project-view";
import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore, type VimMode } from "../state/ui";
import type { ChangedFile } from "../types/diff";
import type { TreeEntry } from "../types/repo";

/** A tree row; `change` is set on the files of the changed-files view. */
type Node = { entry: TreeEntry; depth: number; change?: ChangedFile };

const EMPTY_FILES: ChangedFile[] = [];

const STATUS_GLYPH: Record<ChangedFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

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

/** Case-insensitive name order — the backend's `tree::list_dir` sort. */
function byName(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The changed-files view: a tree synthesized from the comparison's own paths (it has
 * every file it needs, so nothing is listed from disk), folders first and open unless
 * the reviewer folded them.
 */
function buildChanged(files: ChangedFile[], collapsed: Set<string>): Node[] {
  type Dir = { dirs: Map<string, Dir>; files: ChangedFile[] };
  const root: Dir = { dirs: new Map(), files: [] };
  for (const file of files) {
    let dir = root;
    for (const part of file.path.split("/").slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push(file);
  }
  const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const out: Node[] = [];
  const walk = (dir: Dir, prefix: string, depth: number) => {
    for (const [dirName, child] of [...dir.dirs].sort(([a], [b]) => byName(a, b))) {
      const path = prefix ? `${prefix}/${dirName}` : dirName;
      out.push({ entry: { name: dirName, path, isDir: true }, depth });
      if (!collapsed.has(path)) walk(child, path, depth + 1);
    }
    for (const file of [...dir.files].sort((a, b) => byName(name(a.path), name(b.path)))) {
      out.push({
        entry: { name: name(file.path), path: file.path, isDir: false },
        depth,
        change: file,
      });
    }
  };
  walk(root, "", 0);
  return out;
}

export default function ProjectBuffer() {
  const dirs = useProjectStore((s) => s.dirs);
  const expanded = useProjectStore((s) => s.expanded);
  const openPath = useProjectStore((s) => s.openPath);
  const content = useProjectStore((s) => s.content);
  // Non-null while the buffer is reading a commit rather than the working tree.
  const sourceLabel = useProjectStore((s) => s.sourceLabel);
  const filter = useProjectStore((s) => s.filter);
  const toggleFilter = useProjectStore((s) => s.toggleFilter);
  const diff = useRepoStore((s) => s.diff);
  const changedFiles = diff?.files ?? EMPTY_FILES;
  const source = useProjectStore((s) => s.source);
  const inlineDiff = useProjectStore((s) => s.inlineDiff);
  const inlineFlipped = useProjectStore((s) => s.inlineFlipped);
  const clearFlipped = useProjectStore((s) => s.clearFlipped);
  // Which half has the keyboard; `C-x o` swaps them.
  const focusPane = useProjectStore((s) => s.pane);
  const setFocusPane = useProjectStore((s) => s.setPane);
  const comparisonEpoch = useRepoStore((s) => s.comparisonEpoch);
  const reviewed = useTagsStore((s) => s.reviewed);
  const flags = useTagsStore((s) => s.flags);
  const ignored = useTagsStore((s) => s.ignored);
  const activeBuffer = useUIStore((s) => s.activeBuffer);
  const focusRequest = useUIStore((s) => s.focusRequest);
  const setVimMode = useUIStore((s) => s.setVimMode);

  const treeRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [cursor, setCursor] = useState(0);
  const [langExt, setLangExt] = useState<Extension | null>(null);
  // Folders folded in the changed-files view — open by default, so every changed file
  // shows at once. Folds belong to one comparison.
  const [collapsedChanged, setCollapsedChanged] = useState<Set<string>>(() => new Set());
  const changedOnly = filter === "changed";

  useEffect(() => {
    setCollapsedChanged(new Set());
    clearFlipped();
  }, [clearFlipped, comparisonEpoch]);

  // The open file's changes in the comparison on screen, as the viewer marks them.
  const openChange = useMemo(
    () => changeForOpenFile(diff, source, openPath),
    [diff, openPath, source],
  );
  const blocks = useMemo(() => (openChange ? changeBlocks(openChange) : []), [openChange]);

  const nodes = useMemo(
    () =>
      changedOnly
        ? buildChanged(changedFiles, collapsedChanged)
        : buildVisible(dirs, expanded),
    [changedOnly, changedFiles, collapsedChanged, dirs, expanded],
  );

  const isOpenDir = (path: string) =>
    changedOnly ? !collapsedChanged.has(path) : expanded.has(path);

  const toggleFolder = (path: string) => {
    if (!changedOnly) {
      void toggleDir(path);
      return;
    }
    setCollapsedChanged((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // Switching views keeps the cursor on the open file when the new list has it.
  useEffect(() => {
    const at = openPath ? nodes.findIndex((n) => n.entry.path === openPath) : -1;
    setCursor(Math.max(0, at));
    // Only on a switch: `nodes` also changes on every fold, where the cursor stays put.
  }, [changedOnly]);

  // Register the project viewer's vim mappings once (q→diff). Code navigation is an
  // Alt keymap instead — see editor/viewer-keymap.ts.
  useEffect(() => {
    defineNavVim();
  }, []);

  // Load the repo root the first time the full tree is shown.
  useEffect(() => {
    if (activeBuffer === "project" && !changedOnly && !dirs[""]) void loadDir("");
  }, [activeBuffer, changedOnly, dirs]);

  useEffect(() => {
    setCursor((c) => Math.min(Math.max(0, c), Math.max(0, nodes.length - 1)));
  }, [nodes.length]);

  // Focus the active pane when the buffer is shown / focus is requested.
  useEffect(() => {
    if (activeBuffer !== "project") return;
    if (focusPane === "tree") treeRef.current?.focus({ preventScroll: true });
    else if (viewRef.current) viewRef.current.focus();
    // No file open: there is no viewer to hand the keyboard to.
    else setFocusPane("tree");
  }, [activeBuffer, focusRequest, focusPane, setFocusPane]);

  // Push flagged line ranges for the open file into the viewer.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const ranges = flags
      .filter((f) => f.anchor.file === openPath && !f.anchor.stale)
      .map((f) => [f.anchor.startLine, f.anchor.endLine] as [number, number]);
    view.dispatch({ effects: setFlagLines.of(ranges) });
  }, [flags, openPath, content]);

  // Push the open file's change marks into the viewer; `content` re-pushes them onto a
  // freshly loaded document. Browsing only the changed files, the removed lines always
  // show — there, what went matters as much as what came.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const shown = blocks.map((b) => ({
      ...b,
      shown: inlineDiff !== inlineFlipped.has(b.id),
      showRemoved: changedOnly,
    }));
    view.dispatch({ effects: setDiffMarks.of(shown) });
  }, [blocks, changedOnly, content, inlineDiff, inlineFlipped, openPath]);

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
      swallowColonKeymap,
      vimEscapeKeymap,
      viewerKeymap,
      xrefClick,
      diffMarks,
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
      toggleFolder(node.entry.path);
    } else if (node.change) {
      // At the revision that changed it — the old side for a deletion, the only one
      // that still has it. Records the jump itself.
      void openFileFromDiff(
        node.change.path,
        node.change.status === "deleted" ? "old" : "new",
      );
      setFocusPane("viewer");
    } else {
      // Opening from the tree is navigation too — `M-,` should walk back through it.
      recordJump();
      void openProjectFile(node.entry.path);
      setFocusPane("viewer");
    }
  };

  const collapseOrParent = (node: Node | undefined) => {
    if (!node) return;
    if (node.entry.isDir && isOpenDir(node.entry.path)) {
      toggleFolder(node.entry.path);
      return;
    }
    const parent = node.entry.path.split("/").slice(0, -1).join("/");
    const idx = nodes.findIndex((n) => n.entry.path === parent);
    if (idx >= 0) setCursor(idx);
  };

  const treeHandlers: Record<TreeAction, KeyHandler> = {
    down: () => setCursor((c) => Math.min(nodes.length - 1, c + 1)),
    up: () => setCursor((c) => Math.max(0, c - 1)),
    first: () => setCursor(0),
    last: () => setCursor(Math.max(0, nodes.length - 1)),
    // Fold the folder under the cursor (no-op on files).
    toggle: () => {
      const node = nodes[cursor];
      if (node?.entry.isDir) toggleFolder(node.entry.path);
    },
    open: () => activate(nodes[cursor]),
    close: () => collapseOrParent(nodes[cursor]),
    // The whole revision ↔ only what the comparison on screen changed.
    filter: toggleFilter,
    quit: backToDiff,
  };

  const onTreeKeyDown = (e: React.KeyboardEvent) => {
    dispatchKey("tree", e, KEYMAP.tree, treeHandlers);
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
        <div className="project-tree-mode">
          <span>
            {changedOnly
              ? `changed · ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}`
              : "all files"}
          </span>
          <span className="project-tree-mode-hint">
            <kbd>c</kbd> {changedOnly ? "all files" : "changed only"}
          </span>
        </div>
        {nodes.length === 0 ? (
          <div className="project-tree-empty">
            {changedOnly ? "nothing changed here" : "loading…"}
          </div>
        ) : (
          nodes.map((node, idx) => {
            const icon = fileIcon(
              node.entry.name,
              node.entry.isDir,
              isOpenDir(node.entry.path),
            );
            const change = node.change;
            const review = change
              ? fileReviewState(reviewed, flags, ignored, change)
              : null;
            return (
              <div
                key={node.entry.path}
                className={`tree-row ${idx === cursor ? "is-selected" : ""} ${
                  node.entry.path === openPath ? "is-open" : ""
                }${change ? ` status-${change.status}` : ""}`}
                style={{ paddingLeft: 8 + node.depth * 14 }}
                title={change?.oldPath ? `renamed from ${change.oldPath}` : undefined}
                onClick={() => {
                  setCursor(idx);
                  activate(node);
                }}
              >
                <span className="tree-icon" style={{ color: icon.color }}>
                  {icon.glyph}
                </span>
                <span className="tree-name">{node.entry.name}</span>
                {change && (
                  <span className="tree-change">
                    {review === "flagged" && <span className="mark-flagged">⚑</span>}
                    {review === "done" && <span className="mark-reviewed">✓</span>}
                    <span className="diff-status-glyph">{STATUS_GLYPH[change.status]}</span>
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="project-viewer" onFocus={() => setFocusPane("viewer")}>
        {content == null ? (
          <div className="project-viewer-empty">
            <div className="empty-title">
              no file open{sourceLabel ? ` — ${sourceLabel}` : ""}
            </div>
            <div className="empty-hint">
              Select a file in the tree, or <kbd>C-x C-f</kbd> to find one;{" "}
              <kbd>c</kbd> in the tree lists only the changed files. <kbd>C-x o</kbd>{" "}
              switches between the tree and the viewer; <kbd>q</kbd> returns to the diff.
            </div>
          </div>
        ) : (
          <>
            <div className="project-viewer-path">
              <span className="project-viewer-file">{openPath}</span>
              {openChange && (
                <span
                  className="project-viewer-change"
                  title="changed in the comparison on screen — M-x hunk shows the diff at the cursor, M-x hunks every one"
                >
                  <span className="stat-add">+{openChange.addedLines}</span>{" "}
                  <span className="stat-del">−{openChange.removedLines}</span>
                </span>
              )}
              {sourceLabel && (
                <span
                  className="project-viewer-rev"
                  title="reading a committed revision, not the working tree"
                >
                  @ {sourceLabel}
                </span>
              )}
            </div>
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
