import { useCallback, useEffect, useMemo, useState } from "react";

import { fileIcon } from "../lib/file-icons";
import { openFileFromDiff, openFileInProject } from "../lib/project";
import { fuzzyFiles } from "../lib/tauri";
import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import type { ChangedFile } from "../types/diff";
import type { FileMatch } from "../types/repo";
import NeoPicker from "./NeoPicker";

const LIMIT = 60;

const EMPTY_FILES: ChangedFile[] = [];

/** Render a path with the fuzzy-matched characters emphasized. */
function highlight(path: string, indices: number[]) {
  if (indices.length === 0) return path;
  const hit = new Set(indices);
  return [...path].map((ch, i) =>
    hit.has(i) ? (
      <b key={i} className="fz-hit">
        {ch}
      </b>
    ) : (
      <span key={i}>{ch}</span>
    ),
  );
}

export default function FuzzyFinderHost() {
  const open = useUIStore((s) => s.picker === "fuzzyFiles");
  const closePicker = useUIStore((s) => s.closePicker);
  const requestFocus = useUIStore((s) => s.requestFocus);
  const repoPath = useRepoStore((s) => s.repoPath);
  // The finder searches the revision project mode is showing, not always the disk.
  const source = useProjectStore((s) => s.source);
  // ...and, like the tree, only the comparison's changed files when it lists those.
  const changedOnly = useProjectStore((s) => s.filter === "changed");
  const changedFiles = useRepoStore((s) => s.diff?.files ?? EMPTY_FILES);
  const changedByPath = useMemo(
    () => new Map(changedFiles.map((f) => [f.path, f])),
    [changedFiles],
  );
  const only = useMemo(
    () => (changedOnly ? [...changedByPath.keys()] : null),
    [changedOnly, changedByPath],
  );

  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<FileMatch[]>([]);

  // Debounced fuzzy query against the backend (the "content filter differs" case).
  useEffect(() => {
    if (!open || !repoPath) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void fuzzyFiles(repoPath, source, query, LIMIT, only).then((matches) => {
        if (!cancelled) setRows(matches);
      });
    }, 70);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [only, open, query, repoPath, source]);

  // Reset when reopened.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const close = useCallback(() => {
    closePicker();
    requestFocus();
  }, [closePicker, requestFocus]);

  const openSelected = useCallback(
    (row: FileMatch) => {
      const change = only ? changedByPath.get(row.path) : undefined;
      // A changed file opens where the tree would open it: a deletion on the old side.
      if (change) {
        void openFileFromDiff(change.path, change.status === "deleted" ? "old" : "new");
      } else {
        void openFileInProject(row.path);
      }
      closePicker();
    },
    [changedByPath, closePicker, only],
  );

  if (!open) return null;

  return (
    <NeoPicker<FileMatch>
      open={open}
      title={only ? "Find changed file" : "Find file"}
      className="fuzzy-finder"
      query={query}
      onQueryChange={setQuery}
      placeholder="fuzzy file name…"
      rows={rows}
      rowKey={(row) => row.path}
      rowClassName={() => "fz-row"}
      onActivate={(row) => openSelected(row)}
      onClose={close}
      renderCount={(s, t) => (t === 0 ? "0" : `${s + 1}/${t}`)}
      footer="↑↓ move · ↵ open · Esc cancel"
      emptyText={only && only.length === 0 ? "nothing changed here" : "no matching files"}
      renderRow={(row) => {
        const icon = fileIcon(row.path.split("/").pop() ?? row.path, false);
        return (
          <>
            <span className="neo-icon" style={{ color: icon.color }}>
              {icon.glyph}
            </span>
            <span className="fz-path">{highlight(row.path, row.indices)}</span>
          </>
        );
      }}
    />
  );
}
