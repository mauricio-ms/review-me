import { useEffect, useRef, useState } from "react";

import { dispatchKey, type KeyHandler } from "../lib/key-dispatch";
import { KEYMAP, type StartAction } from "../lib/keymap";
import { openRepoByPath } from "../lib/open-repo";
import { listRecentRepos } from "../lib/tauri";
import { timeAgo } from "../lib/time";
import { useUIStore } from "../state/ui";
import type { RememberedRepo } from "../types/repo";

const GLASS_GLYPH = [
  "011110000",
  "110011000",
  "100001000",
  "100001000",
  "110011000",
  "011111000",
  "000011100",
  "000001110",
  "000000110",
] as const;

function PixelGlyph({
  glyph,
  className,
}: {
  glyph: readonly string[];
  className?: string;
}) {
  const columns = glyph[0]?.length ?? 0;

  return (
    <span
      className={`startup-pixel-glyph ${className ?? ""}`}
      style={{
        gridTemplateColumns: `repeat(${columns}, var(--startup-logo-pixel))`,
        gridTemplateRows: `repeat(${glyph.length}, var(--startup-logo-pixel))`,
      }}
    >
      {glyph.map((row, rowIndex) =>
        Array.from(row).map((cell, columnIndex) => (
          <span
            key={`${rowIndex}-${columnIndex}`}
            className={`startup-logo-pixel ${cell === "1" ? "is-on" : ""}`}
          />
        )),
      )}
    </span>
  );
}

// 5×7 pixel glyphs for the wordmark, drawn in the same grid style as the logo
// mark so the title reads as pixel-art rather than a system font.
const PIXEL_FONT: Record<string, readonly string[]> = {
  r: ["00000", "00000", "10100", "11000", "10000", "10000", "10000"],
  e: ["00000", "00000", "01110", "10001", "11111", "10000", "01110"],
  v: ["00000", "00000", "10001", "10001", "10001", "01010", "00100"],
  i: ["00100", "00000", "00100", "00100", "00100", "00100", "00100"],
  w: ["00000", "00000", "10001", "10001", "10101", "10101", "01010"],
  m: ["00000", "00000", "11111", "10101", "10101", "10101", "10101"],
  "-": ["00000", "00000", "00000", "00000", "01110", "00000", "00000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

function PixelWord({ text, className }: { text: string; className?: string }) {
  return (
    <span
      className={`startup-pixel-word ${className ?? ""}`}
      role="img"
      aria-label={text}
    >
      {Array.from(text).map((char, index) => (
        <PixelGlyph key={index} glyph={PIXEL_FONT[char] ?? PIXEL_FONT[" "]} />
      ))}
    </span>
  );
}

/** Most recent first; the start screen lists this many (1–9 open them directly). */
const RECENT_SHOWN = 9;

/**
 * The start screen: the repositories opened before, ready to reopen from the
 * keyboard, and the few keys that lead everywhere else.
 */
export default function StartupDashboard() {
  const focusRequest = useUIStore((s) => s.focusRequest);
  const [repos, setRepos] = useState<RememberedRepo[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    listRecentRepos()
      .then((all) => {
        if (!cancelled) setRepos(all.slice(0, RECENT_SHOWN));
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, [focusRequest]);

  const open = async (repo: RememberedRepo | undefined) => {
    if (!repo || opening) return false;
    setOpening(repo.path);
    setError(null);
    try {
      await openRepoByPath(repo.path);
    } catch (e) {
      setError(String(e));
      setOpening(null);
    }
  };

  const count = repos?.length ?? 0;
  const handlers: Record<StartAction, KeyHandler> = {
    down: () => setCursor((c) => Math.min(c + 1, Math.max(0, count - 1))),
    up: () => setCursor((c) => Math.max(0, c - 1)),
    open: () => void open(repos?.[cursor]),
    "open-nth": (keys) => {
      const repo = repos?.[Number(keys) - 1];
      if (!repo) return false;
      setCursor(Number(keys) - 1);
      void open(repo);
    },
  };

  return (
    <div
      ref={rootRef}
      className="startup-dashboard"
      tabIndex={-1}
      onKeyDown={(e) => dispatchKey("start", e, KEYMAP.start, handlers)}
    >
      <div className="startup-inner">
        <div className="startup-logo">
          <span className="startup-logo-mark" aria-hidden="true">
            <PixelGlyph glyph={GLASS_GLYPH} className="startup-logo-glass" />
          </span>
          <PixelWord text="review-me" className="startup-logo-word" />
        </div>

        <section className="startup-section" aria-labelledby="startup-recent">
          <div className="startup-section-head">
            <h2 id="startup-recent">Recent repositories</h2>
            {count > 0 && <span>j/k move · RET open · 1–{count} open by number</span>}
          </div>
          {repos === null && !error && <div className="startup-empty">loading…</div>}
          {repos !== null && count === 0 && (
            <div className="startup-empty">nothing opened yet — M-x open to pick one</div>
          )}
          {repos?.map((repo, index) => (
            <div
              key={repo.path}
              className={`startup-repo${index === cursor ? " is-selected" : ""}`}
              onClick={() => {
                setCursor(index);
                void open(repo);
              }}
            >
              <span className="startup-repo-n">{index + 1}</span>
              <span className="startup-repo-where">
                <span className="startup-repo-name">{repo.name}</span>
                <span className="startup-repo-path">{repo.path}</span>
              </span>
              <span className="startup-repo-when">
                {opening === repo.path ? "opening…" : timeAgo(repo.lastOpenedAt / 1000)}
              </span>
            </div>
          ))}
          {error && <div className="startup-error">{error}</div>}
        </section>

        <section className="startup-section" aria-labelledby="startup-start">
          <div className="startup-section-head">
            <h2 id="startup-start">Start</h2>
          </div>
          <div className="startup-keys">
            <kbd>C-x p p</kbd>
            <span>recent repositories, to filter or forget</span>
            <kbd>M-x open</kbd>
            <span>open a repository from disk</span>
            <kbd>M-x</kbd>
            <span>every command, by name</span>
            <kbd>C-h b</kbd>
            <span>every key binding</span>
          </div>
        </section>
      </div>
    </div>
  );
}
