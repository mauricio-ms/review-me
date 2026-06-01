import { useCallback, useEffect, useRef, useState } from "react";

import { openRepoByPath } from "../lib/open-repo";
import { forgetRepo, listRecentRepos } from "../lib/tauri";
import { useUIStore } from "../state/ui";
import type { RememberedRepo } from "../types/repo";
import { useModalFocus } from "./useModalFocus";

export default function RecentReposHost() {
  const open = useUIStore((s) => s.picker === "recentRepos");
  const closePicker = useUIStore((s) => s.closePicker);
  const requestFocus = useUIStore((s) => s.requestFocus);

  const rootRef = useRef<HTMLDivElement | null>(null);
  useModalFocus({ open, rootRef });

  const [repos, setRepos] = useState<RememberedRepo[]>([]);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRepos(await listRecentRepos());
      setSelected(0);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  const close = useCallback(() => {
    closePicker();
    requestFocus();
  }, [closePicker, requestFocus]);

  const openSelected = useCallback(
    async (repo: RememberedRepo | undefined) => {
      if (!repo || busy) return;
      setBusy(true);
      setError(null);
      try {
        await openRepoByPath(repo.path);
        close();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, close],
  );

  const forget = useCallback(async (repo: RememberedRepo | undefined) => {
    if (!repo) return;
    try {
      setRepos(await forgetRepo(repo.path));
      setSelected(0);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const move = (delta: number) => {
    if (repos.length === 0) return;
    setSelected((c) => (c + delta + repos.length) % repos.length);
  };

  if (!open) return null;

  const footer = busy
    ? "opening…"
    : error
      ? error
      : repos.length === 0
        ? "no recent repositories"
        : "↵ open · d forget · Esc cancel";

  return (
    <div className="asset-picker-backdrop">
      <div
        ref={rootRef}
        className="asset-picker neo-picker"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.ctrlKey || e.metaKey || e.altKey) return;
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
              e.preventDefault();
              void openSelected(repos[selected]);
              break;
            case "d":
              e.preventDefault();
              void forget(repos[selected]);
              break;
          }
        }}
      >
        <div className="neo-title">Recent repositories</div>
        <div className="neo-count">{repos.length}</div>
        <div className="neo-separator" />
        <div className="neo-list">
          {repos.length === 0 ? (
            <div className="neo-empty">nothing here yet</div>
          ) : (
            repos.map((repo, idx) => (
              <div
                key={repo.path}
                className={`neo-row ${idx === selected ? "is-selected" : ""}`}
                onMouseEnter={() => setSelected(idx)}
                onClick={() => openSelected(repo)}
              >
                <span className="neo-icon"></span>
                <span className="neo-name">{repo.name}</span>
                <span className="neo-detail">{repo.path}</span>
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
