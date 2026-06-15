import { useCallback, useState } from "react";

import { refreshDiff } from "../lib/open-repo";
import { projectSelectionRange } from "../lib/project-view";
import { addFlag } from "../lib/review-actions";
import { findUsages, gotoDefinition } from "../lib/xref";
import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
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
  const openPath = useProjectStore((s) => s.openPath);
  const diffHighlight = useUIStore((s) => s.diffHighlight);
  const toggleDiffHighlight = useUIStore((s) => s.toggleDiffHighlight);

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
    useTagsStore.getState().clear();
    useProjectStore.getState().reset();
    requestFocus();
  }, [close, closeRepo, requestFocus]);

  const handleFind = useCallback(() => {
    close({ restoreFocus: false });
    openPicker("fuzzyFiles");
  }, [close, openPicker]);

  const handleClearTags = useCallback(() => {
    close({ restoreFocus: false });
    openPicker("clearTags");
  }, [close, openPicker]);

  const handleCommitReviewed = useCallback(() => {
    close({ restoreFocus: false });
    openPicker("commitReviewed");
  }, [close, openPicker]);

  const handleToggleDiffMode = useCallback(() => {
    toggleDiffHighlight();
    close();
  }, [close, toggleDiffHighlight]);

  const handleProjectFlag = useCallback(async () => {
    close({ restoreFocus: false });
    const path = useProjectStore.getState().openPath;
    const range = projectSelectionRange();
    if (!path || !range) return;
    try {
      await addFlag(path, range.lo, range.hi, "range");
    } finally {
      requestFocus();
    }
  }, [close, requestFocus]);

  const handleGotoDef = useCallback(() => {
    close({ restoreFocus: false });
    void gotoDefinition();
  }, [close]);

  const handleFindRefs = useCallback(() => {
    close({ restoreFocus: false });
    void findUsages();
  }, [close]);

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
      id: "find",
      name: "find",
      aliases: ["files", "ff"],
      label: "find file (fuzzy)",
      group: "find",
      prefix: null,
      key: "f",
      enabled: !!repo,
      run: handleFind,
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
      id: "diff-mode",
      name: "diffmode",
      aliases: ["highlight", "worddiff", "hl"],
      label: `diff highlight → ${diffHighlight === "word" ? "line" : "word"}`,
      group: "diff",
      prefix: null,
      key: "h",
      buffer: "diff",
      enabled: !!repo,
      run: handleToggleDiffMode,
    },
    {
      id: "flag",
      name: "flag",
      aliases: ["mark"],
      label: openPath ? "flag selection" : "flag (open a file first)",
      group: "tag",
      prefix: "t",
      key: "f",
      buffer: "project",
      enabled: !!openPath,
      run: handleProjectFlag,
    },
    {
      id: "goto-def",
      name: "definition",
      aliases: ["def", "gd"],
      label: "go to definition",
      group: "xref",
      prefix: "g",
      key: "d",
      buffer: "project",
      enabled: !!openPath,
      run: handleGotoDef,
    },
    {
      id: "find-refs",
      name: "references",
      aliases: ["refs", "gr", "usages"],
      label: "find references",
      group: "xref",
      prefix: "g",
      key: "r",
      buffer: "project",
      enabled: !!openPath,
      run: handleFindRefs,
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
      id: "commit-reviewed",
      name: "commit",
      aliases: ["commitreviewed", "reviewed-commit", "gitcommit", "gc"],
      label: "commit reviewed changes",
      group: "git",
      prefix: "g",
      key: "c",
      enabled: !!repo,
      run: handleCommitReviewed,
    },
    {
      id: "clear",
      name: "clear",
      aliases: ["clear-tags", "reset-tags"],
      label: "clear all review, flag & ignore tags",
      group: "tag",
      // Command-line only — no Space chord for this destructive action.
      prefix: null,
      key: "x",
      enabled: !!repo,
      run: handleClearTags,
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
