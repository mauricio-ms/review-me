import { useCallback, useEffect, useState } from "react";

import { fileIcon } from "../lib/file-icons";
import { openFileInProject } from "../lib/project";
import { fuzzyFiles } from "../lib/tauri";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import type { FileMatch } from "../types/repo";
import NeoPicker from "./NeoPicker";

const LIMIT = 60;

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

  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<FileMatch[]>([]);

  // Debounced fuzzy query against the backend (the "content filter differs" case).
  useEffect(() => {
    if (!open || !repoPath) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void fuzzyFiles(repoPath, query, LIMIT).then((matches) => {
        if (!cancelled) setRows(matches);
      });
    }, 70);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open, query, repoPath]);

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
      void openFileInProject(row.path);
      closePicker();
    },
    [closePicker],
  );

  if (!open) return null;

  return (
    <NeoPicker<FileMatch>
      open={open}
      title="Find file"
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
      emptyText="no matching files"
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
