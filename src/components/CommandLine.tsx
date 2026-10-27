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
  // -1 is "nothing selected": a bare `:` lists every command but `Enter` runs none of
  // them until a row is picked with the arrows/Tab or the list is narrowed by typing.
  const [selected, setSelected] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  useModalFocus({ open: true, rootRef: modalRef, initialFocusRef: inputRef });

  const rawClose = useCallback<CommandClose>(
    (options = {}) => {
      setQuery("");
      setSelected(-1);
      closeCommandLine();
      if (options.restoreFocus !== false) requestFocus();
    },
    [closeCommandLine, requestFocus],
  );

  const { commands, busy } = useCommands(rawClose);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // Nothing typed yet: every command available here, in registry order.
    if (!needle) return commands;
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
    setSelected((current) => Math.min(current, rows.length - 1));
  }, [rows]);

  const selectedRow = selected >= 0 ? rows[selected] : undefined;

  const move = (delta: number) => {
    if (rows.length === 0) return;
    setSelected((current) =>
      current < 0
        ? delta > 0
          ? 0
          : rows.length - 1
        : (current + delta + rows.length) % rows.length,
    );
  };

  // The list opens under wherever the pointer rests; only a real move selects, so a
  // pointer that happens to be there can't pick what `Enter` runs.
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  const run = (command: AppCommand | undefined) => {
    if (command && command.enabled) void command.run();
  };

  const count = `${selected + 1}/${rows.length}`;
  const footer = busy
    ? `${busy}...`
    : (selectedRow?.label ?? "type a command, or ↑/↓ to pick one");

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
            } else {
              move(1);
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
              // Typing narrows to the best match; clearing back to a bare `:` picks
              // nothing again.
              setSelected(e.target.value.trim() ? 0 : -1);
            }}
            aria-label="Type a command"
          />
        </div>
        <div className="neo-separator" />
        <div className="neo-list">
          {rows.length === 0 ? (
            <div className="neo-empty">no matching command</div>
          ) : (
            rows.map((row, idx) => (
              <div
                key={row.id}
                ref={(el) => {
                  if (el && idx === selected) {
                    window.requestAnimationFrame(() => {
                      el.scrollIntoView({ block: "nearest" });
                    });
                  }
                }}
                className={`neo-row ${idx === selected ? "is-selected" : ""} ${
                  row.enabled ? "" : "is-disabled"
                }`}
                onPointerMove={(e) => {
                  const next = { x: e.clientX, y: e.clientY };
                  const prev = pointerRef.current;
                  pointerRef.current = next;
                  if (prev && prev.x === next.x && prev.y === next.y) return;
                  setSelected(idx);
                }}
                onClick={() => run(row)}
              >
                <span className="neo-icon">:</span>
                <span className="neo-name">{row.name}</span>
                <span className="neo-detail">{row.label}</span>
              </div>
            ))
          )}
        </div>
        <div className="neo-footer">
          <span>{footer}</span>
        </div>
      </div>
    </div>
  );
}
