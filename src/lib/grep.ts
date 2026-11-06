import { useGrepStore, type GrepContext } from "../state/grep";
import { useMinibufferStore } from "../state/minibuffer";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import { hasKeyboard, isShown, useWindowStore } from "../state/windows";
import { sameSource } from "../types/repo";
import type { GrepScope } from "../types/grep";
import { showBuffer } from "./buffers";
import { recordJump } from "./jumps";
import { ambientSource, visitFile } from "./project";
import { activeView } from "./project-view";
import { cancelRepoSearch, searchRepo } from "./tauri";

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: string | null = null;
let generation = 0;

/** Stop backend work as well as invalidating replies already on their way back. */
function invalidate(): void {
  generation++;
  if (timer != null) clearTimeout(timer);
  timer = null;
  if (pending) void cancelRepoSearch(pending).catch(() => {});
  pending = null;
}

function current(context: GrepContext): boolean {
  const repo = useRepoStore.getState();
  return useGrepStore.getState().context === context &&
    repo.repoPath === context.repo && repo.comparisonEpoch === context.epoch &&
    sameSource(ambientSource(repo.diff?.comparison).source, context.choice.source);
}

export function resetGrep(): void {
  invalidate();
  useGrepStore.getState().reset();
  const mb = useMinibufferStore.getState();
  if (mb.request?.kind === "grep") mb.close();
}

/** Opening a different review invalidates both its results and its outstanding reads. */
useRepoStore.subscribe((now, before) => {
  if (now.repoPath !== before.repoPath || now.comparisonEpoch !== before.comparisonEpoch ||
      !sameSource(ambientSource(now.diff?.comparison).source, ambientSource(before.diff?.comparison).source)) {
    resetGrep();
  }
});

export async function runGrep(): Promise<void> {
  invalidate();
  const ticket = generation;
  const { context, query, scope } = useGrepStore.getState();
  if (!context || !current(context) || !query) {
    useGrepStore.setState({ results: null, status: "idle", error: null, selected: 0 });
    return;
  }
  const searchId = crypto.randomUUID();
  const changedFiles = (useRepoStore.getState().diff?.files ?? [])
    .filter((f) => f.status !== "deleted").map((f) => f.path);
  pending = searchId;
  useGrepStore.setState({ results: null, status: "loading", error: null, selected: 0 });
  try {
    const results = await searchRepo(searchId, {
      repo: context.repo, source: context.choice.source, query,
      only: scope === "changed" ? changedFiles : null,
    });
    if (ticket !== generation || !current(context)) return;
    useGrepStore.setState({ results, status: results.cancelled ? "cancelled" : "ready" });
  } catch (error) {
    if (ticket === generation && current(context)) {
      useGrepStore.setState({ status: "error", error: String(error), results: null });
    }
  } finally {
    if (pending === searchId) pending = null;
  }
}

/** Debounce edits, clearing obsolete matches immediately so they cannot be opened. */
export function editGrep(query: string, scope = useGrepStore.getState().scope): void {
  invalidate();
  useGrepStore.setState({ query, scope, results: null, selected: 0, error: null, status: query ? "loading" : "idle" });
  if (query) timer = setTimeout(() => { timer = null; void runGrep(); }, 150);
}

export function setGrepScope(scope: GrepScope): void {
  editGrep(useGrepStore.getState().query, scope);
}

export function cancelGrep(): void {
  invalidate();
  if (useGrepStore.getState().status === "loading") useGrepStore.setState({ status: "cancelled" });
}

/** A match opens beside the results, preserving the selected results window on preview. */
export function visitGrepHit(index: number, select: boolean): void {
  const { context, results } = useGrepStore.getState();
  const hit = results?.hits[index];
  if (!context || !current(context) || !hit || !isShown(useWindowStore.getState(), "grep")) return;
  // A mouse click can choose a result while the file window has the keyboard.
  if (!hasKeyboard(useWindowStore.getState(), "grep")) showBuffer("grep");
  useGrepStore.getState().select(index);
  if (select) recordJump({ kind: "grep", index });
  visitFile(hit.path, context.choice, { line: hit.line, col: hit.col }, { other: true, select });
}

export function moveGrep(delta: number): void {
  const state = useGrepStore.getState();
  const count = state.results?.hits.length ?? 0;
  if (count) state.select((state.selected + delta + count) % count);
}

/** `M-x grep`: use the comparison's new side even when an old-side file is selected. */
export function openGrep(): void {
  const repo = useRepoStore.getState();
  if (!repo.repoPath) return;
  const view = activeView();
  const word = view?.state.wordAt(view.state.selection.main.head);
  const atPoint = view && word ? view.state.sliceDoc(word.from, word.to) : null;
  let { context } = useGrepStore.getState();
  if (!context || !current(context)) {
    resetGrep();
    context = {
      repo: repo.repoPath, epoch: repo.comparisonEpoch, choice: ambientSource(repo.diff?.comparison),
    };
    useGrepStore.setState({ context });
  }
  if (!hasKeyboard(useWindowStore.getState(), "grep")) recordJump();
  showBuffer("grep");
  useMinibufferStore.getState().open({ kind: "grep", atPoint });
}

export function finishGrep(): void {
  useMinibufferStore.getState().close();
  useUIStore.getState().requestFocus();
}
