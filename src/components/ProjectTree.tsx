import { useEffect, useMemo, useRef, useState } from "react";

import { fileReviewState } from "../lib/coverage";
import { useCurrentFile, type ShowOptions } from "../lib/buffers";
import { fileIcon } from "../lib/file-icons";
import { dispatchKey, type KeyHandler } from "../lib/key-dispatch";
import { KEYMAP, type TreeAction } from "../lib/keymap";
import { loadDir, openFileFromDiff, openFileInProject, toggleDir } from "../lib/project";
import { TREE_WIDTH_MIN, useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore } from "../state/ui";
import { useWindowStore } from "../state/windows";
import type { ChangedFile } from "../types/diff";
import type { TreeEntry } from "../types/repo";

/** A tree row; `change` is set on the files of the changed-files view. */
type Node = { entry: TreeEntry; depth: number; change?: ChangedFile };

const EMPTY_FILES: ChangedFile[] = [];

/** However wide the tree is set, the windows keep at least this much. */
const WINDOWS_MIN_WIDTH = 320;

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
    for (const [dirName, first] of [...dir.dirs].sort(([a], [b]) => byName(a, b))) {
      // A folder holding just one folder is one row (`java/com/acme`), as the full
      // listing compacts it (`tree::list_dir`).
      let child = first;
      let label = dirName;
      let path = prefix ? `${prefix}/${dirName}` : dirName;
      while (child.files.length === 0 && child.dirs.size === 1) {
        const [[innerName, inner]] = [...child.dirs];
        label = `${label}/${innerName}`;
        path = `${path}/${innerName}`;
        child = inner;
      }
      out.push({ entry: { name: label, path, isDir: true }, depth });
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

/**
 * The file tree, a sidebar beside every window (treemacs-style): the revision under
 * review, or only the files its comparison changed (`c`). Opening a file shows it in
 * the selected window; `C-x o` moves between the tree and the windows.
 */
export default function ProjectTree() {
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
    if (!changedOnly && !dirs[""]) void loadDir("");
  }, [changedOnly, dirs]);

  useEffect(() => {
    setCursor((c) => Math.min(Math.max(0, c), Math.max(0, nodes.length - 1)));
  }, [nodes.length]);

  useEffect(() => {
    if (focused) treeRef.current?.focus({ preventScroll: true });
  }, [focused, focusRequest]);

  const activate = (node: Node | undefined, options: ShowOptions = {}) => {
    if (!node) return;
    if (node.entry.isDir) {
      toggleFolder(node.entry.path);
    } else if (node.change) {
      // At the revision that changed it — the old side for a deletion, the only one
      // that still has it.
      openFileFromDiff(
        node.change.path,
        node.change.status === "deleted" ? "old" : "new",
        undefined,
        options,
      );
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
        setCursor(idx);
        return;
      }
    }
  };

  const handlers: Record<TreeAction, KeyHandler> = {
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
    "open-other": () => activate(nodes[cursor], { other: true }),
    close: () => collapseOrParent(nodes[cursor]),
    // The whole revision ↔ only what the comparison on screen changed.
    filter: toggleFilter,
    // Back to the window the tree opens files in.
    quit: () => {
      setTreeFocused(false);
      useUIStore.getState().requestFocus();
    },
  };

  return (
    <>
      <div
        ref={treeRef}
        className={`project-tree ${focused ? "is-focused" : ""}`}
        style={{ width: treeWidth }}
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
                onClick={() => {
                  setCursor(idx);
                  activate(node);
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
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the file tree"
        aria-valuenow={treeWidth}
        onPointerDown={startResize}
      />
    </>
  );
}
