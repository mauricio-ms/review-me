import { useEffect, useMemo, useState } from "react";

import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { shortOid } from "../types/diff";

/** One line of the fake shell transcript. `cmd` lines type out char-by-char after a
 *  prompt; `out` lines print whole (optionally tinted green via `tone: "ok"`). */
type Seg =
  | { kind: "cmd"; text: string }
  | { kind: "out"; text: string; tone?: "ok" };

const CMD_CHAR_MS = 1000 / 45; // ~45 chars/sec
const OUT_PAUSE_MS = 120; // "execution" pause before output prints
const START_DELAY_MS = 220;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Walks the transcript, growing each `cmd` line one char at a time and revealing each
 *  `out` line whole after a short pause. With motion disabled it returns everything at
 *  once. `shown[i]` is the visible text of segment i (undefined = not yet revealed). */
function useTerminalReveal(segs: Seg[], enabled: boolean) {
  const [shown, setShown] = useState<string[]>(() =>
    enabled ? [] : segs.map((s) => s.text),
  );
  const [done, setDone] = useState(!enabled);

  useEffect(() => {
    if (!enabled) {
      setShown(segs.map((s) => s.text));
      setDone(true);
      return;
    }
    setShown([]);
    setDone(false);

    let cancelled = false;
    const timers: number[] = [];
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push(window.setTimeout(resolve, ms));
      });
    const reveal = (i: number, text: string) =>
      setShown((prev) => {
        const next = prev.slice();
        next[i] = text;
        return next;
      });

    (async () => {
      await wait(START_DELAY_MS);
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if (seg.kind === "cmd") {
          for (let c = 1; c <= seg.text.length; c++) {
            if (cancelled) return;
            reveal(i, seg.text.slice(0, c));
            await wait(CMD_CHAR_MS);
          }
        } else {
          await wait(OUT_PAUSE_MS);
          if (cancelled) return;
          reveal(i, seg.text);
        }
      }
      if (!cancelled) setDone(true);
    })();

    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [segs, enabled]);

  return { shown, done };
}

/** The "working tree clean" empty state for the diff buffer: a fake terminal session
 *  that runs `git status` and reports the tree is clean, with real branch / HEAD / tag
 *  stats, a typewriter reveal, and a blinking prompt. */
export default function DiffCleanState() {
  const diff = useRepoStore((s) => s.diff);
  const reviewed = useTagsStore((s) => s.reviewed);
  const flags = useTagsStore((s) => s.flags);
  const ignored = useTagsStore((s) => s.ignored);

  const comparison = diff?.comparison;
  const cwd =
    diff?.repoRoot.split("/").filter(Boolean).pop() ?? "repo";

  const segs = useMemo<Seg[]>(() => {
    const list: Seg[] = [];
    if (comparison?.kind === "branches") {
      // Nothing between two commits isn't a clean working tree — say what it is.
      const range = `${comparison.baseName}...${comparison.targetName}`;
      list.push({ kind: "cmd", text: `git diff --stat ${range}` });
      list.push({
        kind: "out",
        text: `no changes between ${comparison.baseName} and ${comparison.targetName}`,
        tone: "ok",
      });
      list.push({ kind: "cmd", text: `git merge-base ${range.replace("...", " ")}` });
      list.push({ kind: "out", text: shortOid(comparison.mergeBase) });
    } else {
      const branch = comparison?.branch || "(unknown)";
      const head = comparison?.head ?? "";
      list.push({ kind: "cmd", text: "git status" });
      list.push({ kind: "out", text: `On branch ${branch}` });
      if (head === "") list.push({ kind: "out", text: "No commits yet" });
      list.push({
        kind: "out",
        text: "nothing to commit, working tree clean",
        tone: "ok",
      });
      if (head !== "") {
        list.push({ kind: "cmd", text: "git rev-parse --short HEAD" });
        list.push({ kind: "out", text: head });
      }
    }
    list.push({ kind: "cmd", text: "review-me status" });
    list.push({
      kind: "out",
      text: `✓ 0 changes to review · ${reviewed.length} reviewed · ${flags.length} flagged · ${ignored.length} ignored`,
      tone: "ok",
    });
    return list;
  }, [comparison, reviewed.length, flags.length, ignored.length]);

  const reduced = useMemo(prefersReducedMotion, []);
  const { shown, done } = useTerminalReveal(segs, !reduced);

  // The blinking cursor trails the most recent command line until the session settles
  // onto a final idle prompt.
  let lastCmd = -1;
  for (let i = 0; i < segs.length; i++) {
    if (shown[i] !== undefined && segs[i].kind === "cmd") lastCmd = i;
  }

  return (
    <div className="diff-clean">
      <div className="diff-clean-term">
        <div className="diff-clean-term-title">~/{cwd} — zsh</div>
        <div className="diff-clean-body">
          {segs.map((seg, i) => {
            const text = shown[i];
            if (text === undefined) return null;
            if (seg.kind === "cmd") {
              return (
                <div key={i} className="diff-clean-line is-cmd">
                  <span className="diff-clean-prompt">❯</span>
                  <span className="diff-clean-cmd">{text}</span>
                  {!done && i === lastCmd && (
                    <span className="diff-clean-cursor">█</span>
                  )}
                </div>
              );
            }
            return (
              <div
                key={i}
                className={`diff-clean-line is-out ${seg.tone === "ok" ? "is-ok" : ""}`}
              >
                {text}
              </div>
            );
          })}
          {done && (
            <div className="diff-clean-line is-cmd">
              <span className="diff-clean-prompt">❯</span>
              <span className="diff-clean-cursor">█</span>
            </div>
          )}
        </div>
      </div>
      {done && (
        <div className="diff-clean-hints">
          <span>
            <kbd>r</kbd> refresh
          </span>
          <span>
            <kbd>b</kbd> <kbd>p</kbd> project
          </span>
          <span>
            <kbd>o</kbd> <kbd>p</kbd> open repo
          </span>
        </div>
      )}
    </div>
  );
}
