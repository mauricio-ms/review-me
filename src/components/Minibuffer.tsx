import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { bufferNames, openHelp, showBuffer, showDiff } from "../lib/buffers";
import { recordJump } from "../lib/jumps";
import { contextScope, dispatchKey, type KeyHandler } from "../lib/key-dispatch";
import { commandKeys, KEYMAP, type MinibufferAction } from "../lib/keymap";
import { showLog } from "../lib/log";
import { showProject } from "../lib/windows";
import { useFilesStore } from "../state/files";
import { useMinibufferStore, type MinibufferRequest } from "../state/minibuffer";
import { useRepoStore } from "../state/repo";
import { useUIStore, type PickerKind } from "../state/ui";
import {
  isFileKey,
  isProjectKey,
  selectedBuffer,
  useWindowStore,
  type BufferKey,
} from "../state/windows";
import { useXrefStore } from "../state/xref";
import { type CommandClose, useCommands } from "./useCommands";
import { useModalFocus } from "./useModalFocus";

/**
 * The bottom line of the window, Emacs-style: the echo area (messages, a half-typed
 * `C-x-`) while idle, the minibuffer while something is being read — a command
 * (`M-x`), a buffer (`C-x b`), or a line of text. It sits under the mode line and
 * grows upward with its candidates, pushing the buffers up rather than covering them.
 */
/** Pickers that read in the minibuffer's place (the rest are centered dialogs). */
const DOCKED_PICKERS = new Set<PickerKind>([
  "openRepo",
  "recentRepos",
  "fuzzyFiles",
  "branchCompare",
  "commitPick",
  "checkoutBranch",
]);

export default function Minibuffer() {
  const request = useMinibufferStore((s) => s.request);
  const session = useMinibufferStore((s) => s.session);
  // A docked picker (NeoPicker, xref) is the minibuffer while it's open.
  const pickerDocked = useUIStore((s) => DOCKED_PICKERS.has(s.picker));
  const xrefOpen = useXrefStore((s) => s.open);
  if (request) return <Prompt key={session} request={request} />;
  if (pickerDocked || xrefOpen) return null;
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

/** The buffers that always exist, after whatever was shown most recently. */
const STANDING: BufferKey[] = ["diff", "log", "project", "help"];

/** The name column's width for a list of buffers: the longest name, 16 to 48ch. */
function nameWidth(candidates: Candidate[] | null): number {
  const longest = Math.max(0, ...(candidates ?? []).map((c) => [...c.name].length));
  return Math.min(48, Math.max(16, longest + 1));
}

function Prompt({ request }: { request: MinibufferRequest }) {
  const closeMinibuffer = useMinibufferStore((s) => s.close);
  const requestFocus = useUIStore((s) => s.requestFocus);
  const showFlash = useUIStore((s) => s.showFlash);
  const shownBuffer = useWindowStore(selectedBuffer);
  const recent = useWindowStore((s) => s.recent);
  const fileBuffers = useFilesStore((s) => s.buffers);
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
    if (request.kind === "choice") {
      return request.choices.map((choice) => ({
        ...choice,
        aliases: [],
        key: null,
        enabled: true,
        run: () => {
          close({ restoreFocus: false });
          request.onAccept(choice.id);
        },
      }));
    }
    if (request.kind === "buffer") {
      const other = request.other ?? false;
      const label = {
        diff: "the changes under review",
        log: `commits on ${reviewBranch?.display ?? "HEAD"}`,
        project: "the files of the revision under review",
        help: "every key binding and command",
      };
      const files = new Map(fileBuffers.map((b) => [b.id, b]));
      const names = bufferNames(fileBuffers);
      // Most recently shown first, so RET alone goes back to the buffer you came from,
      // as in Emacs; then the rest, open files last.
      const order = [
        ...new Set<BufferKey>([...recent, ...STANDING, ...fileBuffers.map((b) => b.id)]),
      ].filter(
        (key) =>
          key !== shownBuffer &&
          (!isFileKey(key) || files.has(key)) &&
          // Already in the project buffer: `project` is where you are.
          !(key === "project" && isProjectKey(shownBuffer)),
      );
      return order.map((key) => {
        const file = isFileKey(key) ? files.get(key) : undefined;
        return {
          id: key,
          name: file ? (names.get(file.id) ?? file.path) : key,
          aliases: key === "log" ? ["commits"] : [],
          key: null,
          // A file's whole path (typing any folder of it narrows to it), and the
          // revision when it isn't the working tree.
          label: file
            ? `${file.path}${file.sourceLabel ? ` @ ${file.sourceLabel}` : ""}`
            : label[key as keyof typeof label],
          enabled: true,
          run: () => {
            close({ restoreFocus: false });
            // A switch is a move `M-,` comes back from (help is nowhere to come back to).
            if (key !== "help") recordJump();
            if (key === "log") showLog({ other });
            else if (key === "help") openHelp(scope, false, { other });
            else if (key === "project" && !other) showProject();
            else if (key === "diff") showDiff({ other });
            else showBuffer(key, { other });
          },
        };
      });
    }
    return null;
  }, [
    close,
    commands,
    fileBuffers,
    recent,
    request,
    reviewBranch,
    scope,
    shownBuffer,
    showFlash,
  ]);

  const [query, setQuery] = useState(request.kind === "text" ? (request.initial ?? "") : "");
  // -1 is "nothing selected": a bare `M-x` lists every command but RET runs none of
  // them until a row is picked or the list is narrowed by typing. `C-x b` preselects
  // the buffer you came from, and a choice its first candidate.
  const picksDefault = request.kind === "buffer" || request.kind === "choice";
  const [selected, setSelected] = useState(picksDefault ? 0 : -1);
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
        ? `Switch to buffer${request.other ? " in other window" : ""}${
            candidates?.[0] ? ` (default ${candidates[0].name})` : ""
          }:`
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
            else setSelected(value.trim() || picksDefault ? 0 : -1);
          }}
        />
      </div>
      {rows && (
        <div
          className={`mb-list${picksDefault ? " is-names" : ""}`}
          role="listbox"
          aria-label="Candidates"
          // Buffer and choice names are file names, which are never cut: the column
          // fits the longest one (within reason).
          style={
            picksDefault
              ? ({ "--mb-name-width": `${nameWidth(candidates)}ch` } as CSSProperties)
              : undefined
          }
        >
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
