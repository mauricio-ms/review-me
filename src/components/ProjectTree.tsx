import { useEffect, useMemo, useRef, useState } from "react";

import { fileReviewState } from "../lib/coverage";
import { showDiff, useCurrentFile, type ShowOptions } from "../lib/buffers";
import { buildChanged, type TreeNode as Node } from "../lib/changed-tree";
import { fileIcon } from "../lib/file-icons";
import { dispatchKey, type KeyHandler } from "../lib/key-dispatch";
import { KEYMAP, type TreeAction } from "../lib/keymap";
import {
  loadDir,
  openFileFromDiff,
  openFileInProject,
  previewFile,
  projectChoice,
  sideChoice,
  toggleDir,
} from "../lib/project";
import { flagFile, ignoreFile, reviewFile, unmarkFile } from "../lib/project-review";
import { TREE_WIDTH_MIN, useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore } from "../state/ui";
import { useWindowStore } from "../state/windows";
import type { ChangedFile } from "../types/diff";
import type { TreeEntry } from "../types/repo";


const EMPTY_FILES: ChangedFile[] = [];

/** However wide the tree is set, the windows keep at least this much. */
const WINDOWS_MIN_WIDTH = 320;

/** How long the cursor rests on a file before it's previewed: holding `j` reads nothing. */
const PREVIEW_DELAY_MS = 60;

/** Where a changed file is read: the old side for a deletion, the only one that has it. */
const sideOf = (change: ChangedFile) => (change.status === "deleted" ? "old" : "new");

/**
 * A tree row's name. A compacted chain (`java/com/acme`) dims its leading folders and,
 * when it doesn't fit, gives up its start rather than its last folder.
 */
function TreeName({ name }: { name: string }) {
  const cut = name.lastIndexOf("/") + 1;
  if (cut === 0) return <span className="tree-name">{name}</span>;
  return (
    <span className="tree-name is-chain" title={name}>
      <bdi>
        <span className="path-dir">{name.slice(0, cut)}</span>
        {name.slice(cut)}
      </bdi>
    </span>
  );
}

const STATUS_GLYPH: Record<ChangedFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
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

/**
 * The file tree, fixed at the left of project mode (`inProjectMode`: the main window
 * shows a file, or you're in the tree) and hidden everywhere else: the revision under
 * review, or only the files its comparison changed (`c`). The file under the cursor — moved
 * to, or clicked — is previewed in the selected window while the tree keeps the keyboard;
 * opening one (`RET`, a double-click, or going into the preview) shows it there for good.
 * `C-x o` moves between the tree and the windows.
 */
