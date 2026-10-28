import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { contextScope, dispatchKey, type KeyHandler } from "../lib/key-dispatch";
import { commandKeys, KEYMAP, type MinibufferAction } from "../lib/keymap";
import { showLog } from "../lib/log";
import { useMinibufferStore, type MinibufferRequest } from "../state/minibuffer";
import { useRepoStore } from "../state/repo";
import { useUIStore, type BufferName } from "../state/ui";
import { type CommandClose, useCommands } from "./useCommands";
import { useModalFocus } from "./useModalFocus";

/**
 * The bottom line of the window, Emacs-style: the echo area (messages, a half-typed
 * `C-x-`) while idle, the minibuffer while something is being read — a command
 * (`M-x`), a buffer (`C-x b`), or a line of text. It sits under the mode line and
 * grows upward with its candidates, pushing the buffers up rather than covering them.
 */
export default function Minibuffer() {
  const request = useMinibufferStore((s) => s.request);
  const session = useMinibufferStore((s) => s.session);
  if (request) return <Prompt key={session} request={request} />;
  return <EchoArea />;
}

function EchoArea() {
  const flash = useUIStore((s) => s.flash);
  const keyEcho = useUIStore((s) => s.keyEcho);
  return (
    <div className="echo-area" role="status" aria-live="polite">
      {keyEcho ?? flash ?? ""}
    </div>
  );
}

type Candidate = {
  id: string;
  name: string;
  aliases: string[];
  /** The key that runs it, shown beside the name. */
  key: string | null;
  label: string;
  enabled: boolean;
  /** Runs it; responsible for closing the minibuffer. */
  run: () => void;
};

/**
 * Lower rank = better match; null = no match. An exact name or alias wins outright,
 * so a short command (`diff`) is never shadowed by a longer one it prefixes.
 */
function rank(candidate: Candidate, query: string): number | null {
  const name = candidate.name.toLowerCase();
  const aliases = candidate.aliases.map((alias) => alias.toLowerCase());
  if (name === query || aliases.includes(query)) return 0;
  if (name.startsWith(query)) return 1;
  if (aliases.some((alias) => alias.startsWith(query))) return 2;
  if (name.includes(query)) return 3;
  if (candidate.label.toLowerCase().includes(query)) return 4;
  return null;
}

/** `text` with the first occurrence of `query` marked. */
function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const at = text.toLowerCase().indexOf(query);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="mb-match">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

const BUFFER_ORDER: BufferName[] = ["diff", "log", "project", "help"];

