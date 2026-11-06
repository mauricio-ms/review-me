import { useRef } from "react";

import { cancelGrep, editGrep, finishGrep, moveGrep, setGrepScope, visitGrepHit } from "../lib/grep";
import { dispatchKey, type KeyHandler } from "../lib/key-dispatch";
import { KEYMAP, type MinibufferAction } from "../lib/keymap";
import { useGrepStore } from "../state/grep";
import { useModalFocus } from "./useModalFocus";

/** Live input lives in the minibuffer; its matches stay in the grep buffer. */
export default function GrepPrompt({ atPoint }: { atPoint: string | null }) {
  const query = useGrepStore((s) => s.query);
  const scope = useGrepStore((s) => s.scope);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useModalFocus({ open: true, rootRef, initialFocusRef: inputRef });

  const handlers: Record<MinibufferAction, KeyHandler> = {
    next: () => moveGrep(1),
    prev: () => moveGrep(-1),
    "yank-symbol": () => { if (atPoint) editGrep(atPoint); },
    complete: () => false,
    accept: () => {
      finishGrep();
      visitGrepHit(useGrepStore.getState().selected, true);
    },
    quit: () => { cancelGrep(); finishGrep(); },
    yes: () => false,
    no: () => false,
  };

  return (
    <div ref={rootRef} className="minibuffer" role="dialog" aria-label="Grep" tabIndex={-1}
      onKeyDown={(e) => dispatchKey("minibuffer", e, KEYMAP.minibuffer, handlers)}>
      <div className="mb-line">
        <label className="mb-prompt" htmlFor="grep-input">Grep:</label>
        <input id="grep-input" ref={inputRef} className="mb-input" value={query}
          spellCheck={false} autoComplete="off" onChange={(e) => editGrep(e.target.value)} />
        <button type="button" className="grep-scope" onClick={() => {
          setGrepScope(scope === "repository" ? "changed" : "repository");
          inputRef.current?.focus();
        }} title="Toggle search scope">{scope === "repository" ? "repository" : "changed files"}</button>
        <span className="mb-hint">C-n / C-p preview · M-n symbol · RET open · C-g stop</span>
      </div>
    </div>
  );
}
