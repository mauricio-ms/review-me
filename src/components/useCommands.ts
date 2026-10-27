import { useCallback, useState } from "react";

import { showLog } from "../lib/log";
import { exportNotes, openNoteEditor } from "../lib/notes";
import { applyComparison, refreshDiff } from "../lib/open-repo";
import { toggleChangesAtCursor } from "../lib/project-diff";
import { projectSelectionRange } from "../lib/project-view";
import { addFlag } from "../lib/review-actions";
import { findUsages, gotoDefinition, jumpBack } from "../lib/xref";
import { useJumpStore } from "../state/jumps";
import { useLogStore } from "../state/log";
import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore, type BufferName } from "../state/ui";
import { readsCommittedHistory, WORKTREE_SPEC } from "../types/diff";

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
  /** `false` keeps it out of the `Space` palette: reachable from `:` only. */
  palette?: boolean;
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
  const reviewBranch = useRepoStore((s) => s.reviewBranch);
  const comparison = useRepoStore((s) => s.comparison);
  const closeRepo = useRepoStore((s) => s.closeRepo);
  // A branch pair or a single commit: both sides are already committed history.
  const comparingHistory = readsCommittedHistory(comparison);
  const openPath = useProjectStore((s) => s.openPath);
  const projectFilter = useProjectStore((s) => s.filter);
  const toggleProjectFilter = useProjectStore((s) => s.toggleFilter);
  const inlineDiff = useProjectStore((s) => s.inlineDiff);
  const toggleInlineDiff = useProjectStore((s) => s.toggleInlineDiff);
  // Selecting the length, not the array: the command only needs "is there anywhere
  // to go back to", and a length never trips the fresh-reference rerender trap.
  const jumpDepth = useJumpStore((s) => s.stack.length);
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
    useLogStore.getState().reset();
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
    setBusy("switching");
    try {
      // applyComparison records the failure in the diff status.
      await applyComparison(WORKTREE_SPEC).catch(() => {});
    } finally {
      setBusy(null);
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
    const path = useProjectStore.getState().openPath;
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
      id: "note",
      name: "note",
      aliases: ["annotate", "comment", "todo"],
      label:
        comparison.kind === "commit"
          ? "note on the lines at the cursor (a fix for later)"
          : "note (while reviewing a commit)",
      group: "tag",
      prefix: "t",
      key: "",
      buffer: "diff",
      // Notes are a `:note` away; no chord, in keeping with the commits buffer.
      palette: false,
      // A note is exported per commit, so it only exists while reviewing one.
      enabled: !!repo && comparison.kind === "commit",
      run: handleNote,
    },
    {
      id: "export-notes",
      name: "export",
      aliases: ["notes", "export-notes"],
      label: `export notes on ${reviewBranch?.display ?? "HEAD"} to Markdown`,
      group: "tag",
      prefix: "t",
      key: "",
      palette: false,
      enabled: !!repo,
      run: handleExportNotes,
    },
    {
      id: "goto-def",
      name: "definition",
      aliases: ["def", "gd"],
      label: "go to definition (M-.)",
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
      label: "find references (M-?)",
      group: "xref",
      prefix: "g",
      key: "r",
      buffer: "project",
      enabled: !!openPath,
      run: handleFindRefs,
    },
    {
      id: "jump-back",
      name: "back",
      aliases: ["pop", "jumpback"],
      label: "back to where you jumped from (M-,)",
      group: "xref",
      // `g b` is the branch comparison; `o` reads as the *older* position.
      prefix: "g",
      key: "o",
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
      group: "project",
      prefix: null,
      key: "",
      // `c` in the project tree does the same; no palette chord.
      palette: false,
      enabled: !!repo,
      run: handleToggleProjectFilter,
    },
    {
      id: "hunk",
      name: "hunk",
      aliases: ["preview", "showdiff", "inline"],
      label: "show/hide the diff of the change at the cursor or selection",
      group: "project",
      prefix: null,
      key: "",
      buffer: "project",
      palette: false,
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
      group: "project",
      prefix: null,
      key: "",
      buffer: "project",
      palette: false,
      enabled: !!repo,
      run: handleToggleAllChanges,
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
      id: "checkout",
      name: "checkout",
      aliases: ["co", "switch", "branch"],
      label: reviewBranch
        ? `branch to review → ${reviewBranch.display}`
        : "branch to review",
      group: "git",
      prefix: "g",
      key: "s",
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
      group: "git",
      prefix: "g",
      key: "b",
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
      group: "git",
      prefix: "g",
      key: "l",
      enabled: !!repo,
      run: handleShowLog,
    },
    {
      id: "commit-diff",
      name: "show",
      aliases: ["revision", "sha"],
      label: "review a commit by sha or subject",
      group: "git",
      prefix: "g",
      key: "",
      // The log is the way into a commit; this picker remains for searching and for
      // a sha outside the listed history.
      palette: false,
      enabled: !!repo,
      run: handlePickCommit,
    },
    {
      id: "worktree",
      name: "worktree",
      aliases: ["wt", "working", "uncommitted"],
      label: "working-tree diff",
      group: "git",
      prefix: "g",
      key: "w",
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
      group: "git",
      prefix: "g",
      key: "c",
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
