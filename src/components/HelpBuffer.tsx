import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { quitWindow } from "../lib/buffers";
import { dispatchKey, type KeyHandler } from "../lib/key-dispatch";
import {
  boundCommands,
  KEYMAP,
  keysLabel,
  SCOPE_TITLE,
  type HelpAction,
  type KeyScope,
} from "../lib/keymap";
import { useMinibufferStore } from "../state/minibuffer";
import { useUIStore, type HelpView } from "../state/ui";
import { hasKeyboard, useWindowStore } from "../state/windows";
import { type AppCommand, type CommandClose, useCommands } from "./useCommands";

type Row = {
  /** The keys — or, in the `M-x only` section, the command's name. */
  keys: string;
  doc: string;
  /** The `M-x` name the key runs, if it runs a command. */
  command: string;
  isName: boolean;
};

type Section = { id: KeyScope | "mx"; title: string; current: boolean; rows: Row[] };

/** Every other keymap, in the order the sheet lists them after the current one. */
const ORDER: KeyScope[] = [
  "global",
  "help",
  "start",
  "diff",
  "log",
  "tree",
  "viewer",
  "minibuffer",
  "editor",
];

/**
 * The sheet, generated from `keymap.ts` and the command registry — never written by
 * hand, so it can't disagree with the keys. The keymap help was opened from comes
 * first; the commands no key runs close it, as `M-x only`.
 */
function buildSections(view: HelpView, commands: AppCommand[], query: string): Section[] {
  const nameOf = new Map(commands.map((c) => [c.id, c.name]));
  const scopes = view.only ? [view.from] : [view.from, ...ORDER.filter((s) => s !== view.from)];
  const sections: Section[] = scopes.map((scope) => ({
    id: scope,
    title: SCOPE_TITLE[scope],
    current: scope === view.from,
    rows: KEYMAP[scope].map((binding) => ({
      keys: keysLabel(binding),
      doc: binding.doc,
      command: binding.command ? (nameOf.get(binding.command) ?? "") : "",
      isName: false,
    })),
  }));
  if (!view.only) {
    const bound = boundCommands();
    sections.push({
      id: "mx",
      title: "M-x only",
      current: false,
      rows: commands
        .filter((c) => !bound.has(c.id))
        .map((c) => ({ keys: c.name, doc: c.label, command: "", isName: true })),
    });
  }
  const needle = query.trim().toLowerCase();
  if (!needle) return sections;
  return sections
    .map((section) => ({
      ...section,
      rows: section.rows.filter((row) =>
        `${row.keys} ${row.doc} ${row.command}`.toLowerCase().includes(needle),
      ),
    }))
    .filter((section) => section.rows.length > 0);
}

const noClose: CommandClose = () => {};

/**
 * The help buffer (`C-h b` everything, `C-h m` one keymap): Emacs's `*Help*` for
 * describe-bindings. `q` goes back where you were; `C-s` narrows it as you type.
 */
export default function HelpBuffer() {
  const view = useUIStore((s) => s.help);
  const focused = useWindowStore((s) => hasKeyboard(s, "help"));
  const focusRequest = useUIStore((s) => s.focusRequest);
  const openMinibuffer = useMinibufferStore((s) => s.open);

  const { all } = useCommands(noClose);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (focused) rootRef.current?.focus({ preventScroll: true });
  }, [focused, focusRequest]);

  // A new view (C-h b after C-h m, help from another buffer) starts unfiltered.
  useEffect(() => {
    setQuery("");
    scrollRef.current?.scrollTo({ top: 0 });
  }, [view]);

  const sections = useMemo(() => buildSections(view, all, query), [all, query, view]);

  const scrollLines = useCallback((lines: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.scrollBy({ top: lines * lineHeight });
  }, []);

  const handlers: Record<HelpAction, KeyHandler> = {
    down: () => scrollLines(1),
    up: () => scrollLines(-1),
    first: () => scrollRef.current?.scrollTo({ top: 0 }),
    last: () => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }),
    search: () =>
      openMinibuffer({
        kind: "text",
        prompt: "Search bindings:",
        initial: query,
        onChange: setQuery,
        onAccept: setQuery,
        onCancel: () => setQuery(""),
      }),
    quit: quitWindow,
  };

  return (
    <div
      ref={rootRef}
      className="buffer help-buffer"
      tabIndex={0}
      onKeyDown={(e) => dispatchKey("help", e, KEYMAP.help, handlers)}
    >
      <div className="help-header">
        <span className="help-title">Help</span>
        <span className="help-subject">
          {view.only ? `${SCOPE_TITLE[view.from]}: its keys` : "every key binding and command"}
        </span>
        {query.trim() && <span className="help-query">matching “{query.trim()}”</span>}
        <span className="help-hint">
          q back · C-s search · {view.only ? "C-h b everything" : "C-h m this buffer only"}
        </span>
      </div>
      <div ref={scrollRef} className="help-scroll">
        {sections.length === 0 ? (
          <div className="help-empty">nothing matches “{query.trim()}”</div>
        ) : (
          <div className="help-columns">
            {sections.map((section) => (
              <section
                key={section.id}
                className={`help-section${section.current ? " is-current" : ""}`}
              >
                <h2 className="help-section-title">
                  {section.title}
                  {section.current && !view.only ? " · this buffer" : ""}
                </h2>
                {section.rows.map((row) => (
                  <div key={`${row.keys} ${row.doc}`} className="help-row">
                    <span className={row.isName ? "help-name" : "help-keys"}>{row.keys}</span>
                    <span className="help-doc">{row.doc}</span>
                    <span className="help-command">{row.command}</span>
                  </div>
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
