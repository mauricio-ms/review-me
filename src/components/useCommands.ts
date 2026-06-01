import { useCallback, useState } from "react";

import { refreshDiff } from "../lib/open-repo";
import { useRepoStore } from "../state/repo";
import { useUIStore, type BufferName } from "../state/ui";

/** Closes the overlay that invoked a command. Provided by each consumer. */
export type CommandClose = (options?: { restoreFocus?: boolean }) => void;

export type AppCommand = {
  /** Stable identity, e.g. "open". */
  id: string;
  /** Token typed in the `:` command line, e.g. "open". */
  name: string;
  /** Extra tokens that also match in the command line. */
  aliases: string[];
  /** Human-readable description shown in both overlays. */
  label: string;
  /** Palette group title. */
  group: string;
  /** Palette chord prefix ("o", "b") or null for top-level actions. */
  prefix: string | null;
  /** Palette chord key. */
  key: string;
  /** If set, the command is only available while this buffer is active. */
  buffer?: BufferName;
  enabled: boolean;
  run: () => void | Promise<void>;
};

/**
 * Single source of truth for the app's commands, shared by the `Space` palette
 * (`CommandTransient`) and the `:` command line (`CommandLine`). Each consumer
 * passes its own `rawClose`; the hook wraps it so closing also clears `busy`.
 */
export function useCommands(rawClose: CommandClose): {
  commands: AppCommand[];
  busy: string | null;
} {
  const activeBuffer = useUIStore((s) => s.activeBuffer);
  const setActiveBuffer = useUIStore((s) => s.setActiveBuffer);
  const openPicker = useUIStore((s) => s.openPicker);
  const requestFocus = useUIStore((s) => s.requestFocus);
  const repo = useRepoStore((s) => s.repo);
  const closeRepo = useRepoStore((s) => s.closeRepo);

  const [busy, setBusy] = useState<string | null>(null);

  const close = useCallback<CommandClose>(
    (options) => {
      setBusy(null);
      rawClose(options);
    },
    [rawClose],
  );

  const handleOpenRepo = useCallback(() => {
    close({ restoreFocus: false });
    openPicker("openRepo");
  }, [close, openPicker]);

  const handleRecentRepos = useCallback(() => {
    close({ restoreFocus: false });
    openPicker("recentRepos");
  }, [close, openPicker]);

  const handleRefresh = useCallback(async () => {
    close({ restoreFocus: false });
    setBusy("refreshing");
    try {
      await refreshDiff();
    } finally {
      setBusy(null);
      requestFocus();
    }
  }, [close, requestFocus]);

  const handleCloseRepo = useCallback(() => {
    close({ restoreFocus: false });
    closeRepo();
    requestFocus();
  }, [close, closeRepo, requestFocus]);

  const switchTo = useCallback(
    (buffer: BufferName) => {
      close({ restoreFocus: false });
      setActiveBuffer(buffer);
      requestFocus();
    },
    [close, requestFocus, setActiveBuffer],
  );

  const commands: AppCommand[] = [
    {
      id: "open",
      name: "open",
      aliases: ["edit"],
      label: "open repository",
      group: "open",
      prefix: "o",
      key: "p",
      enabled: true,
      run: handleOpenRepo,
    },
    {
      id: "recent",
      name: "recent",
      aliases: ["repos"],
      label: "open recent repository",
      group: "open",
      prefix: "o",
      key: "r",
      enabled: true,
      run: handleRecentRepos,
    },
    {
      id: "refresh",
      name: "refresh",
      aliases: ["reload", "g"],
      label: "refresh diff",
      group: "repo",
      prefix: null,
      key: "r",
      enabled: !!repo,
      run: handleRefresh,
    },
    {
      id: "close",
      name: "close",
      aliases: ["bd"],
      label: "close repository",
      group: "repo",
      prefix: null,
      key: "c",
      enabled: !!repo,
      run: handleCloseRepo,
    },
    {
      id: "diff",
      name: "diff",
      aliases: [],
      label: "diff buffer",
      group: "switch buffer",
      prefix: "b",
      key: "d",
      enabled: true,
      run: () => switchTo("diff"),
    },
    {
      id: "project",
      name: "project",
      aliases: ["tree"],
      label: "project buffer",
      group: "switch buffer",
      prefix: "b",
      key: "p",
      enabled: true,
      run: () => switchTo("project"),
    },
  ];

  // Buffer-scoped commands appear in neither overlay outside their buffer.
  const visibleCommands = commands.filter(
    (c) => !c.buffer || c.buffer === activeBuffer,
  );

  return { commands: visibleCommands, busy };
}
