import { useCallback, useEffect, useRef, useState } from "react";

import { openRepoByPath } from "../lib/open-repo";
import { listFileSystemEntries } from "../lib/tauri";
import { useUIStore } from "../state/ui";
import type { FileSystemEntry, FileSystemListing } from "../types/repo";
import { useModalFocus } from "./useModalFocus";

type PickRow =
  | { kind: "openHere"; key: string }
  | { kind: "parent"; key: string; path: string }
  | { kind: "dir"; key: string; entry: FileSystemEntry };

export default function OpenRepoHost() {
  const open = useUIStore((s) => s.picker === "openRepo");
  const closePicker = useUIStore((s) => s.closePicker);
  const requestFocus = useUIStore((s) => s.requestFocus);

  const rootRef = useRef<HTMLDivElement | null>(null);
  useModalFocus({ open, rootRef });

  const [listing, setListing] = useState<FileSystemListing | null>(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigate = useCallback(async (path: string | null) => {
    setError(null);
    try {
      const next = await listFileSystemEntries(path);
      setListing(next);
      setSelected(0);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) void navigate(null);
  }, [open, navigate]);

  const rows: PickRow[] = [];
  if (listing?.isRepo) rows.push({ kind: "openHere", key: "open-here" });
  if (listing?.parent) {
    rows.push({ kind: "parent", key: "parent", path: listing.parent });
  }
  for (const entry of listing?.entries ?? []) {
    if (entry.kind === "directory") {
      rows.push({ kind: "dir", key: `d:${entry.path}`, entry });
    }
  }

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

  const activate = (row: PickRow | undefined) => {
    if (!row || busy) return;
    if (row.kind === "openHere" && listing) void openByPath(listing.path);
    else if (row.kind === "parent") void navigate(row.path);
    else if (row.kind === "dir") {
      if (row.entry.isRepo) void openByPath(row.entry.path);
      else void navigate(row.entry.path);
    }
  };

  const move = (delta: number) => {
    if (rows.length === 0) return;
    setSelected((c) => (c + delta + rows.length) % rows.length);
  };

  if (!open) return null;

  const footer = busy
    ? "opening…"
    : error
      ? error
      : "↵ open/enter · ⌫ up · Esc cancel";

  return (
    <div className="asset-picker-backdrop">
      <div
        ref={rootRef}
        className="asset-picker neo-picker"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.ctrlKey || e.metaKey || e.altKey) {
            if (e.key === "n") {
              e.preventDefault();
              move(1);
            } else if (e.key === "p") {
              e.preventDefault();
              move(-1);
            }
            return;
          }
          switch (e.key) {
            case "Escape":
              e.preventDefault();
              close();
              break;
            case "ArrowDown":
            case "j":
              e.preventDefault();
              move(1);
              break;
            case "ArrowUp":
            case "k":
              e.preventDefault();
              move(-1);
              break;
            case "Enter":
            case "l":
            case "ArrowRight":
              e.preventDefault();
              activate(rows[selected]);
              break;
            case "Backspace":
            case "h":
            case "ArrowLeft":
              e.preventDefault();
              if (listing?.parent) void navigate(listing.parent);
              break;
          }
        }}
      >
        <div className="neo-title">Open repository</div>
        <div className="neo-count">{listing?.entries.length ?? 0}</div>
        <div className="neo-prompt">
          <span>›</span>
          <span className="neo-path">{listing?.path ?? "…"}</span>
        </div>
        <div className="neo-separator" />
        <div className="neo-list">
          {rows.length === 0 ? (
            <div className="neo-empty">no subdirectories</div>
          ) : (
            rows.map((row, idx) => (
              <div
                key={row.key}
                className={`neo-row ${idx === selected ? "is-selected" : ""}`}
                onMouseEnter={() => setSelected(idx)}
                onClick={() => activate(row)}
              >
                {row.kind === "openHere" ? (
                  <>
                    <span className="neo-icon">▸</span>
                    <span className="neo-name">open this repository</span>
                    <span className="neo-detail is-repo">git</span>
                  </>
                ) : row.kind === "parent" ? (
                  <>
                    <span className="neo-icon">↑</span>
                    <span className="neo-name">..</span>
                    <span className="neo-detail" />
                  </>
                ) : (
                  <>
                    <span className="neo-icon">{row.entry.isRepo ? "" : ""}</span>
                    <span className="neo-name">{row.entry.name}</span>
                    <span className="neo-detail">
                      {row.entry.isRepo ? "git" : ""}
                    </span>
                  </>
                )}
              </div>
            ))
          )}
        </div>
        <div className="neo-footer">
          <span>{footer}</span>
        </div>
      </div>
    </div>
  );
}
