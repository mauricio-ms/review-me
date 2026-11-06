import { useEffect, useRef, type ReactNode } from "react";

import { cancelGrep, editGrep, moveGrep, setGrepScope, visitGrepHit } from "../lib/grep";
import { dispatchKey, type KeyHandler } from "../lib/key-dispatch";
import { KEYMAP, type MinibufferAction } from "../lib/keymap";
import { useGrepStore } from "../state/grep";
import type { SearchHit } from "../types/grep";
import PathLabel from "./PathLabel";
import { useModalFocus } from "./useModalFocus";

function marked(hit: SearchHit): ReactNode {
  const pieces: ReactNode[] = [];
  let at = 0;
  for (const { from, to } of hit.ranges) {
    pieces.push(hit.snippet.slice(at, from));
    pieces.push(<mark className="mb-match" key={from}>{hit.snippet.slice(from, to)}</mark>);
    at = to;
  }
  pieces.push(hit.snippet.slice(at));
  return pieces;
}

/** A temporary horizontal picker below the current buffer, with no file previews. */
export default function GrepPrompt({ atPoint }: { atPoint: string | null }) {
  const { context, query, scope, results, selected, status, error } = useGrepStore();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectedRef = useRef<HTMLDivElement | null>(null);
  useModalFocus({ open: true, rootRef, initialFocusRef: inputRef });

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [results, selected]);

  const handlers: Record<MinibufferAction, KeyHandler> = {
    next: () => moveGrep(1),
    prev: () => moveGrep(-1),
    "yank-symbol": () => { if (atPoint) editGrep(atPoint); },
    complete: () => false,
    accept: () => visitGrepHit(selected),
    quit: cancelGrep,
    yes: () => false,
    no: () => false,
  };

  return (
    <div ref={rootRef} className="minibuffer grep-picker" role="dialog" aria-label="Grep" tabIndex={-1}
      onKeyDown={(e) => dispatchKey("minibuffer", e, KEYMAP.minibuffer, handlers)}>
      <div className="mb-line">
        <span className="mb-count" role="status" aria-live="polite">
          {results?.hits.length ? selected + 1 : 0}/{results?.hits.length ?? 0}{results?.truncated ? "+" : ""}
        </span>
        <label className="mb-prompt" htmlFor="grep-input">Grep:</label>
        <input id="grep-input" ref={inputRef} className="mb-input" value={query}
          role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="grep-results"
          aria-activedescendant={results?.hits[selected] ? `grep-hit-${selected}` : undefined}
          spellCheck={false} autoComplete="off" onChange={(e) => editGrep(e.target.value)} />
        <button type="button" className="grep-scope" onClick={() => {
          setGrepScope(scope === "repository" ? "changed" : "repository");
          inputRef.current?.focus();
        }} title="Toggle search scope">{scope === "repository" ? "repository" : "changed files"}</button>
        <span className="grep-revision" title={context?.choice.source.kind === "commit" ? context.choice.source.oid : undefined}>
          {context?.choice.label ?? "working tree"}
        </span>
        <span className="mb-hint">C-n / C-p choose · M-n symbol · RET open · C-g cancel</span>
      </div>
      <div id="grep-results" className="mb-list grep-list" role="listbox" aria-label="Matching lines" aria-busy={status === "loading"}>
        {results?.hits.length ? results.hits.map((hit, index) => (
          <div key={`${hit.path}:${hit.line}`} id={`grep-hit-${index}`}
            className={`grep-row${index === selected ? " is-selected" : ""}`} role="option" aria-selected={index === selected}
            ref={index === selected ? selectedRef : undefined} onClick={() => visitGrepHit(index)}>
            <span className="grep-location"><PathLabel path={hit.path} />:<span className="grep-line">{hit.line}</span>:</span>
            <span className="grep-snippet">{marked(hit)}</span>
          </div>
        )) : (
          <div className="mb-empty" role="status">
            {status === "loading" ? "Searching…" : status === "error" ? `Search failed: ${error}` :
              status === "cancelled" ? "Search stopped — edit the query to retry" :
                results ? "No matching lines" : "Type literal text to search · case insensitive until you type a capital"}
          </div>
        )}
      </div>
      {results && (results.truncated || results.skippedFiles > 0 || results.skippedLines > 0) && (
        <div className="grep-summary" role="status">
          {results.truncated && <span>Results limited to the first 1,000 matching lines; narrow the search. </span>}
          {results.skippedFiles > 0 && <span>{results.skippedFiles} files skipped (binary, invalid text, symlinks, unreadable, or over 2 MiB). </span>}
          {results.skippedLines > 0 && <span>{results.skippedLines} lines over 16 KiB skipped.</span>}
        </div>
      )}
    </div>
  );
}
