import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  defineCommitMessageVim,
  setCommitMessageActions,
} from "../editor/vim-commit";
import { gruberDarkerTheme } from "../editor/gruber-darker";
import {
  cancelReviewedCommit,
  finishReviewedCommit,
  preflightReviewedCommit,
  stageReviewedCommit,
} from "../lib/review-commit";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import { readsCommittedHistory } from "../types/diff";
import type {
  PreparedReviewedCommit,
  ReviewedCommitPreflight,
} from "../types/review-commit";
import { useModalFocus } from "./useModalFocus";

type Phase = "loading" | "confirm" | "preparing" | "editor" | "empty" | "error";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function pathPreview(paths: string[]): string {
  const shown = paths.slice(0, 8).map((path) => `#\t${path}`);
  if (paths.length > shown.length) {
    shown.push(`#\t...and ${paths.length - shown.length} more`);
  }
  return shown.join("\n");
}

function commitTemplate(prepared: PreparedReviewedCommit): string {
  const unsupported =
    prepared.unsupportedReviewedCount > 0
      ? `# Note: ${prepared.unsupportedReviewedCount} reviewed change${
          prepared.unsupportedReviewedCount === 1 ? "" : "s"
        } could not be staged.\n#\n`
      : "";
  const lines = [
    "",
    "# Please enter the commit message for your reviewed changes.",
    "# Lines starting with '#' will be ignored.",
    "# :wq or :x commits. :q or :cq aborts and unstages.",
    "#",
    `# Reviewed units staged: ${prepared.hunkCount}`,
    "# Changes to be committed:",
    pathPreview(prepared.stagedPaths),
  ];
  if (unsupported) lines.push(unsupported.trimEnd());
  return lines.join("\n");
}

