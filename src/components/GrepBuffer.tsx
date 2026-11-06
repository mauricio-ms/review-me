import { Fragment, useEffect, useRef, type ReactNode } from "react";

import { quitWindow } from "../lib/buffers";
import { cancelGrep, moveGrep, openGrep, runGrep, setGrepScope, visitGrepHit } from "../lib/grep";
import { dispatchKey, type KeyHandler } from "../lib/key-dispatch";
import { KEYMAP, type GrepAction } from "../lib/keymap";
import { useGrepStore } from "../state/grep";
import { useUIStore } from "../state/ui";
import { hasKeyboard, isShown, useWindowStore } from "../state/windows";
import type { SearchHit } from "../types/grep";
import PathLabel from "./PathLabel";

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

/** A single persistent buffer, moved between windows like the diff and log. */
export default function GrepBuffer() {
  const state = useGrepStore();
  const { context, query, scope, results, selected, status, error } = state;
  const focused = useWindowStore((s) => hasKeyboard(s, "grep"));
  const visible = useWindowStore((s) => isShown(s, "grep"));
  const focusRequest = useUIStore((s) => s.focusRequest);
  const modalDepth = useUIStore((s) => s.modalDepth);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (focused && modalDepth === 0) rootRef.current?.focus({ preventScroll: true });
  }, [focused, focusRequest, modalDepth]);

  useEffect(() => {
    if (visible) selectedRef.current?.scrollIntoView({ block: "nearest" });
    if (focused && results?.hits[selected]) visitGrepHit(selected, false);
  }, [focused, results, selected, visible]);

  const handlers: Record<GrepAction, KeyHandler> = {
    down: () => moveGrep(1), up: () => moveGrep(-1),
    first: () => state.select(0), last: () => state.select((results?.hits.length ?? 1) - 1),
    open: () => visitGrepHit(selected, true), search: openGrep,
    scope: () => setGrepScope(scope === "repository" ? "changed" : "repository"),
    refresh: () => { void runGrep(); }, cancel: cancelGrep, quit: quitWindow,
  };

  return (
    <div ref={rootRef} className="grep-buffer" tabIndex={0} aria-label="Grep results"
      onKeyDown={(e) => dispatchKey("grep", e, KEYMAP.grep, handlers)}>
      <div className="grep-header">
        <strong>Grep{query ? `: ${query}` : ""}</strong>
        <span>{scope === "repository" ? "repository" : "changed files"}</span>
        <span className="grep-revision" title={context?.choice.source.kind === "commit" ? context.choice.source.oid : undefined}>
          {context ? (context.choice.label ?? "working tree") : "no search"}
        </span>
        <span className="grep-hint">/ search · s scope · RET open · q quit</span>
      </div>
      <div className="grep-summary" role="status" aria-live="polite">
        {status === "loading" ? "Searching…" : status === "error" ? `Search failed: ${error}` : status === "cancelled" ? "Search cancelled — r to retry" : results ?
          `${results.hits.length}${results.truncated ? "+" : ""} matching line${results.hits.length === 1 ? "" : "s"}${results.truncated ? " — results limited to the first 1,000 matching lines; narrow the search" : ""}` :
          "M-x grep or / to search · literal text · case insensitive until you type a capital"}
        {!!results?.skippedFiles && <span> · {results.skippedFiles} files skipped (binary, invalid text, symlinks, unreadable, or over 2 MiB)</span>}
        {!!results?.skippedLines && <span> · {results.skippedLines} lines over 16 KiB skipped</span>}
      </div>
      <div className="grep-list" role="listbox" aria-label="Matching lines" aria-busy={status === "loading"}>
        {results?.hits.map((hit, index, hits) => (
          <Fragment key={`${hit.path}:${hit.line}`}>
            {(index === 0 || hits[index - 1].path !== hit.path) && (
              <div className="grep-file"><PathLabel path={hit.path} mode="wrap" /></div>
            )}
            <div className={`grep-row${index === selected ? " is-selected" : ""}`} role="option"
              aria-selected={index === selected} ref={index === selected ? selectedRef : undefined}
              onClick={() => { state.select(index); visitGrepHit(index, true); }}>
              <span className="grep-line">{hit.line}:{hit.col + 1}</span>
              <span className="grep-snippet">{marked(hit)}</span>
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
