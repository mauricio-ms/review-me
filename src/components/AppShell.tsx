import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { inVimInsertMode } from "../editor/cm-shared";
import {
  chordOf,
  contextScope,
  describeNextKey,
  feedKey,
  feedRepeat,
  isDescribingKey,
  settle,
  type KeyHandler,
} from "../lib/key-dispatch";
import { KEYMAP, type GlobalAction, type KeyBinding } from "../lib/keymap";
import { useMinibufferStore } from "../state/minibuffer";
import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import { activeBuffer as activeBufferOf, selectedBuffer, useWindowStore } from "../state/windows";
import BranchCompareHost from "./BranchCompareHost";
import BufferStatusBar from "./BufferStatusBar";
import CheckoutBranchHost from "./CheckoutBranchHost";
import CommitPickHost from "./CommitPickHost";
import CommitReviewedHost from "./CommitReviewedHost";
import ConfirmClearHost from "./ConfirmClearHost";
import DiffBuffer from "./DiffBuffer";
import FuzzyFinderHost from "./FuzzyFinderHost";
import HelpBuffer from "./HelpBuffer";
import LogBuffer from "./LogBuffer";
import Minibuffer from "./Minibuffer";
import NoteEditorHost from "./NoteEditorHost";
import OpenRepoHost from "./OpenRepoHost";
import ProjectTree from "./ProjectTree";
import RecentReposHost from "./RecentReposHost";
import StartupDashboard from "./StartupDashboard";
import { type CommandClose, type CommandId, useCommands } from "./useCommands";
import Window, { bufferHost } from "./Window";
import XrefHost from "./XrefHost";

/** Where typed characters are text: a field, or a CodeMirror editor in insert mode. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const editor = target.closest(".cm-editor");
  if (editor instanceof HTMLElement) {
    // The read-only viewer in vim normal mode takes the app's keys.
    const view = EditorView.findFromDOM(editor);
    return !view || inVimInsertMode(view);
  }
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}

/**
 * The global keymap (`keymap.ts`'s `global` scope: `M-x`, `C-x …`, `C-h …`), read on
 * the window before any buffer sees the key. Skipped while a modal or the minibuffer
 * has the keyboard, or text is being typed. Its own component so the command registry
 * it subscribes to doesn't re-render the buffers.
 */
function GlobalKeys() {
  const requestFocus = useUIStore((s) => s.requestFocus);
  const openMinibuffer = useMinibufferStore((s) => s.open);
  // A key has no minibuffer to close; it only hands focus back when asked to.
  const close = useCallback<CommandClose>(
    (options = {}) => {
      if (options.restoreFocus !== false) requestFocus();
    },
    [requestFocus],
  );
  const { commands, all } = useCommands(close);
  const latest = useRef({ commands, all });
  latest.current = { commands, all };

  useEffect(() => {
    const runCommand = (id: CommandId) => {
      const { commands, all } = latest.current;
      const command = all.find((c) => c.id === id);
      if (!command) return;
      if (!commands.includes(command) || !command.enabled) {
        useUIStore.getState().showFlash(`${command.name} isn't available here`);
        return;
      }
      void command.run();
    };
    const actions: Record<GlobalAction, KeyHandler> = {
      "execute-extended-command": () => openMinibuffer({ kind: "command" }),
      // Echo, then let the key on: a buffer may have something to quit (a selection).
      "keyboard-quit": () => {
        useUIStore.getState().showFlash("Quit");
        return false;
      },
    };
    const commandName = (binding: KeyBinding) =>
      binding.command
        ? (latest.current.all.find((c) => c.id === binding.command)?.name ?? null)
        : null;

    const onKey = (e: KeyboardEvent) => {
      if (useUIStore.getState().modalDepth > 0) return;
      if (isTypingTarget(e.target)) return;
      if (feedRepeat(e)) return;
      if (isDescribingKey()) {
        const scope = contextScope();
        describeNextKey(e, scope, [...KEYMAP.global, ...KEYMAP[scope]], commandName);
        return;
      }
      const chord = chordOf(e);
      if (!chord) return;
      settle(e, feedKey("global", chord, KEYMAP.global), (binding, keys) => {
        if (binding.command) {
          runCommand(binding.command);
          return true;
        }
        const handler = binding.action ? actions[binding.action as GlobalAction] : undefined;
        return handler ? handler(keys) !== false : false;
      });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openMinibuffer]);

  return null;
}

/** The windows, with the file tree beside them unless it's hidden. */
function Frame() {
  const treeHidden = useProjectStore((s) => s.treeHidden);
  const layout = useWindowStore((s) => s.layout);
  return (
    <div className="frame">
      {!treeHidden && <ProjectTree />}
      <div className="windows">
        <Window id={layout.id} />
      </div>
    </div>
  );
}

export default function AppShell() {
  const activeBuffer = useWindowStore(activeBufferOf);
  const showHelp = useWindowStore((s) => selectedBuffer(s) === "help");
  const vimMode = useUIStore((s) => s.vimMode);
  const hasRepo = !!useRepoStore((s) => s.repo);

  return (
    <div
      className="app-shell"
      data-buffer={activeBuffer}
      data-vim-mode={vimMode}
      data-repo={hasRepo ? "open" : "none"}
      tabIndex={-1}
    >
      <GlobalKeys />
      <div className="app-body">
        {hasRepo ? (
          <Frame />
        ) : showHelp ? (
          <div className="buffer-wrap">
            <HelpBuffer />
          </div>
        ) : (
          <StartupDashboard />
        )}
      </div>
      {/* Mounted once for as long as a repo is open, and moved into whichever window
          shows them (see Window.tsx) — which is also how leaving a commit lands back
          on its row in the log. */}
      {hasRepo && createPortal(<DiffBuffer />, bufferHost("diff"))}
      {hasRepo && createPortal(<LogBuffer />, bufferHost("log"))}
      {hasRepo && <BufferStatusBar />}
      <Minibuffer />
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
    </div>
  );
}