export default function ProjectTree({ hidden }: { hidden: boolean }) {
  const dirs = useProjectStore((s) => s.dirs);
  const expanded = useProjectStore((s) => s.expanded);
  const filter = useProjectStore((s) => s.filter);
  const toggleFilter = useProjectStore((s) => s.toggleFilter);
  const diff = useRepoStore((s) => s.diff);
  const changedFiles = diff?.files ?? EMPTY_FILES;
  const storedTreeWidth = useProjectStore((s) => s.treeWidth);
  const setTreeWidth = useProjectStore((s) => s.setTreeWidth);
  const comparisonEpoch = useRepoStore((s) => s.comparisonEpoch);
  const reviewed = useTagsStore((s) => s.reviewed);
  const flags = useTagsStore((s) => s.flags);
  const ignored = useTagsStore((s) => s.ignored);
  const focused = useWindowStore((s) => s.treeFocused);
  const setTreeFocused = useWindowStore((s) => s.setTreeFocused);
  const focusRequest = useUIStore((s) => s.focusRequest);
  // The file in the selected window — where the tree opens files — is marked open.
  const openPath = useCurrentFile()?.path ?? null;

  const treeRef = useRef<HTMLDivElement | null>(null);
  // Never wider than leaves the windows a usable width: a width set on a wide window
  // shrinks with a narrow one, without forgetting what was chosen.
  const [frameWidth, setFrameWidth] = useState(0);
  useEffect(() => {
    const frame = treeRef.current?.parentElement;
    if (!frame) return;
    const observer = new ResizeObserver(() => setFrameWidth(frame.clientWidth));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  const treeWidth =
    frameWidth > 0
      ? Math.max(TREE_WIDTH_MIN, Math.min(storedTreeWidth, frameWidth - WINDOWS_MIN_WIDTH))
      : storedTreeWidth;

  // Drag the tree's edge; the width is remembered once the drag ends.
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const tree = treeRef.current;
    if (!tree) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const left = tree.getBoundingClientRect().left;
    let width = treeWidth;
    const move = (ev: PointerEvent) => {
      width = ev.clientX - left;
      setTreeWidth(width);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      setTreeWidth(width, true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const [cursor, setCursor] = useState(0);
  // Folders folded in the changed-files view — open by default, so every changed file
  // shows at once. Folds belong to one comparison.
  const [collapsedChanged, setCollapsedChanged] = useState<Set<string>>(() => new Set());
  const changedOnly = filter === "changed";

  useEffect(() => {
    setCollapsedChanged(new Set());
  }, [comparisonEpoch]);

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

  // Load the repo root the first time the full tree is shown.
  useEffect(() => {
    if (!hidden && !changedOnly && !dirs[""]) void loadDir("");
  }, [changedOnly, dirs, hidden]);

  useEffect(() => {
    setCursor((c) => Math.min(Math.max(0, c), Math.max(0, nodes.length - 1)));
  }, [nodes.length]);

  useEffect(() => {
    if (focused) treeRef.current?.focus({ preventScroll: true });
  }, [focused, focusRequest]);

  // Show the file at the cursor where opening it would — now, or once the cursor has
  // rested on it. On a folder, the last file previewed stays.
  const previewTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(previewTimer.current), []);
  const preview = (node: Node | undefined, delay = 0) => {
    window.clearTimeout(previewTimer.current);
    if (!node || node.entry.isDir) return;
    const show = () => {
      if (node.change) void previewFile(node.change.path, sideChoice(sideOf(node.change)));
      else void previewFile(node.entry.path, projectChoice());
    };
    if (delay > 0) previewTimer.current = window.setTimeout(show, delay);
    else show();
  };

  const moveTo = (idx: number) => {
    const next = Math.max(0, Math.min(idx, nodes.length - 1));
    setCursor(next);
    preview(nodes[next], PREVIEW_DELAY_MS);
  };

  const activate = (node: Node | undefined, options: ShowOptions = {}) => {
    if (!node) return;
    window.clearTimeout(previewTimer.current);
    if (node.entry.isDir) {
      toggleFolder(node.entry.path);
    } else if (node.change) {
      openFileFromDiff(node.change.path, sideOf(node.change), undefined, options);
    } else {
      openFileInProject(node.entry.path, options);
    }
  };

  const collapseOrParent = (node: Node | undefined) => {
    if (!node) return;
    if (node.entry.isDir && isOpenDir(node.entry.path)) {
      toggleFolder(node.entry.path);
      return;
    }
    // The parent row may be a compacted chain (`java/com/acme`): climb until a row
    // names one of this path's ancestors.
    let parent = node.entry.path;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      const idx = nodes.findIndex((n) => n.entry.path === parent);
      if (idx >= 0) {
        moveTo(idx);
        return;
      }
    }
  };

  // `r` `f` `i` `u` mark the file at the cursor — in either view, so by its path.
  const markFile = (mark: (path: string) => Promise<void>) => () => {
    const node = nodes[cursor];
    if (!node || node.entry.isDir) {
      useUIStore.getState().showFlash("Not on a file");
      return;
    }
    void mark(node.change?.path ?? node.entry.path);
  };

  const handlers: Record<TreeAction, KeyHandler> = {
    down: () => moveTo(cursor + 1),
    up: () => moveTo(cursor - 1),
    first: () => moveTo(0),
    last: () => moveTo(nodes.length - 1),
    // Fold the folder under the cursor (no-op on files).
    toggle: () => {
      const node = nodes[cursor];
      if (node?.entry.isDir) toggleFolder(node.entry.path);
    },
    open: () => activate(nodes[cursor]),
    "open-other": () => activate(nodes[cursor], { other: true }),
    close: () => collapseOrParent(nodes[cursor]),
    // The whole revision ↔ only what the comparison on screen changed.
    filter: toggleFilter,
    review: markFile(reviewFile),
    flag: markFile(flagFile),
    ignore: markFile(ignoreFile),
    unmark: markFile(unmarkFile),
    quit: () => showDiff(),
  };

  return (
    <>
      <div
        ref={treeRef}
        className={`project-tree ${focused ? "is-focused" : ""}`}
        style={{ width: treeWidth, display: hidden ? "none" : undefined }}
        tabIndex={0}
        onKeyDown={(e) => dispatchKey("tree", e, KEYMAP.tree, handlers)}
        onFocus={() => setTreeFocused(true)}
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
                style={{ paddingLeft: `calc(8px + ${node.depth} * 1.2ch)` }}
                title={change?.oldPath ? `renamed from ${change.oldPath}` : undefined}
                // A click picks the row — a folder folds, a file is previewed — and the
                // keyboard stays in the tree; a double-click opens the file.
                onClick={() => {
                  setCursor(idx);
                  if (node.entry.isDir) toggleFolder(node.entry.path);
                  else preview(node);
                }}
                onDoubleClick={() => {
                  if (!node.entry.isDir) activate(node);
                }}
              >
                <span className="tree-icon" style={{ color: icon.color }}>
                  {icon.glyph}
                </span>
                <TreeName name={node.entry.name} />
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
      <div
        className="project-split"
        style={hidden ? { display: "none" } : undefined}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the file tree"
        aria-valuenow={treeWidth}
        onPointerDown={startResize}
      />
    </>
  );
}