function Prompt({ request }: { request: MinibufferRequest }) {
  const closeMinibuffer = useMinibufferStore((s) => s.close);
  const requestFocus = useUIStore((s) => s.requestFocus);
  const showFlash = useUIStore((s) => s.showFlash);
  const activeBuffer = useUIStore((s) => s.activeBuffer);
  const previousBuffer = useUIStore((s) => s.previousBuffer);
  const reviewBranch = useRepoStore((s) => s.reviewBranch);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useModalFocus({ open: true, rootRef, initialFocusRef: inputRef });

  const close = useCallback<CommandClose>(
    (options = {}) => {
      closeMinibuffer();
      if (options.restoreFocus !== false) requestFocus();
    },
    [closeMinibuffer, requestFocus],
  );

  const { commands } = useCommands(close);
  // The keymap in force when the minibuffer opened: the one M-x shows keys from.
  const [scope] = useState(contextScope);

  const candidates = useMemo<Candidate[] | null>(() => {
    if (request.kind === "command") {
      return commands.map((command) => {
        const key = commandKeys(command.id, scope);
        return {
          id: command.id,
          name: command.name,
          aliases: command.aliases,
          key,
          label: command.label,
          enabled: command.enabled,
          run: () => {
            // Emacs's suggest-key-bindings; a command's own message replaces it.
            if (key) showFlash(`You can run the command ‘${command.name}’ with ${key}`);
            void command.run();
          },
        };
      });
    }
    if (request.kind === "buffer") {
      const label: Record<BufferName, string> = {
        diff: "the changes under review",
        log: `commits on ${reviewBranch?.display ?? "HEAD"}`,
        project: "the files of the revision under review",
        help: "every key binding and command",
      };
      // The buffer you came from first: RET alone goes back to it, as in Emacs.
      const order = [
        previousBuffer,
        ...BUFFER_ORDER.filter((b) => b !== previousBuffer),
      ].filter((b) => b !== activeBuffer);
      return order.map((buffer) => ({
        id: buffer,
        name: buffer,
        aliases: buffer === "log" ? ["commits"] : [],
        key: null,
        label: label[buffer],
        enabled: true,
        run: () => {
          close({ restoreFocus: false });
          const ui = useUIStore.getState();
          if (buffer === "log") showLog();
          else if (buffer === "help") ui.openHelp(scope, false);
          else {
            ui.setActiveBuffer(buffer);
            ui.requestFocus();
          }
        },
      }));
    }
    return null;
  }, [
    activeBuffer,
    close,
    commands,
    previousBuffer,
    request.kind,
    reviewBranch,
    scope,
    showFlash,
  ]);

  const [query, setQuery] = useState(request.kind === "text" ? (request.initial ?? "") : "");
  // -1 is "nothing selected": a bare `M-x` lists every command but RET runs none of
  // them until a row is picked or the list is narrowed by typing. `C-x b` preselects
  // the buffer you came from.
  const [selected, setSelected] = useState(request.kind === "buffer" ? 0 : -1);
  const needle = query.trim().toLowerCase();

  const rows = useMemo(() => {
    if (!candidates) return null;
    if (!needle) return candidates;
    return candidates
      .map((candidate, index) => ({ candidate, index, rank: rank(candidate, needle) }))
      .filter((entry) => entry.rank !== null)
      .sort((a, b) => a.rank! - b.rank! || a.index - b.index)
      .map((entry) => entry.candidate);
  }, [candidates, needle]);

  const current = rows && selected >= 0 ? rows[Math.min(selected, rows.length - 1)] : undefined;

  const move = (delta: number) => {
    if (!rows || rows.length === 0) return;
    setSelected((at) =>
      at < 0
        ? delta > 0
          ? 0
          : rows.length - 1
        : (Math.min(at, rows.length - 1) + delta + rows.length) % rows.length,
    );
  };

  const cancel = () => {
    if (request.kind === "text") request.onCancel?.();
    close();
  };

  const accept = () => {
    if (request.kind === "text") {
      close();
      request.onAccept(query);
      return;
    }
    if (current?.enabled) current.run();
  };

  const handlers: Record<MinibufferAction, KeyHandler> = {
    next: () => {
      if (!rows) return false;
      move(1);
    },
    prev: () => {
      if (!rows) return false;
      move(-1);
    },
    complete: () => {
      if (!rows) return;
      if (current) {
        setQuery(current.name);
        setSelected(0);
      } else {
        move(1);
      }
    },
    accept,
    quit: cancel,
  };

  // The list opens under wherever the pointer rests; only a real move selects, so a
  // pointer that happens to be there can't pick what RET runs.
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  const prompt =
    request.kind === "command"
      ? "M-x"
      : request.kind === "buffer"
        ? `Switch to buffer${candidates?.[0] ? ` (default ${candidates[0].name})` : ""}:`
        : request.prompt;

  return (
    <div
      ref={rootRef}
      className="minibuffer"
      role="dialog"
      aria-label={prompt}
      tabIndex={-1}
      onKeyDown={(e) => dispatchKey("minibuffer", e, KEYMAP.minibuffer, handlers)}
    >
      <div className="mb-line">
        {rows && (
          <span className="mb-count">
            {selected >= 0 && rows.length > 0 ? Math.min(selected, rows.length - 1) + 1 : 0}/
            {rows.length}
          </span>
        )}
        <label className="mb-prompt" htmlFor="minibuffer-input">
          {prompt}
        </label>
        <input
          id="minibuffer-input"
          ref={inputRef}
          className="mb-input"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            const value = e.target.value;
            setQuery(value);
            if (request.kind === "text") request.onChange?.(value);
            // Typing narrows to the best match; clearing back to nothing picks
            // nothing again (except `C-x b`, whose default stays picked).
            else setSelected(value.trim() || request.kind === "buffer" ? 0 : -1);
          }}
        />
      </div>
      {rows && (
        <div className="mb-list" role="listbox" aria-label="Candidates">
          {rows.length === 0 ? (
            <div className="mb-empty">[No match]</div>
          ) : (
            rows.map((row, index) => (
              <div
                key={row.id}
                role="option"
                aria-selected={row === current}
                ref={(el) => {
                  if (el && row === current) {
                    window.requestAnimationFrame(() => el.scrollIntoView({ block: "nearest" }));
                  }
                }}
                className={`mb-row${row === current ? " is-selected" : ""}${
                  row.enabled ? "" : " is-disabled"
                }`}
                onPointerMove={(e) => {
                  const next = { x: e.clientX, y: e.clientY };
                  const prev = pointerRef.current;
                  pointerRef.current = next;
                  if (prev && prev.x === next.x && prev.y === next.y) return;
                  setSelected(index);
                }}
                onClick={() => {
                  if (row.enabled) row.run();
                }}
              >
                <span className="mb-name">{highlight(row.name, needle)}</span>
                <span className="mb-key">{row.key ?? ""}</span>
                <span className="mb-label">
                  {row.name.toLowerCase().includes(needle) ? row.label : highlight(row.label, needle)}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
