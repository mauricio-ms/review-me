import { useMinibufferStore } from "../state/minibuffer";
import { useRepoStore } from "../state/repo";
import { useTagsStore } from "../state/tags";
import { useUIStore } from "../state/ui";
import { activeBuffer, useWindowStore } from "../state/windows";
import { scopeForSpec, type FlagTag, type TagStore } from "../types/tags";
import { refreshCommitReviews } from "./log";
import { resolveFlags } from "./tauri";

type ResolveBuffer = "diff" | "log";
const handlers: Partial<Record<ResolveBuffer, () => void>> = {};

/** Both `M-x resolve` and `x` use the buffer's own cursor and visual selection. */
export function setResolveHandler(buffer: ResolveBuffer, handler: () => void): () => void {
  handlers[buffer] = handler;
  return () => {
    if (handlers[buffer] === handler) delete handlers[buffer];
  };
}

export function resolveAtCursor(): void {
  const buffer = activeBuffer(useWindowStore.getState());
  if (buffer === "diff" || buffer === "log") handlers[buffer]?.();
}

/** Confirm exact flag identities once, then persist the entire batch together. */
export async function confirmAndResolve(
  repo: string,
  flags: FlagTag[],
  where: string,
  isCurrent: () => boolean,
): Promise<TagStore | null> {
  if (!isCurrent()) return null;
  if (flags.length === 0) {
    useUIStore.getState().showFlash("No flags here to resolve");
    useUIStore.getState().requestFocus();
    return null;
  }
  const n = flags.length;
  const yes = await new Promise<boolean>((onAnswer) => {
    useMinibufferStore.getState().open({
      kind: "confirm",
      prompt: `Resolve ${n} flag${n === 1 ? "" : "s"} ${where}?`,
      onAnswer,
    });
  });
  if (!yes || !isCurrent()) return null;
  const before = useRepoStore.getState();
  try {
    const store = await resolveFlags(repo, scopeForSpec(before.comparison), flags.map((flag) => ({
      id: flag.id,
      scope: flag.anchor.scope,
    })));
    const current = useRepoStore.getState();
    if (current.repoPath !== repo) return null;
    if (current.comparisonEpoch === before.comparisonEpoch) useTagsStore.getState().setStore(store);
    const oids = flags.flatMap((f) => f.anchor.scope.kind === "commit" ? [f.anchor.scope.oid] : []);
    await refreshCommitReviews([...new Set(oids)]);
    if (useRepoStore.getState().repoPath === repo) {
      useUIStore.getState().showFlash(`Resolved ${n} flag${n === 1 ? "" : "s"}`);
    }
    return store;
  } catch (error) {
    if (isCurrent()) useUIStore.getState().showFlash(`Could not resolve flags: ${error}`);
    return null;
  }
}
