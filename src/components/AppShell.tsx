import { useEffect, useRef } from "react";

import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import BranchCompareHost from "./BranchCompareHost";
import BufferStatusBar from "./BufferStatusBar";
import CheckoutBranchHost from "./CheckoutBranchHost";
import CommandLine from "./CommandLine";
import CommandTransient from "./CommandTransient";
import CommitPickHost from "./CommitPickHost";
import CommitReviewedHost from "./CommitReviewedHost";
import ConfirmClearHost from "./ConfirmClearHost";
import DiffBuffer from "./DiffBuffer";
import FuzzyFinderHost from "./FuzzyFinderHost";
import LogBuffer from "./LogBuffer";
import NoteEditorHost from "./NoteEditorHost";
import OpenRepoHost from "./OpenRepoHost";
import ProjectBuffer from "./ProjectBuffer";
import RecentReposHost from "./RecentReposHost";
import StartupDashboard from "./StartupDashboard";
import XrefHost from "./XrefHost";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".cm-editor")) return true;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}

export default function AppShell() {
  const activeBuffer = useUIStore((s) => s.activeBuffer);
  const transientOpen = useUIStore((s) => s.transientOpen);
  const commandLineOpen = useUIStore((s) => s.commandLineOpen);
  const openTransient = useUIStore((s) => s.openTransient);
  const openCommandLine = useUIStore((s) => s.openCommandLine);
  const vimMode = useUIStore((s) => s.vimMode);
  const modalDepth = useUIStore((s) => s.modalDepth);
  const hasRepo = !!useRepoStore((s) => s.repo);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const focusBlocked = modalDepth > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // LazyVim-style leader keys: `Space` opens the command palette, `:` opens
      // the command line. Skip if an overlay is already open (each handles its
      // own keys), a modal is up, the user is typing into a text input, or a
      // modifier is held.
      const isLeader = e.key === " ";
      const isCommandLine = e.key === ":";
      if ((isLeader || isCommandLine) && !transientOpen && !commandLineOpen) {
        if (focusBlocked) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        if (isLeader) openTransient();
        else openCommandLine();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    commandLineOpen,
    focusBlocked,
    openCommandLine,
    openTransient,
    transientOpen,
  ]);

  return (
    <div
      ref={rootRef}
      className="app-shell"
      data-buffer={activeBuffer}
      data-vim-mode={vimMode}
      data-repo={hasRepo ? "open" : "none"}
      tabIndex={-1}
    >
      <div className="app-body">
        {hasRepo ? (
          <>
            {/* Every buffer stays mounted; only one is visible, preserving each
                buffer's cursor/scroll across switches — which is also how leaving a
                commit lands back on its row in the log. */}
            <div
              className="buffer-wrap"
              style={{ display: activeBuffer === "diff" ? "block" : "none" }}
            >
              <DiffBuffer />
            </div>
            <div
              className="buffer-wrap"
              style={{ display: activeBuffer === "log" ? "block" : "none" }}
            >
              <LogBuffer />
            </div>
            <div
              className="buffer-wrap"
              style={{ display: activeBuffer === "project" ? "block" : "none" }}
            >
              <ProjectBuffer />
            </div>
          </>
        ) : (
          <StartupDashboard />
        )}
      </div>
      {hasRepo && <BufferStatusBar />}
      <OpenRepoHost />
      <RecentReposHost />
      <FuzzyFinderHost />
      <CheckoutBranchHost />
      <BranchCompareHost />
      <CommitPickHost />
      <ConfirmClearHost />
      <CommitReviewedHost />
      <NoteEditorHost />
      <XrefHost />
      {transientOpen && <CommandTransient />}
      {commandLineOpen && <CommandLine />}
    </div>
  );
}
