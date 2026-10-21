import { useCallback, useEffect, useRef, useState } from "react";

import { useUIStore } from "../state/ui";
import { type AppCommand, type CommandClose, useCommands } from "./useCommands";
import { useModalFocus } from "./useModalFocus";

type Group = {
  prefix: string | null;
  title: string;
  commands: AppCommand[];
};

/** Rebuild the palette's grouped layout from the flat command registry,
 *  preserving first-appearance order of both groups and commands. */
function groupCommands(commands: AppCommand[]): Group[] {
  const groups: Group[] = [];
  for (const command of commands) {
    let group = groups.find(
      (g) => g.title === command.group && g.prefix === command.prefix,
    );
    if (!group) {
      group = { prefix: command.prefix, title: command.group, commands: [] };
      groups.push(group);
    }
    group.commands.push(command);
  }
  return groups;
}

export default function CommandTransient() {
  const closeTransient = useUIStore((s) => s.closeTransient);
  const requestFocus = useUIStore((s) => s.requestFocus);

  const [pendingPrefix, setPendingPrefix] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useModalFocus({ open: true, rootRef });

  const close = useCallback<CommandClose>(
    (options = {}) => {
      setPendingPrefix(null);
      closeTransient();
      if (options.restoreFocus !== false) requestFocus();
    },
    [closeTransient, requestFocus],
  );

  const { commands, busy } = useCommands(close);
  const groups = groupCommands(commands.filter((c) => c.palette !== false));
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (pendingPrefix) {
          setPendingPrefix(null);
        } else {
          close();
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k.length !== 1) return;
      e.preventDefault();
      e.stopPropagation();

      const currentGroups = groupsRef.current;
      if (pendingPrefix) {
        const cmd = currentGroups
          .filter((g) => g.prefix === pendingPrefix)
          .flatMap((g) => g.commands)
          .find((c) => c.key === k);
        if (cmd && cmd.enabled) {
          void cmd.run();
        } else {
          setPendingPrefix(null);
        }
        return;
      }

      const prefixGroup = currentGroups.find((g) => g.prefix === k);
      if (prefixGroup) {
        setPendingPrefix(k);
        return;
      }
      const flat = currentGroups
        .filter((g) => g.prefix === null)
        .flatMap((g) => g.commands);
      const cmd = flat.find((c) => c.key === k);
      if (cmd && cmd.enabled) {
        void cmd.run();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pendingPrefix, close]);

  const activeGroups = pendingPrefix
    ? groups.filter((g) => g.prefix === pendingPrefix)
    : groups;
  const visibleCommandCount = activeGroups.reduce(
    (count, group) => count + group.commands.length,
    0,
  );
  const promptText = pendingPrefix
    ? "next key, Esc to back out"
    : "press a key chord, Esc to dismiss";
  const footer = busy
    ? `${busy}...`
    : pendingPrefix
      ? "prefix chord active"
      : "type a key chord or click a row";

  return (
    <div
      className="asset-picker-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={rootRef}
        className="asset-picker neo-picker command-transient"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        <div className="neo-title">Commands</div>
        <div className="neo-count">{visibleCommandCount}</div>
        <div className="neo-prompt">
          <span>›</span>
          <div className="transient-prompt-text">
            {pendingPrefix && (
              <span className="transient-prefix">{pendingPrefix}</span>
            )}
            <span className="transient-hint">{promptText}</span>
            {busy && <span className="transient-busy">{busy}...</span>}
          </div>
        </div>
        <div className="neo-separator" />
        <div className="neo-list transient-groups">
          {activeGroups.map((g) => (
            <div key={g.title} className="transient-group">
              <div className="transient-group-title">
                {g.prefix && !pendingPrefix && <kbd>{g.prefix}</kbd>}
                <span>{g.title}</span>
              </div>
              {g.commands.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={`neo-row transient-cmd ${
                    c.enabled ? "" : "is-disabled"
                  }`}
                  onClick={() => {
                    if (c.enabled) void c.run();
                  }}
                  disabled={!c.enabled}
                >
                  <span className="transient-keys">
                    {(g.prefix && !pendingPrefix
                      ? [g.prefix, c.key]
                      : [c.key]
                    ).map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                  <span className="neo-name">{c.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="neo-footer">
          <span>{footer}</span>
        </div>
      </div>
    </div>
  );
}
