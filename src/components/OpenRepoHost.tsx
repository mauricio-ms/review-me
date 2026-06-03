import { useCallback, useEffect, useState } from "react";

import { fileIcon } from "../lib/file-icons";
import { openRepoByPath } from "../lib/open-repo";
import { listFileSystemEntries } from "../lib/tauri";
import { useUIStore } from "../state/ui";
import type { FileSystemEntry, FileSystemListing } from "../types/repo";
import NeoPicker from "./NeoPicker";

type PickRow =
  | { kind: "openHere"; key: string }
  | { kind: "parent"; key: string; path: string }
  | { kind: "dir"; key: string; entry: FileSystemEntry };

/** git orange-red, matching the `.gitignore` icon in file-icons.ts. */
const REPO_COLOR = "#f14e32";

/** Abbreviate the home prefix to `~`, like a shell prompt. */
function homeRelative(path: string, home: string | null): string {
  if (!home) return path;
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

/** Split a display path into its ancestor portion and the current segment. */
function splitPath(display: string): { ancestors: string; current: string } {
  const trimmed = display.replace(/\/+$/, "") || "/";
  const cut = trimmed.lastIndexOf("/");
  if (cut < 0) return { ancestors: "", current: trimmed };
  if (cut === 0) return { ancestors: "/", current: trimmed.slice(1) };
  return { ancestors: trimmed.slice(0, cut + 1), current: trimmed.slice(cut + 1) };
}

export default function OpenRepoHost() {
  const open = useUIStore((s) => s.picker === "openRepo");
  const closePicker = useUIStore((s) => s.closePicker);
  const requestFocus = useUIStore((s) => s.requestFocus);

  const [listing, setListing] = useState<FileSystemListing | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigate = useCallback(async (path: string | null) => {
    setError(null);
    setQuery("");
    try {
      const next = await listFileSystemEntries(path);
      setListing(next);
      // The backend resolves `null` to $HOME — capture it for `~` display.
      if (path === null) setHome(next.path);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) void navigate(null);
  }, [open, navigate]);

  const close = useCallback(() => {
    closePicker();
    requestFocus();
  }, [closePicker, requestFocus]);

  const openByPath = useCallback(
    async (path: string) => {
      setBusy(true);
      setError(null);
      try {
        await openRepoByPath(path);
        close();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [close],
  );

  if (!open) return null;

  // Directories only (files are not openable as a repo); substring-filtered.
  const needle = query.trim().toLowerCase();
  const rows: PickRow[] = [];
  if (listing?.isRepo) rows.push({ kind: "openHere", key: "open-here" });
  if (listing?.parent) {
    rows.push({ kind: "parent", key: "parent", path: listing.parent });
  }
  for (const entry of listing?.entries ?? []) {
    if (entry.kind !== "directory") continue;
    if (needle && !entry.name.toLowerCase().includes(needle)) continue;
    rows.push({ kind: "dir", key: `d:${entry.path}`, entry });
  }

  /** Enter: open the selected directory as a repo (descend if it isn't one). */
  const openRow = (row: PickRow) => {
    if (busy) return;
    if (row.kind === "openHere") {
      if (listing) void openByPath(listing.path);
    } else if (row.kind === "parent") {
      void navigate(row.path);
    } else if (row.entry.isRepo) {
      void openByPath(row.entry.path);
    } else {
      void navigate(row.entry.path);
    }
  };

  /** Tab: descend into the selected directory. */
  const enterRow = (row: PickRow | undefined) => {
    if (!row || busy) return;
    if (row.kind === "dir") void navigate(row.entry.path);
    else if (row.kind === "parent") void navigate(row.path);
  };

  const { ancestors, current } = splitPath(
    homeRelative(listing?.path ?? "", home),
  );

  const footer = busy
    ? "opening…"
    : (error ?? "↵ open · ⇥ enter dir · ⌫ up · Esc cancel");

  return (
    <NeoPicker<PickRow>
      open={open}
      className="open-repo"
      title="Open repository"
      query={query}
      onQueryChange={setQuery}
      promptPrefix={
        listing ? (
          <span className="neo-path-base">
            {ancestors && <span className="neo-path-anc">{ancestors}</span>}
            {current && <span className="neo-path-cur">{current}</span>}
            {current && <span className="neo-path-sep">/</span>}
          </span>
        ) : undefined
      }
      rows={rows}
      rowKey={(row) => row.key}
      onActivate={openRow}
      // Land on the first real directory, not the leading "open here" / ".." rows.
      initialSelected={Math.max(
        0,
        rows.findIndex((row) => row.kind === "dir"),
      )}
      onClose={close}
      footer={footer}
      emptyText="no subdirectories"
      onExtraKeyDown={(e, { selected }) => {
        // Tab descends into the highlighted directory.
        if (e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          enterRow(rows[selected]);
          return true;
        }
        // Backspace on an empty filter climbs to the parent directory (the whole
        // path segment at once); with text present it deletes a character.
        if (e.key === "Backspace" && query === "" && listing?.parent) {
          e.preventDefault();
          void navigate(listing.parent);
          return true;
        }
        return false;
      }}
      renderRow={(row) => {
        if (row.kind === "openHere") {
          return (
            <>
              <span className="neo-icon">▸</span>
              <span className="neo-name">open this repository</span>
              <span className="neo-detail is-repo">git</span>
            </>
          );
        }
        if (row.kind === "parent") {
          return (
            <>
              <span className="neo-icon">↑</span>
              <span className="neo-name">..</span>
              <span className="neo-detail" />
            </>
          );
        }
        const icon = fileIcon(row.entry.name, true);
        return (
          <>
            <span
              className="neo-icon"
              style={{ color: row.entry.isRepo ? REPO_COLOR : icon.color }}
            >
              {icon.glyph}
            </span>
            <span className="neo-name">{row.entry.name}</span>
            <span className={`neo-detail${row.entry.isRepo ? " is-repo" : ""}`}>
              {row.entry.isRepo ? "git" : ""}
            </span>
          </>
        );
      }}
    />
  );
}
