import { useCallback } from "react";

import {
  currentFile,
  cycleFileBuffers,
  focusTree,
  killCurrentBuffer,
  openHelp,
  otherWindow,
  showBuffer,
  useCurrentFile,
} from "../lib/buffers";
import { contextScope, startDescribeKey } from "../lib/key-dispatch";
import { showLog } from "../lib/log";
import { exportNotes, openNoteEditor } from "../lib/notes";
import { applyComparison, refreshDiff } from "../lib/open-repo";
import { resizeTree, toggleTree } from "../lib/project";
import { toggleChangesAtCursor } from "../lib/project-diff";
import { projectSelectionRange } from "../lib/project-view";
import { addFlag } from "../lib/review-actions";
import { adjustTextScale } from "../lib/text-scale";
import { findUsages, gotoDefinition, jumpBack } from "../lib/xref";
import { useFilesStore } from "../state/files";
import { useJumpStore } from "../state/jumps";
import { useLogStore } from "../state/log";
import { useMinibufferStore } from "../state/minibuffer";
import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore } from "../state/ui";
import { activeBuffer as activeBufferOf, useWindowStore, type BufferName } from "../state/windows";
import { readsCommittedHistory, WORKTREE_SPEC } from "../types/diff";

/** Closes the minibuffer that ran a command (a no-op when a key ran it). */
export type CommandClose = (options?: { restoreFocus?: boolean }) => void;

export type CommandId =
  | "open"
  | "recent"
  | "find"
  | "refresh"
  | "diff-mode"
  | "flag"
  | "note"
  | "export-notes"
  | "goto-def"
  | "find-refs"
  | "jump-back"
  | "changed"
  | "hunk"
  | "hunks"
  | "close"
  | "checkout"
  | "compare"
  | "log"
  | "commit-diff"
  | "worktree"
  | "commit-reviewed"
  | "clear"
  | "diff"
  | "project"
  | "switch-buffer"
  | "kill-buffer"
  | "previous-buffer"
  | "next-buffer"
  | "other-window"
  | "help"
  | "describe-mode"
  | "describe-key"
  | "shrink-tree"
  | "enlarge-tree"
  | "toggle-tree"
  | "text-scale-increase"
  | "text-scale-decrease"
  | "text-scale-reset";

export type AppCommand = {
  /** Stable identity, e.g. "open"; what key bindings (`lib/keymap.ts`) refer to. */
  id: CommandId;
  /** Name typed in `M-x`, e.g. "open". */
  name: string;
  /** Extra names that also match in `M-x`. */
  aliases: string[];
  /** Human-readable description, shown beside the name. */
  label: string;
  /** If set, the command is only available while this buffer is active. */
  buffer?: BufferName;
  enabled: boolean;
  run: () => void | Promise<void>;
};

/**
 * Single source of truth for the app's commands: `M-x` lists them, key bindings
 * (`lib/keymap.ts`) run them by id, and the help buffer documents them. Each consumer
 * passes its own `close` — the minibuffer closes itself; a key has nothing to close.
 */