export default function CommitReviewedHost() {
  const open = useUIStore((s) => s.picker === "commitReviewed");
  const closePicker = useUIStore((s) => s.closePicker);
  const requestFocus = useUIStore((s) => s.requestFocus);
  const comparingHistory = useRepoStore((s) =>
    readsCommittedHistory(s.comparison),
  );

  const modalRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<EditorView | null>(null);
  useModalFocus({ open, rootRef: modalRef, initialFocusRef: modalRef });

  const [phase, setPhase] = useState<Phase>("loading");
  const [preflight, setPreflight] = useState<ReviewedCommitPreflight | null>(null);
  const [prepared, setPrepared] = useState<PreparedReviewedCommit | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    defineCommitMessageVim();
  }, []);

  const close = useCallback(() => {
    closePicker();
    requestFocus();
  }, [closePicker, requestFocus]);

  const prepare = useCallback(async (unstageExisting: boolean) => {
    setPhase("preparing");
    setError(null);
    setBusy(true);
    try {
      const next = await stageReviewedCommit(unstageExisting);
      setPrepared(next);
      if (next.hunkCount === 0) {
        setPhase("empty");
        return;
      }
      setMessage(commitTemplate(next));
      setPhase("editor");
    } catch (e) {
      setError(errorMessage(e));
      setPhase("error");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase("loading");
    setPreflight(null);
    setPrepared(null);
    setMessage("");
    setError(null);
    // The `:commit` command is disabled while reviewing committed history, but
    // staging is destructive enough to be worth refusing here too rather than
    // trusting the caller.
    if (comparingHistory) {
      setError(
        "Committing reviewed changes applies to the working-tree diff. " +
          "This comparison is committed history already — " +
          "switch back with :worktree (Space g w) first.",
      );
      setPhase("error");
      return;
    }
    setBusy(true);
    void preflightReviewedCommit()
      .then((next) => {
        if (cancelled) return;
        setPreflight(next);
        if (next.reviewedHunkCount === 0) {
          setPhase("empty");
          return;
        }
        if (next.stagedPaths.length > 0) {
          setPhase("confirm");
          return;
        }
        return prepare(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(errorMessage(e));
        setPhase("error");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [comparingHistory, open, prepare]);

  const abortEditor = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await cancelReviewedCommit();
      close();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [busy, close]);

  const submit = useCallback(async () => {
    if (busy || !prepared) return;
    setBusy(true);
    setError(null);
    try {
      await finishReviewedCommit(message, prepared.reviewedTagIds);
      close();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [busy, close, message, prepared]);

  useEffect(() => {
    if (!open || phase !== "editor") {
      setCommitMessageActions(null);
      return;
    }
    setCommitMessageActions({
      commit: () => void submit(),
      abort: () => void abortEditor(),
    });
    return () => setCommitMessageActions(null);
  }, [abortEditor, open, phase, submit]);

  const extensions = useMemo(
    () => [
      vim(),
      Prec.highest(
        keymap.of([
          {
            key: "Ctrl-Enter",
            run: () => {
              void submit();
              return true;
            },
          },
        ]),
      ),
      EditorView.lineWrapping,
    ],
    [submit],
  );

  if (!open) return null;

  const count =
    phase === "editor" && prepared
      ? String(prepared.hunkCount)
      : preflight
        ? String(preflight.reviewedHunkCount)
        : "";
  const title = phase === "editor" ? "Commit Message" : "Commit Reviewed";
  const footer =
    phase === "editor"
      ? busy
        ? "working..."
        : ":wq commit · :q abort · Ctrl+Enter commit"
      : phase === "confirm"
        ? "y / Enter unstage and continue · n / Esc cancel"
        : "Enter / Esc close";

  return (
    <div className="asset-picker-backdrop">
      <div
        ref={modalRef}
        className="asset-picker neo-picker commit-reviewed"
        role="dialog"
        aria-modal="true"
        aria-label="Commit reviewed changes"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (phase === "confirm") {
            if (e.key === "Escape" || e.key === "n") {
              e.preventDefault();
              close();
            } else if (e.key === "y" || e.key === "Enter") {
              e.preventDefault();
              void prepare(true);
            }
          } else if (phase === "empty" || phase === "error") {
            if (e.key === "Escape" || e.key === "Enter") {
              e.preventDefault();
              close();
            }
          }
        }}
      >
        <div className="neo-title">{title}</div>
        <div className="neo-count">{count}</div>

        {phase === "editor" && prepared ? (
          <div className="commit-editor-shell">
            <CodeMirror
              value={message}
              extensions={extensions}
              theme={gruberDarkerTheme}
              height="100%"
              onChange={setMessage}
              onCreateEditor={(view) => {
                editorRef.current = view;
                window.requestAnimationFrame(() => view.focus());
              }}
              basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                highlightActiveLine: true,
                highlightSelectionMatches: false,
              }}
            />
          </div>
        ) : (
          <div className="commit-reviewed-body">
            {phase === "loading" && "Inspecting reviewed changes..."}
            {phase === "preparing" && "Staging reviewed hunks..."}
            {phase === "confirm" && preflight && (
              <>
                <div>
                  {plural(preflight.stagedPaths.length, "path")} already staged.
                  Continuing will reset only the staging area to HEAD, leave working
                  tree files untouched, then stage reviewed hunks.
                </div>
                <div className="commit-path-list">
                  {preflight.stagedPaths.slice(0, 8).map((path) => (
                    <div key={path}>{path}</div>
                  ))}
                  {preflight.stagedPaths.length > 8 && (
                    <div>...and {preflight.stagedPaths.length - 8} more</div>
                  )}
                </div>
              </>
            )}
            {phase === "empty" && (
              <>
                <div>No reviewed changes are ready to commit.</div>
                {preflight?.unsupportedReviewedCount || prepared?.unsupportedReviewedCount ? (
                  <div className="commit-warning">
                    Some reviewed changes could not be staged.
                  </div>
                ) : null}
              </>
            )}
            {phase === "error" && error && <div className="commit-error">{error}</div>}
          </div>
        )}

        {phase === "editor" && error && <div className="commit-error">{error}</div>}
        <div className="neo-footer">
          <span>{error && phase === "editor" ? error : footer}</span>
        </div>
      </div>
    </div>
  );
}
