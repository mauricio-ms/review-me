import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useUIStore } from "../state/ui";
import { type AppCommand, type CommandClose, useCommands } from "./useCommands";
import { useModalFocus } from "./useModalFocus";

/** Lower rank = better match. `null` means no match. */
function rankCommand(command: AppCommand, query: string): number | null {
  const name = command.name.toLowerCase();
  if (name.startsWith(query)) return 0;
  if (command.aliases.some((alias) => alias.toLowerCase().startsWith(query))) {
    return 1;
  }
  if (name.includes(query)) return 2;
  if (command.label.toLowerCase().includes(query)) return 3;
  return null;
}

export default function CommandLine() {
  const closeCommandLine = useUIStore((s) => s.closeCommandLine);
  const requestFocus = useUIStore((s) => s.requestFocus);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  useModalFocus({ open: true, rootRef: modalRef, initialFocusRef: inputRef });

  const rawClose = useCallback<CommandClose>(
    (options = {}) => {
      setQuery("");
      setSelected(0);
      closeCommandLine();
      if (options.restoreFocus !== false) requestFocus();
    },
    [closeCommandLine, requestFocus],
  );

  const { commands, busy } = useCommands(rawClose);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // Noice-style: no completion list until something is typed.
    if (!needle) return [];
    return commands
      .map((command, index) => ({
        command,
        index,
        rank: rankCommand(command, needle),
      }))
      .filter((entry) => entry.rank !== null)
      .sort((a, b) => a.rank! - b.rank! || a.index - b.index)
      .map((entry) => entry.command);
  }, [commands, query]);

  useEffect(() => {
    setSelected((current) =>
      rows.length === 0 ? 0 : Math.min(current, rows.length - 1),
    );
  }, [rows]);

  const selectedRow = rows[selected];

  const move = (delta: number) => {
    if (rows.length === 0) return;
    setSelected((current) => (current + delta + rows.length) % rows.length);
  };

  const run = (command: AppCommand | undefined) => {
    if (command && command.enabled) void command.run();
  };

  const hasQuery = query.trim().length > 0;
  const count = !hasQuery
    ? ""
    : rows.length === 0
      ? "0/0"
      : `${selected + 1}/${rows.length}`;
  const footer = busy ? `${busy}...` : (selectedRow?.label ?? "type a command");

  return (
    <div className="asset-picker-backdrop">
      <div
        ref={modalRef}
        className="asset-picker neo-picker command-line"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            rawClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Tab") {
            e.preventDefault();
            if (selectedRow) {
              setQuery(selectedRow.name);
              setSelected(0);
            }
          } else if (e.key === "Enter") {
            e.preventDefault();
            run(selectedRow);
          }
        }}
      >
        <div className="neo-title">Command</div>
        <div className="neo-count">{count}</div>
        <div className="neo-prompt command-line-prompt">
          <span className="command-line-colon">:</span>
          <input
            ref={inputRef}
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            aria-label="Type a command"
          />
        </div>
        {hasQuery && (
          <>
            <div className="neo-separator" />
            <div className="neo-list">
              {rows.length === 0 ? (
                <div className="neo-empty">no matching command</div>
              ) : (
                rows.map((row, idx) => (
                  <div
                    key={row.id}
                    className={`neo-row ${idx === selected ? "is-selected" : ""} ${
                      row.enabled ? "" : "is-disabled"
                    }`}
                    onMouseEnter={() => setSelected(idx)}
                    onClick={() => run(row)}
                  >
                    <span className="neo-icon">:</span>
                    <span className="neo-name">{row.name}</span>
                    <span className="neo-detail">{row.label}</span>
                  </div>
                ))
              )}
            </div>
          </>
        )}
        <div className="neo-footer">
          <span>{footer}</span>
        </div>
      </div>
    </div>
  );
}
