import { createRoot, type Root } from "react-dom/client";
import DiffBuffer from "../src/components/DiffBuffer";
import LogBuffer from "../src/components/LogBuffer";
import Minibuffer from "../src/components/Minibuffer";
import { resolveAtCursor } from "../src/lib/resolve-flags";
import { useLogStore } from "../src/state/log";
import { useMinibufferStore } from "../src/state/minibuffer";
import { useRepoStore } from "../src/state/repo";
import { useTagsStore } from "../src/state/tags";
import { useUIStore } from "../src/state/ui";
import { useWindowStore } from "../src/state/windows";
import type { CommitInfo } from "../src/types/repo";
import { EMPTY_TAG_STORE, type FlagRef, type FlagTag, type ReviewScope, type TagStore } from "../src/types/tags";

const tests: Array<{ name: string; run: () => Promise<void> }> = [];
const test = (name: string, run: () => Promise<void>) => tests.push({ name, run });
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const equal = (a: unknown, b: unknown) => assert(JSON.stringify(a) === JSON.stringify(b), `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const commits: CommitInfo[] = ["a", "b", "c", "d"].map((c, i) => ({
  oid: c.repeat(40), shortOid: c.repeat(7), summary: `Commit ${i + 1}`, authorName: "Ada",
  timestamp: 1, parentCount: 1, isMerge: false, isHead: i === 0, refs: [],
}));
function flag(id: string, scope: ReviewScope, line = 1, side: FlagTag["anchor"]["side"] = "new"): FlagTag {
  return { id, createdAt: 1, note: `Note ${id}`, severity: null, anchor: {
    file: side === "commit" ? "" : "a.txt", startLine: line, endLine: line,
    contentHash: "", contextBefore: [], contextAfter: [], kind: side === "commit" ? "commit" : side === "file" ? "file" : "range",
    side, scope, stale: false,
  } };
}
const commitScope = (i: number): ReviewScope => ({ kind: "commit", oid: commits[i].oid });
const initialFlags = () => [
  flag("a-line", commitScope(0)), flag("a-commit", commitScope(0), 0, "commit"),
  flag("b-file", commitScope(1), 0, "file"), flag("c-line", commitScope(2)),
  flag("d-line", commitScope(3)), flag("worktree", { kind: "worktree" }),
];
let saved: TagStore;
let calls: FlagRef[][];
let failResolve = false;
let root: Root | null = null;
let parent: HTMLDivElement | null = null;
const sameScope = (a: ReviewScope, b: ReviewScope) => JSON.stringify(a) === JSON.stringify(b);
const storeFor = (scope: ReviewScope): TagStore => ({
  ...saved, flags: saved.flags.filter((f) => sameScope(f.anchor.scope, scope)),
  resolvedFlags: saved.resolvedFlags.filter((f) => sameScope(f.anchor.scope, scope)),
});
function reviews() {
  return commits.flatMap((c) => {
    const flags = saved.flags.filter((f) => sameScope(f.anchor.scope, { kind: "commit", oid: c.oid }));
    return flags.length ? [{ oid: c.oid, flags: flags.length, notes: flags.length,
      coverage: { total: 1, reviewed: 0, ignored: 0, flagged: 1 } }] : [];
  });
}
(window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  if (command === "flags_for_commits") return saved.flags.filter((f) => f.anchor.scope.kind === "commit" && args.oids.includes(f.anchor.scope.oid));
  if (command === "commit_reviews") return reviews().filter((r) => args.oids.includes(r.oid));
  if (command === "log_coverage") return { total: 4, reviewed: 0, ignored: 0, flagged: reviews().length };
  if (command === "resolve_flags") {
    if (failResolve) throw new Error("Simulated write failure");
    calls.push(args.flags);
    const selected = saved.flags.filter((f) => args.flags.some((r: FlagRef) => r.id === f.id && sameScope(r.scope, f.anchor.scope)));
    saved.resolvedFlags.push(...selected.map((f) => ({ ...f, resolvedAt: 2 })));
    saved.flags = saved.flags.filter((f) => !selected.includes(f));
    return storeFor(args.scope);
  }
  throw new Error(`Unexpected IPC command: ${command}`);
} };

async function mount(buffer: "log" | "diff", flags = initialFlags()) {
  saved = { ...EMPTY_TAG_STORE, flags: structuredClone(flags), resolvedFlags: [] };
  calls = [];
  failResolve = false;
  useRepoStore.getState().closeRepo();
  useWindowStore.getState().reset();
  useLogStore.getState().reset();
  useRepoStore.getState().setRepo({ root: "/fixture", head: "aaaaaaa", branch: "feature", reviewBranchRef: null, reviewBaseRef: null, isDirty: true }, "/fixture");
  useRepoStore.getState().applyComparison({ kind: "worktree" }, {
    repoRoot: "/fixture", comparison: { kind: "worktree", head: "aaaaaaa", branch: "feature", headOid: commits[0].oid },
    files: [{ path: "a.txt", oldPath: null, status: "modified", staged: false, binary: false, generated: false,
      addedLines: 3, removedLines: 0, hunks: [{ id: "h1", header: "@@ -0,0 +1,3 @@", oldStart: 0, oldLines: 0, newStart: 1, newLines: 3,
        lines: [1, 2, 3].map((n) => ({ kind: "added", oldLine: null, newLine: n, content: `line ${n}` })) }] }],
  });
  useRepoStore.getState().setExpanded(new Set(["a.txt"]));
  useTagsStore.getState().setStore(storeFor({ kind: "worktree" }));
  useLogStore.getState().setPage("refs/heads/feature", null, { kind: "all" }, commits, true);
  useLogStore.getState().setReviews(commits.map((c) => c.oid), reviews());
  const windows = useWindowStore.getState();
  windows.show(windows.selected, buffer);
  parent = document.body.appendChild(document.createElement("div"));
  parent.className = "fixture";
  root = createRoot(parent);
  root.render(<>{buffer === "log" ? <LogBuffer /> : <DiffBuffer />}<Minibuffer /></>);
  await settle();
  document.querySelector<HTMLElement>(`.${buffer}-buffer`)!.focus();
}
async function key(key: string, ctrlKey = false) {
  // Chromium's virtual clock can defer the modal's animation-frame focus transfer.
  // Send prompt keys through its actual input and key dispatcher.
  const input = document.querySelector<HTMLInputElement>("#minibuffer-input");
  if (input) input.focus();
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true }));
  await settle();
}
const selection = () => document.querySelectorAll(".log-row.is-visual-sel").length;
const prompt = () => {
  const r = useMinibufferStore.getState().request;
  return r?.kind === "confirm" ? r.prompt : null;
};
async function click(selector: string, index = 0) {
  const row = document.querySelectorAll<HTMLElement>(selector)[index];
  assert(row, `Missing ${selector}[${index}]`);
  row.click();
  await settle();
}

test("log visual selection extends, shrinks, reverses and cancels", async () => {
  await mount("log");
  await key("v"); await key("j"); await key("j");
  equal(selection(), 3);
  assert(document.querySelector(".diff-header")!.textContent!.includes("3 commits selected · 4 flags"), "selection counts missing");
  await key("k"); equal(selection(), 2);
  await key("Escape"); equal(selection(), 0);
  await key("V"); await key("k"); equal(selection(), 2);
  await key("g", true); equal(selection(), 0);
  await key("v"); await key("v"); equal(selection(), 0);
});

test("batch confirmation preserves selection on cancel and resolves exact commits on y", async () => {
  await mount("log");
  await key("v"); await key("j"); await key("j");
  for (const cancel of ["n", "Escape", "C-g"]) {
    await key("x");
    equal(prompt(), "Resolve 4 flags across 3 selected commits?");
    await key("Enter"); assert(prompt(), "Enter confirmed the prompt");
    if (cancel === "C-g") await key("g", true); else await key(cancel);
    equal(prompt(), null); equal(selection(), 3); equal(calls.length, 0);
  }
  await key("x"); await key("y");
  equal(selection(), 0); equal(calls.length, 1); equal(calls[0].length, 4);
  equal(saved.flags.map((f) => f.id), ["d-line", "worktree"]);
  equal(saved.resolvedFlags.length, 4);
  assert(saved.resolvedFlags.every((f) => f.note), "notes were lost");
  equal(Object.keys(useLogStore.getState().reviews), [commits[3].oid]);
  assert(document.querySelector(".log-review-progress")?.textContent?.includes("1 flagged"), "summary did not refresh after resolving flags");
});

test("M-x resolve handler targets the single commit and a write failure keeps selection", async () => {
  await mount("log");
  resolveAtCursor(); await settle();
  equal(prompt(), "Resolve 2 flags on commit aaaaaaa?");
  await key("n");
  await key("v"); await key("j");
  failResolve = true;
  await key("x"); await key("y");
  equal(selection(), 2); equal(saved.resolvedFlags.length, 0);
  assert(useUIStore.getState().flash?.includes("Could not resolve flags"), "write failure was not reported");
  failResolve = false;
  await key("x"); await key("y"); equal(saved.resolvedFlags.length, 3);
});

test("selection follows commit identities through paging and clears on branch changes", async () => {
  await mount("log");
  await key("j"); await key("v"); await key("j");
  const extra = { ...commits[0], oid: "e".repeat(40), shortOid: "eeeeeee" };
  useLogStore.getState().setPage("refs/heads/feature", null, { kind: "all" }, [extra, ...commits], true);
  await settle(); equal(selection(), 2);
  useLogStore.getState().appendPage([{ ...extra, oid: "f".repeat(40) }], true);
  await settle(); equal(selection(), 2);
  useLogStore.getState().begin("refs/heads/other", null);
  useLogStore.getState().setPage("refs/heads/other", null, { kind: "all" }, commits, true);
  await settle(); equal(selection(), 0);
});

test("diff visual resolution confirms overlapping lines and preserves selection on cancel", async () => {
  const scope: ReviewScope = { kind: "worktree" };
  await mount("diff", [flag("one", scope, 1), flag("two", scope, 2), flag("three", scope, 3), flag("whole", scope, 0, "file")]);
  await click(".diff-line-row", 0);
  await key("v"); await key("j"); await key("x");
  equal(prompt(), "Resolve 2 flags in the selected lines of a.txt?");
  await key("n");
  assert(document.querySelector(".diff-buffer.is-visual"), "cancelling lost visual selection");
  await key("x"); await key("y");
  equal(saved.flags.map((f) => f.id), ["three", "whole"]);
  assert(!document.querySelector(".diff-buffer.is-visual"), "confirmed visual selection stayed active");
  assert(document.querySelector(".diff-note-row.is-selected")?.textContent?.includes("three"), "cursor did not advance to the next flag");
});

test("diff note resolves its exact flag; file row resolves flags on either side", async () => {
  const scope: ReviewScope = { kind: "worktree" };
  await mount("diff", [flag("one", scope), flag("two", scope, 2), flag("removed", scope, 1, "old")]);
  const note = Array.from(document.querySelectorAll<HTMLElement>(".diff-note-row")).find((r) => r.textContent?.includes("Note one"));
  assert(note, "note row missing"); note!.click(); await settle();
  await key("x"); equal(prompt(), "Resolve 1 flag in a.txt?"); await key("y");
  equal(saved.flags.map((f) => f.id), ["two", "removed"]);
  await click(".diff-file-row"); await key("x");
  equal(prompt(), "Resolve 2 flags in a.txt?"); await key("y"); equal(saved.flags.length, 0);
});

test("empty selections show a message without confirmation and keep keyboard focus", async () => {
  await mount("log", []);
  await key("v"); await key("j"); await key("x");
  equal(prompt(), null); equal(calls.length, 0); equal(selection(), 2);
  assert(document.activeElement?.classList.contains("log-buffer"), "focus was lost");
});

test("changing repositories while confirmation is open cannot resolve the old selection", async () => {
  await mount("log");
  await key("v"); await key("j"); await key("x");
  assert(prompt(), "confirmation missing");
  const repo = useRepoStore.getState().repo!;
  useRepoStore.getState().setRepo({ ...repo, root: "/another" }, "/another");
  await settle(); await key("y");
  equal(calls.length, 0); equal(saved.resolvedFlags.length, 0); equal(selection(), 0);
});

async function run() {
  const results: Array<{ name: string; error?: string }> = [];
  const errors: string[] = [];
  window.addEventListener("error", (event) => errors.push(event.message));
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
  for (const { name, run } of tests) {
    try {
      await run(); await settle();
      assert(errors.length === 0, errors.join("\n")); results.push({ name });
    } catch (error) { results.push({ name, error: String(error) }); }
    finally {
      const request = useMinibufferStore.getState().request;
      if (request?.kind === "confirm") request.onAnswer(false);
      useMinibufferStore.getState().close();
      root?.unmount(); parent?.remove(); root = null; parent = null; errors.length = 0;
    }
  }
  const output = document.body.appendChild(document.createElement("pre"));
  output.id = "test-results"; output.textContent = encodeURIComponent(JSON.stringify(results));
}
void run();