export function useCommands(close: CommandClose): {
  /** The commands available in the active buffer. */
  commands: AppCommand[];
  /** Every command, whatever the buffer — for the help buffer and key dispatch. */
  all: AppCommand[];
} {
  const activeBuffer = useWindowStore(activeBufferOf);
  const openPicker = useUIStore((s) => s.openPicker);
  const requestFocus = useUIStore((s) => s.requestFocus);
  const repo = useRepoStore((s) => s.repo);
  const reviewBranch = useRepoStore((s) => s.reviewBranch);
  const comparison = useRepoStore((s) => s.comparison);
  const closeRepo = useRepoStore((s) => s.closeRepo);
  // A branch pair or a single commit: both sides are already committed history.
  const comparingHistory = readsCommittedHistory(comparison);
  const openPath = useCurrentFile()?.path ?? null;
  const projectFilter = useProjectStore((s) => s.filter);
  const toggleProjectFilter = useProjectStore((s) => s.toggleFilter);
  const inlineDiff = useProjectStore((s) => s.inlineDiff);
  const toggleInlineDiff = useProjectStore((s) => s.toggleInlineDiff);
  // Selecting the length, not the array: the command only needs "is there anywhere
  // to go back to", and a length never trips the fresh-reference rerender trap.
  const jumpDepth = useJumpStore((s) => s.stack.length);
  const diffHighlight = useUIStore((s) => s.diffHighlight);
  const toggleDiffHighlight = useUIStore((s) => s.toggleDiffHighlight);
  const openMinibuffer = useMinibufferStore((s) => s.open);

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
    try {
      await refreshDiff();
    } finally {
      requestFocus();
    }
  }, [close, requestFocus]);

  const handleCloseRepo = useCallback(() => {
    close({ restoreFocus: false });
    closeRepo();
    useTagsStore.getState().clear();
    useLogStore.getState().reset();
    useProjectStore.getState().reset();
    useFilesStore.getState().reset();
    useWindowStore.getState().reset();
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

  const handleCompareBranches = useCallback(() => {
    close({ restoreFocus: false });
    openPicker("branchCompare");
  }, [close, openPicker]);

  const handlePickCommit = useCallback(() => {
    close({ restoreFocus: false });
    openPicker("commitPick");
  }, [close, openPicker]);

  const handleShowLog = useCallback(() => {
    close({ restoreFocus: false });
    showLog();
  }, [close]);

  const handleCheckoutBranch = useCallback(() => {
    close({ restoreFocus: false });
    openPicker("checkoutBranch");
  }, [close, openPicker]);

  const handleWorktreeDiff = useCallback(async () => {
    close({ restoreFocus: false });
    try {
      // applyComparison records the failure in the diff status.
      await applyComparison(WORKTREE_SPEC).catch(() => {});
    } finally {
      requestFocus();
    }
  }, [close, requestFocus]);

  const handleToggleDiffMode = useCallback(() => {
    toggleDiffHighlight();
    close();
  }, [close, toggleDiffHighlight]);

  const handleToggleProjectFilter = useCallback(() => {
    toggleProjectFilter();
    close();
  }, [close, toggleProjectFilter]);

  const handleToggleChangeAtCursor = useCallback(() => {
    close();
    toggleChangesAtCursor();
  }, [close]);

  const handleToggleAllChanges = useCallback(() => {
    toggleInlineDiff();
    close();
  }, [close, toggleInlineDiff]);

  const handleProjectFlag = useCallback(async () => {
    close({ restoreFocus: false });
    const path = currentFile()?.path;
    const range = projectSelectionRange();
    if (!path || !range) return;
    try {
      await addFlag(path, range.lo, range.hi, "range", "new");
    } finally {
      requestFocus();
    }
  }, [close, requestFocus]);

  const handleNote = useCallback(() => {
    close({ restoreFocus: false });
    // Nothing to annotate on a section header: hand focus straight back.
    if (!openNoteEditor()) requestFocus();
  }, [close, requestFocus]);

  const handleExportNotes = useCallback(() => {
    close();
    void exportNotes();
  }, [close]);

  const handleGotoDef = useCallback(() => {
    close({ restoreFocus: false });
    void gotoDefinition();
  }, [close]);

  const handleFindRefs = useCallback(() => {
    close({ restoreFocus: false });
    void findUsages();
  }, [close]);

  const handleJumpBack = useCallback(() => {
    close({ restoreFocus: false });
    void jumpBack();
  }, [close]);

  const handleSwitchBuffer = useCallback(() => {
    close({ restoreFocus: false });
    openMinibuffer({ kind: "buffer" });
  }, [close, openMinibuffer]);

  const handleOtherWindow = useCallback(() => {
    close({ restoreFocus: false });
    otherWindow();
  }, [close]);

  // Read before closing: the keymap that was active is what help starts from.
  const handleHelp = useCallback(
    (only: boolean) => {
      const from = contextScope();
      close({ restoreFocus: false });
      openHelp(from, only);
    },
    [close],
  );

  const handleDescribeKey = useCallback(() => {
    close();
    startDescribeKey();
  }, [close]);

  const handleShowDiff = useCallback(() => {
    close({ restoreFocus: false });
    showBuffer("diff");
  }, [close]);

  const commands: AppCommand[] = [
    {
      id: "open",
      name: "open",
      aliases: ["edit"],
      label: "open repository",
      enabled: true,
      run: handleOpenRepo,
    },
    {
      id: "recent",
      name: "recent",
      aliases: ["repos"],
      label: "open recent repository",
      enabled: true,
      run: handleRecentRepos,
    },
    {
      id: "find",
      name: "find",
      aliases: ["files", "ff"],
      label: "find file (fuzzy)",
      enabled: !!repo,
      run: handleFind,
    },
    {
      id: "refresh",
      name: "refresh",
      aliases: ["reload", "g"],
      label: "refresh diff",
      enabled: !!repo,
      run: handleRefresh,
    },
    {
      id: "diff-mode",
      name: "diffmode",
      aliases: ["highlight", "worddiff", "hl"],
      label: `diff highlight → ${diffHighlight === "word" ? "line" : "word"}`,
      buffer: "diff",
      enabled: !!repo,
      run: handleToggleDiffMode,
    },
    {
      id: "flag",
      name: "flag",
      aliases: ["mark"],
      label: openPath ? "flag selection" : "flag (open a file first)",
      buffer: "project",
      enabled: !!openPath,
      run: handleProjectFlag,
    },
    {
      id: "note",
      name: "note",
      aliases: ["annotate", "comment", "todo"],
      label:
        comparison.kind === "commit"
          ? "note on the lines at the cursor (a fix for later)"
          : "note (while reviewing a commit)",
      buffer: "diff",
      // `M-x note` only, no key — in keeping with `show` and `export`.
      // A note is exported per commit, so it only exists while reviewing one.
      enabled: !!repo && comparison.kind === "commit",
      run: handleNote,
    },
    {
      id: "export-notes",
      name: "export",
      aliases: ["notes", "export-notes"],
      label: `export notes on ${reviewBranch?.display ?? "HEAD"} to Markdown`,
      enabled: !!repo,
      run: handleExportNotes,
    },
    {
      id: "goto-def",
      name: "definition",
      aliases: ["def", "gd"],
      label: "go to definition",
      buffer: "project",
      enabled: !!openPath,
      run: handleGotoDef,
    },
    {
      id: "find-refs",
      name: "references",
      aliases: ["refs", "gr", "usages"],
      label: "find references",
      buffer: "project",
      enabled: !!openPath,
      run: handleFindRefs,
    },
    {
      id: "jump-back",
      name: "back",
      aliases: ["pop", "jumpback"],
      label: "back to where you jumped from",
      buffer: "project",
      enabled: jumpDepth > 0,
      run: handleJumpBack,
    },
    {
      id: "changed",
      name: "changed",
      aliases: ["filter", "allfiles", "changedfiles"],
      label:
        projectFilter === "changed"
          ? "project files → all files"
          : "project files → only what this comparison changed",
      // `c` in the project tree does the same.
      enabled: !!repo,
      run: handleToggleProjectFilter,
    },
    {
      id: "hunk",
      name: "hunk",
      aliases: ["preview", "showdiff", "inline"],
      label: "show/hide the diff of the change at the cursor or selection",
      buffer: "project",
      enabled: !!openPath,
      run: handleToggleChangeAtCursor,
    },
    {
      id: "hunks",
      name: "hunks",
      aliases: ["diffs", "showdiffs", "inlineall"],
      label: inlineDiff
        ? "hide the inline diff of every change, in every file"
        : "show the inline diff of every change, in every file",
      buffer: "project",
      enabled: !!repo,
      run: handleToggleAllChanges,
    },
    {
      id: "close",
      name: "close",
      aliases: ["bd"],
      label: "close repository",
      enabled: !!repo,
      run: handleCloseRepo,
    },
    {
      id: "checkout",
      name: "checkout",
      aliases: ["co", "switch", "branch"],
      label: reviewBranch
        ? `branch to review → ${reviewBranch.display}`
        : "branch to review",
      enabled: !!repo,
      run: handleCheckoutBranch,
    },
    {
      id: "compare",
      name: "compare",
      aliases: ["branches", "cmp", "base"],
      label: reviewBranch
        ? `compare ${reviewBranch.display} against a base`
        : "compare branches (no branch to review)",
      // Both pickers review the branch the app is on; without one there is nothing
      // to compare or to list commits from.
      enabled: !!repo && !!reviewBranch,
      run: handleCompareBranches,
    },
    {
      id: "log",
      name: "log",
      aliases: ["commits", "history"],
      label: `commits on ${reviewBranch?.display ?? "HEAD"}`,
      enabled: !!repo,
      run: handleShowLog,
    },
    {
      id: "commit-diff",
      name: "show",
      aliases: ["revision", "sha"],
      label: "review a commit by sha or subject",
      // The log is the way into a commit; this picker remains for searching and for
      // a sha outside the listed history.
      enabled: !!repo,
      run: handlePickCommit,
    },
    {
      id: "worktree",
      name: "worktree",
      aliases: ["wt", "working", "uncommitted"],
      label: "working-tree diff",
      // Already the working-tree diff — nothing to switch back to.
      enabled: !!repo && comparingHistory,
      run: handleWorktreeDiff,
    },
    {
      id: "commit-reviewed",
      name: "commit",
      aliases: ["commitreviewed", "reviewed-commit", "gitcommit", "gc"],
      label: comparingHistory
        ? "commit reviewed changes (working-tree diff only)"
        : "commit reviewed changes",
      // Committed history has nothing to stage — neither side of a branch pair nor a
      // commit's own diff is something the reviewer could mean by committing here.
      enabled: !!repo && !comparingHistory,
      run: handleCommitReviewed,
    },
    {
      id: "clear",
      name: "clear",
      aliases: ["clear-tags", "reset-tags"],
      label: "clear this comparison's review, flag & ignore tags",
      // `M-x` only — no key for a destructive action.
      enabled: !!repo,
      run: handleClearTags,
    },
    {
      id: "diff",
      name: "diff",
      aliases: [],
      label: "diff buffer",
      enabled: !!repo,
      run: handleShowDiff,
    },
    {
      id: "project",
      name: "project",
      aliases: ["files"],
      label: "the file tree (shown if hidden)",
      enabled: !!repo,
      run: () => {
        close({ restoreFocus: false });
        focusTree();
      },
    },
    {
      id: "switch-buffer",
      name: "switch-buffer",
      aliases: ["buffer", "buffers"],
      label: "switch to another buffer",
      enabled: !!repo,
      run: handleSwitchBuffer,
    },
    {
      id: "kill-buffer",
      name: "kill-buffer",
      aliases: ["kill", "close-file"],
      label: "close the file in this window",
      enabled: !!repo,
      run: () => {
        close({ restoreFocus: false });
        killCurrentBuffer();
      },
    },
    {
      id: "previous-buffer",
      name: "previous-buffer",
      aliases: ["prev-file"],
      label: "the previous open file (then <left>, <right> keep going)",
      enabled: !!repo,
      run: () => {
        close({ restoreFocus: false });
        cycleFileBuffers(-1);
      },
    },
    {
      id: "next-buffer",
      name: "next-buffer",
      aliases: ["next-file"],
      label: "the next open file (then <left>, <right> keep going)",
      enabled: !!repo,
      run: () => {
        close({ restoreFocus: false });
        cycleFileBuffers(1);
      },
    },
    {
      id: "other-window",
      name: "other-window",
      aliases: ["window", "pane"],
      label: "between the file tree and the window",
      enabled: !!repo,
      run: handleOtherWindow,
    },
    {
      id: "help",
      name: "help",
      aliases: ["describe-bindings", "keys", "bindings", "cheatsheet"],
      label: "every key binding and command",
      enabled: true,
      run: () => handleHelp(false),
    },
    {
      id: "describe-mode",
      name: "describe-mode",
      aliases: ["mode", "buffer-keys"],
      label: "the current buffer's keys",
      enabled: true,
      run: () => handleHelp(true),
    },
    {
      id: "describe-key",
      name: "describe-key",
      aliases: ["what-key"],
      label: "press a key to see what it runs",
      enabled: true,
      run: handleDescribeKey,
    },
    {
      id: "shrink-tree",
      name: "shrink-window-horizontally",
      aliases: ["shrink-tree", "narrower"],
      label: "narrower file tree",
      enabled: !!repo,
      run: () => {
        close();
        resizeTree(-1);
      },
    },
    {
      id: "enlarge-tree",
      name: "enlarge-window-horizontally",
      aliases: ["enlarge-tree", "wider"],
      label: "wider file tree",
      enabled: !!repo,
      run: () => {
        close();
        resizeTree(1);
      },
    },
    {
      id: "toggle-tree",
      name: "toggle-tree",
      aliases: ["hide-tree", "show-tree", "tree"],
      label: "hide or show the file tree beside the windows",
      enabled: !!repo,
      run: () => {
        close({ restoreFocus: false });
        toggleTree();
      },
    },
    {
      id: "text-scale-increase",
      name: "text-scale-increase",
      aliases: ["bigger", "zoom-in", "font-bigger"],
      label: "bigger text, everywhere",
      enabled: true,
      run: () => {
        close();
        adjustTextScale(1);
      },
    },
    {
      id: "text-scale-decrease",
      name: "text-scale-decrease",
      aliases: ["smaller", "zoom-out", "font-smaller"],
      label: "smaller text, everywhere",
      enabled: true,
      run: () => {
        close();
        adjustTextScale(-1);
      },
    },
    {
      id: "text-scale-reset",
      name: "text-scale-reset",
      aliases: ["reset-text", "zoom-reset"],
      label: "back to the default text size",
      enabled: true,
      run: () => {
        close();
        adjustTextScale(0);
      },
    },
  ];

  // Buffer-scoped commands are only offered in their buffer.
  const visibleCommands = commands.filter(
    (c) => !c.buffer || c.buffer === activeBuffer,
  );

  return { commands: visibleCommands, all: commands };
}
