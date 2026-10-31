import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

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
  toggleChangedOnly,
  toggleDir,
} from "../lib/project";
import { flagFile, ignoreFile, reviewFile, unmarkFile } from "../lib/project-review";
import { foldersAbove, TREE_WIDTH_MIN, useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore } from "../state/ui";
import { useWindowStore } from "../state/windows";
import type { ChangedFile } from "../types/diff";
import type { ProjectSource, TreeEntry } from "../types/repo";


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

/** A revision as a cache key. */
const sourceKey = (source: ProjectSource) => (source.kind === "commit" ? source.oid : "worktree");

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
 * review, or only the files its comparison changed (`c`) — the same folders open in both.
 * The file under the cursor — moved to, or clicked — is previewed in the selected window
 * while the tree keeps the keyboard; opening one (`RET`, a double-click, or going into the
 * preview) shows it there for good. `C-x o` moves between the tree and the windows.
 */
export default function ProjectTree({ hidden }: { hidden: boolean }) {
  const dirs = useProjectStore((s) => s.dirs);
  const expanded = useProjectStore((s) => s.expanded);
  const filter = useProjectStore((s) => s.filter);
  const source = useProjectStore((s) => s.source);
  const treeCursor = useProjectStore((s) => s.treeCursor);
  const setTreeCursor = useProjectStore((s) => s.setTreeCursor);
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

  const changedOnly = filter === "changed";

  // The changed view's folders open as they first appear, so every changed file shows at
  // once; after that they're the reviewer's to fold. Which have appeared is per comparison.
  const seeded = useRef({ epoch: -1, folders: new Set<string>() });
  useLayoutEffect(() => {
    if (!changedOnly) return;
    if (seeded.current.epoch !== comparisonEpoch) {
      seeded.current = { epoch: comparisonEpoch, folders: new Set() };
    }
    const { folders } = seeded.current;
    const fresh = [...new Set(changedFiles.flatMap((f) => foldersAbove(f.path)))].filter(
      (dir) => !folders.has(dir),
    );
    if (fresh.length === 0) return;
    for (const dir of fresh) folders.add(dir);
    useProjectStore.getState().openFolders(fresh);
  }, [changedOnly, changedFiles, comparisonEpoch]);

  const nodes = useMemo(
    () =>
      changedOnly
        ? buildChanged(changedFiles, (path) => expanded.has(path))
        : buildVisible(dirs, expanded),
    [changedOnly, changedFiles, dirs, expanded],
  );

  // The cursor's row — or, while that isn't shown (folded away, or not listed yet), the
  // nearest folder above it that is.
  const cursor = useMemo(() => {
    for (let path = treeCursor; path; ) {
      const idx = nodes.findIndex((n) => n.entry.path === path);
      if (idx >= 0) return idx;
      const cut = path.lastIndexOf("/");
      path = cut > 0 ? path.slice(0, cut) : null;
    }
    return 0;
  }, [nodes, treeCursor]);
  const setCursor = (idx: number) => setTreeCursor(nodes[idx]?.entry.path ?? null);

  const toggleFolder = (path: string) => {
    if (!changedOnly) {
      void toggleDir(path);
      return;
    }
    // The changed view lists nothing from disk: its folders just open and close.
    const ps = useProjectStore.getState();
    if (ps.expanded.has(path)) ps.closeFolder(path);
    else ps.openFolders([path]);
  };

  // The full tree reads what it reaches — the root, then every open folder not listed yet,
  // a level at a time — so folders opened in the changed view, or kept open across a
  // change of revision, fill in.
  const unlisted = useMemo(() => {
    if (changedOnly) return [];
    if (!dirs[""]) return [""];
    return nodes
      .filter((n) => n.entry.isDir && expanded.has(n.entry.path) && !dirs[n.entry.path])
      .map((n) => n.entry.path);
  }, [changedOnly, dirs, expanded, nodes]);
  const listing = useRef(new Set<string>());
  useEffect(() => {
    if (hidden) return;
    for (const path of unlisted) {
      const key = `${sourceKey(source)}:${path}`;
      if (listing.current.has(key)) continue;
      listing.current.add(key);
      // A folder that can't be read stays empty; the next listing to arrive retries it.
      void loadDir(path)
        .catch(() => {})
        .finally(() => listing.current.delete(key));
    }
  }, [hidden, source, unlisted]);

  useEffect(() => {
    if (focused) treeRef.current?.focus({ preventScroll: true });
  }, [focused, focusRequest]);

  // Keep the cursor's row in view, clear of the mode line stuck at the top.
  useEffect(() => {
    const tree = treeRef.current;
    const row = tree?.querySelector<HTMLElement>(".tree-row.is-selected");
    if (!tree || !row || hidden) return;
    const mode = tree.querySelector<HTMLElement>(".project-tree-mode");
    const head = mode ? mode.offsetHeight + parseFloat(getComputedStyle(mode).marginBottom) : 0;
    const box = tree.getBoundingClientRect();
    const at = row.getBoundingClientRect();
    const top = box.top + head;
    const bottom = box.top + tree.clientHeight;
    if (at.top < top) tree.scrollTop -= top - at.top;
    else if (at.bottom > bottom) tree.scrollTop += at.bottom - bottom;
  }, [cursor, hidden, nodes]);

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
    if (node.entry.isDir && expanded.has(node.entry.path)) {
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
    filter: toggleChangedOnly,
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
              expanded.has(node.entry.path),
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
