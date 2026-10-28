import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { gruberDarkerTheme } from "../editor/gruber-darker";
import { claimModalEditor, defineModalEditorVim } from "../editor/vim-modal";
import type { DiffTarget } from "../lib/diff-view";
import { dispatchKey, type KeyHandler } from "../lib/key-dispatch";
import { KEYMAP, type EditorAction } from "../lib/keymap";
import { saveNote } from "../lib/review-actions";
import { useNotesStore, type NoteEdit } from "../state/notes";
import { useUIStore } from "../state/ui";
import PathLabel from "./PathLabel";
import { useModalFocus } from "./useModalFocus";

const HINT = "C-c C-c save & close · C-c C-k discard · :w save · :wq / :q! from vim";

// Module-level so its identity is stable: the wrapper reconfigures the whole editor
// whenever `basicSetup` changes, and an inline object changes on every keystroke.
// No autocompletion: Markdown offers HTML completions, and while one is pending its
// Escape binding (close completion) eats the <Esc> meant to leave insert mode. No
// bracket closing either — backticks in prose shouldn't pair themselves.
const BASIC_SETUP = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: true,
  highlightSelectionMatches: false,
  autocompletion: false,
  closeBrackets: false,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `lines 40–52`, naming the old side when the lines were removed. */
function linesLabel(target: DiffTarget): string {
  if (target.side === "file") return "whole file";
  const lines =
    target.lo === target.hi ? `line ${target.lo}` : `lines ${target.lo}–${target.hi}`;
  return `${lines}${target.side === "old" ? " (removed)" : ""}`;
}

/**
 * The review-note editor (`M-x note`): Markdown in a vim buffer, saved onto the flag at
 * the cursor — or, on unflagged lines, flagging them with the note on first save. The
 * note is a fix left for later; the commit's notes are exported for an LLM to act on.
 */
export default function NoteEditorHost() {
  const editing = useNotesStore((s) => s.editing);
  const session = useNotesStore((s) => s.session);
  const [markdown, setMarkdown] = useState<LanguageSupport | null>(null);

  // Loaded up front, so an open editor is never reconfigured under the reviewer.
  useEffect(() => {
    defineModalEditorVim();
    let cancelled = false;
    void LanguageDescription.matchFilename(languages, "note.md")
      ?.load()
      .then((support) => {
        if (!cancelled) setMarkdown(support);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!editing) return null;
  // Keyed by session: every opening starts from the note as saved.
  return <NoteEditor key={session} edit={editing} markdown={markdown} />;
}

function NoteEditor({
  edit,
  markdown,
}: {
  edit: NoteEdit;
  markdown: LanguageSupport | null;
}) {
  const markSaved = useNotesStore((s) => s.saved);
  const closeNote = useNotesStore((s) => s.close);
  const requestFocus = useUIStore((s) => s.requestFocus);

  const modalRef = useRef<HTMLDivElement | null>(null);
  useModalFocus({ open: true, rootRef: modalRef, initialFocusRef: modalRef });

  // Uncontrolled: the editor owns the document from the opening text on. Feeding
  // `text` back as `value` makes the wrapper replace the whole document whenever React
  // lags fast typing, and that replacement swallows a quick <Esc> out of insert mode.
  const [initial] = useState(edit.saved);
  const [text, setText] = useState(edit.saved);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Decided once, from what the note held when it opened.
  const startInInsert = useRef(edit.saved === "");

  const dirty = text.trimEnd() !== edit.saved;

  const close = useCallback(() => {
    closeNote();
    requestFocus();
  }, [closeNote, requestFocus]);

  const save = useCallback(
    async (andClose: boolean) => {
      const current = useNotesStore.getState().editing;
      if (!current || busy) return;
      setBusy(true);
      setMessage(null);
      try {
        const flagId = await saveNote(current, text);
        if (flagId) markSaved(flagId, text.trim() === "" ? "" : text.trimEnd());
        if (andClose) close();
        else setMessage(flagId ? "saved" : "nothing to save");
      } catch (e) {
        setMessage(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, close, markSaved, text],
  );

  const quit = useCallback(
    (force: boolean) => {
      if (dirty && !force) {
        setMessage("unsaved changes — C-c C-c or :w to save, C-c C-k or :q! to discard");
        return;
      }
      close();
    },
    [close, dirty],
  );

  useEffect(
    () =>
      claimModalEditor({
        write: () => void save(false),
        writeQuit: () => void save(true),
        quit,
      }),
    [quit, save],
  );

  // The editor's extensions must not change while typing — a reconfigure per keystroke
  // races vim's own key handling — so they hold no callbacks: the Emacs keys that
  // finish the edit are read on the dialog, before the editor sees them.
  const extensions = useMemo(
    () => [
      // Vim reads keys before any other keymap, as codemirror-vim asks.
      Prec.highest(vim()),
      EditorView.lineWrapping,
      ...(markdown ? [markdown] : []),
    ],
    [markdown],
  );

  const keyHandlers: Record<EditorAction, KeyHandler> = {
    finish: () => void save(true),
    // with-editor-cancel: the edit is dropped, the note stays as last saved.
    cancel: () => quit(true),
  };

  return (
    <div className="asset-picker-backdrop">
      <div
        ref={modalRef}
        className="asset-picker neo-picker note-editor"
        role="dialog"
        aria-modal="true"
        aria-label="Review note"
        tabIndex={-1}
        // Capture: `C-c` must reach us before vim takes it as <Esc>.
        onKeyDownCapture={(e) => dispatchKey("editor", e, KEYMAP.editor, keyHandlers)}
      >
        <div className="neo-title">Note</div>
        <div className="note-target">
          <PathLabel path={edit.target.file} /> · {linesLabel(edit.target)}
          {edit.flagId ? "" : " · saving flags these lines"}
        </div>
        <div className="commit-editor-shell note-editor-shell">
          <CodeMirror
            value={initial}
            extensions={extensions}
            theme={gruberDarkerTheme}
            height="100%"
            onChange={setText}
            onCreateEditor={(view) => {
              window.requestAnimationFrame(() => {
                view.focus();
                // A new note starts in insert mode; an existing one in normal mode.
                const cm = getCM(view);
                if (cm && startInInsert.current) Vim.handleKey(cm, "i", "mapping");
              });
            }}
            basicSetup={BASIC_SETUP}
          />
        </div>
        <div className="neo-footer">
          <span>{busy ? "saving…" : (message ?? HINT)}</span>
          {dirty && !busy && <span className="note-dirty">modified</span>}
        </div>
      </div>
    </div>
  );
}
