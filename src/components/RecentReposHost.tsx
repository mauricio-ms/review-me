import { useCallback, useEffect, useState } from "react";

import { fileIcon } from "../lib/file-icons";
import { openRepoByPath } from "../lib/open-repo";
import { forgetRepo, listRecentRepos } from "../lib/tauri";
import { useUIStore } from "../state/ui";
import type { RememberedRepo } from "../types/repo";
import NeoPicker from "./NeoPicker";

/** git orange-red, matching the `.gitignore` icon in file-icons.ts. */
const REPO_COLOR = "#f14e32";

export default function RecentReposHost() {
  const open = useUIStore((s) => s.picker === "recentRepos");
  const closePicker = useUIStore((s) => s.closePicker);
  const requestFocus = useUIStore((s) => s.requestFocus);

  const [repos, setRepos] = useState<RememberedRepo[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRepos(await listRecentRepos());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      void reload();
    }
  }, [open, reload]);

  const close = useCallback(() => {
    closePicker();
    requestFocus();
  }, [closePicker, requestFocus]);

  const openSelected = useCallback(
    async (repo: RememberedRepo) => {
      if (busy) return;
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
    } catch (e) {
      setError(String(e));
    }
  }, []);

  if (!open) return null;

  const needle = query.trim().toLowerCase();
  const rows = needle
    ? repos.filter((r) => `${r.name} ${r.path}`.toLowerCase().includes(needle))
    : repos;

  const footer = busy
    ? "opening…"
    : error
      ? error
      : repos.length === 0
        ? "no recent repositories"
        : "↵ open · C-d forget · Esc cancel";

  // Repos are directories; show the folder glyph tinted git-color.
  const repoGlyph = fileIcon("", true).glyph;

  return (
    <NeoPicker<RememberedRepo>
      open={open}
      title="Recent repositories"
      query={query}
      onQueryChange={setQuery}
      placeholder="filter repositories…"
      rows={rows}
      rowKey={(repo) => repo.path}
      onActivate={(repo) => void openSelected(repo)}
      onClose={close}
      footer={footer}
      emptyText="nothing here yet"
      onExtraKeyDown={(e, { selected }) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "d") {
          e.preventDefault();
          void forget(rows[selected]);
          return true;
        }
        return false;
      }}
      renderRow={(repo) => (
        <>
          <span className="neo-icon" style={{ color: REPO_COLOR }}>
            {repoGlyph}
          </span>
          <span className="neo-name">{repo.name}</span>
          <span className="neo-detail">{repo.path}</span>
        </>
      )}
    />
  );
}
