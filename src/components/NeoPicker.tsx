import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import { useModalFocus } from "./useModalFocus";

/**
 * Shared neo-picker shell for the file/project pickers (open-repo, recent repos,
 * fuzzy file finder). Owns the chrome, the search input, keyboard navigation,
 * selection, modal focus and scroll-into-view. Each host supplies its own data,
 * how the query filters that data (sync substring vs. async fuzzy), row
 * rendering and activation — only the *content filter* differs between pickers.
 */
export interface NeoPickerProps<T> {
  open: boolean;
  title: string;
  /** Extra modifier class on the modal (e.g. "fuzzy-finder"). */
  className?: string;

  /** Controlled search input — the host decides how `query` filters `rows`. */
  query: string;
  onQueryChange: (query: string) => void;
  placeholder?: string;
  /** Rendered inline immediately before the input (e.g. the colored path). */
  promptPrefix?: ReactNode;

  /** Rows already filtered/ranked by the host for the current query. */
  rows: T[];
  rowKey: (row: T, idx: number) => string;
  /** The inner row content (neo-icon / neo-name / neo-detail spans). */
  renderRow: (row: T, selected: boolean) => ReactNode;
  rowClassName?: (row: T) => string;
  isRowDisabled?: (row: T) => boolean;
  onActivate: (row: T, idx: number) => void;
  /**
   * Row to select when the row set changes (typing, navigating, refetch).
   * Defaults to 0; hosts with leading non-entry rows (e.g. the open-repo "..")
   * point this at the first real entry so filtering lands on a match.
   */
  initialSelected?: number;

  onClose: () => void;
  /** `.neo-count` content; defaults to the row total. */
  renderCount?: (selected: number, total: number) => ReactNode;
  footer: ReactNode;
  emptyText?: string;

  /**
   * Host-specific keys (e.g. Backspace→parent, Ctrl+D→forget). Runs before the
   * built-in navigation; return `true` to consume the event and stop.
   */
  onExtraKeyDown?: (
    e: ReactKeyboardEvent<HTMLDivElement>,
    ctx: { query: string; selected: number },
  ) => boolean;
}

export default function NeoPicker<T>({
  open,
  title,
  className,
  query,
  onQueryChange,
  placeholder,
  promptPrefix,
  rows,
  rowKey,
  renderRow,
  rowClassName,
  isRowDisabled,
  onActivate,
  initialSelected = 0,
  onClose,
  renderCount,
  footer,
  emptyText,
  onExtraKeyDown,
}: NeoPickerProps<T>) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useModalFocus({ open, rootRef, initialFocusRef: inputRef });

  const [selected, setSelected] = useState(0);
  // Last real pointer position. Scrolling the list under a stationary cursor
  // fires pointer events whose coords are unchanged; ignoring those keeps the
  // selection from jumping to whatever row slid under the mouse (the "skips to
  // the middle" bug).
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  // Reset selection whenever the row set changes (typing, navigating, refetch)
  // or the picker (re)opens. The host re-renders only on its own state changes,
  // so a hover/keyboard move inside this component does not trigger a reset.
  useEffect(() => {
    setSelected(
      rows.length === 0
        ? 0
        : Math.min(Math.max(initialSelected, 0), rows.length - 1),
    );
  }, [open, rows, initialSelected]);

  const move = (delta: number) => {
    if (rows.length === 0) return;
    setSelected((cur) => {
      let next = cur;
      for (let i = 0; i < rows.length; i++) {
        next = (next + delta + rows.length) % rows.length;
        if (!isRowDisabled?.(rows[next])) return next;
      }
      return cur;
    });
  };

  if (!open) return null;

  return (
    <div className="asset-picker-backdrop">
      <div
        ref={rootRef}
        className={`asset-picker neo-picker${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (onExtraKeyDown?.(e, { query, selected })) return;
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Enter") {
            e.preventDefault();
            const row = rows[selected];
            if (row && !isRowDisabled?.(row)) onActivate(row, selected);
          }
        }}
      >
        <div className="neo-title">{title}</div>
        <div className="neo-count">
          {renderCount ? renderCount(selected, rows.length) : rows.length}
        </div>
        <div className="neo-prompt">
          <span>›</span>
          <div className="neo-prompt-field">
            {promptPrefix}
            <input
              ref={inputRef}
              value={query}
              spellCheck={false}
              autoComplete="off"
              placeholder={placeholder}
              onChange={(e) => onQueryChange(e.target.value)}
              aria-label={title}
            />
          </div>
        </div>
        <div className="neo-separator" />
        <div className="neo-list">
          {rows.length === 0 ? (
            <div className="neo-empty">{emptyText ?? "no matches"}</div>
          ) : (
            rows.map((row, idx) => {
              const disabled = isRowDisabled?.(row) ?? false;
              const extra = rowClassName?.(row) ?? "";
              return (
                <div
                  key={rowKey(row, idx)}
                  ref={(el) => {
                    if (el && idx === selected) {
                      window.requestAnimationFrame(() => {
                        el.scrollIntoView({ block: "nearest" });
                      });
                    }
                  }}
                  className={`neo-row${extra ? ` ${extra}` : ""}${
                    idx === selected ? " is-selected" : ""
                  }${disabled ? " is-disabled" : ""}`}
                  onPointerMove={(e) => {
                    const next = { x: e.clientX, y: e.clientY };
                    const prev = pointerRef.current;
                    pointerRef.current = next;
                    if (prev && prev.x === next.x && prev.y === next.y) return;
                    if (!disabled) setSelected(idx);
                  }}
                  onClick={() => {
                    if (!disabled) onActivate(row, idx);
                  }}
                >
                  {renderRow(row, idx === selected)}
                </div>
              );
            })
          )}
        </div>
        <div className="neo-footer">
          <span>{footer}</span>
        </div>
      </div>
    </div>
  );
}
