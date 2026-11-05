import { useFilesStore, newFileBufferId, type FileBuffer } from "../src/state/files";
import { useHistoryStore } from "../src/state/history";
import { useLogStore } from "../src/state/log";
import { useMinibufferStore } from "../src/state/minibuffer";
import { useNotesStore } from "../src/state/notes";
import { useProjectStore } from "../src/state/project";
import { useRepoStore } from "../src/state/repo";
import { useTagsStore } from "../src/state/tags";
import { useUIStore } from "../src/state/ui";
import { useWindowStore } from "../src/state/windows";
import type { ChangedFile, Comparison, DiffLine, DiffSpec, DiffSummary, Hunk } from "../src/types/diff";
import type { ProjectSource } from "../src/types/repo";
import { EMPTY_TAG_STORE, type Anchor, type FlagTag, type TagStore } from "../src/types/tags";
import { resetIPC } from "./support";

export const OID = "b".repeat(40);
export const PARENT = "a".repeat(40);
export const commitSpec = (oid = OID): DiffSpec => ({ kind: "commit", oid, branchRef: null });
export const branchSpec: DiffSpec = {
  kind: "branches", baseRef: "refs/heads/main", targetRef: "refs/heads/feature", strategy: "mergeBase",
};
export const commit = (patch: Partial<Extract<Comparison, { kind: "commit" }>> = {}): Comparison => ({
  kind: "commit", oid: OID, shortOid: OID.slice(0, 7), parentOid: PARENT, summary: "A change",
  body: "", authorName: "Ada", timestamp: 1, isMerge: false, branchName: null, ...patch,
});
export const branches = (targetOid = OID): Comparison => ({
  kind: "branches", baseRef: "refs/heads/main", targetRef: "refs/heads/feature",
  baseName: "main", targetName: "feature", baseOid: PARENT, targetOid, mergeBase: PARENT,
});
export const line = (kind: DiffLine["kind"], oldLine: number | null, newLine: number | null, content = "text"): DiffLine =>
  ({ kind, oldLine, newLine, content });
export function hunk(patch: Partial<Hunk> = {}): Hunk {
  return { id: "h1", header: "@@ -1,3 +1,3 @@", oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
    lines: [line("context", 1, 1), line("removed", 2, null, "old"), line("added", null, 2, "new"), line("context", 3, 3)], ...patch };
}
export function file(patch: Partial<ChangedFile> = {}): ChangedFile {
  return { path: "a.ts", oldPath: null, status: "modified", staged: false, binary: false,
    generated: false, addedLines: 1, removedLines: 1, hunks: [hunk()], ...patch };
}
export function tag(patch: Partial<Anchor> = {}, extra: Partial<Omit<FlagTag, "anchor">> = {}): FlagTag {
  return { id: "tag", createdAt: 1, note: null, severity: null, anchor: {
    file: "a.ts", startLine: 1, endLine: 3, contentHash: "", contextBefore: [], contextAfter: [],
    kind: "hunk", side: "new", scope: { kind: "worktree" }, stale: false, ...patch,
  }, ...extra };
}
export const tags = (patch: Partial<TagStore> = {}): TagStore => ({ ...structuredClone(EMPTY_TAG_STORE), ...patch });
export const summary = (comparison: Comparison = { kind: "worktree", head: "aaaaaaa", branch: "main", headOid: PARENT }, files = [file()]): DiffSummary =>
  ({ repoRoot: "/fixture", comparison, files });
export function repoFixture(spec: DiffSpec = { kind: "worktree" }, diff = summary()) {
  useRepoStore.getState().setRepo({ root: "/fixture", head: "aaaaaaa", branch: "main", reviewBranchRef: "refs/heads/main", reviewBaseRef: null, isDirty: true }, "/fixture");
  useRepoStore.getState().applyComparison(spec, diff);
}
export function openFile(path = "a.ts", source: ProjectSource = { kind: "worktree" }): FileBuffer {
  const buffer: FileBuffer = { id: newFileBufferId(), path, source, sourceLabel: null, content: "one\ntwo\nthree" };
  useFilesStore.getState().add(buffer);
  return buffer;
}
export function resetState() {
  const request = useMinibufferStore.getState().request;
  if (request?.kind === "confirm") request.onAnswer(false);
  useMinibufferStore.getState().close();
  useNotesStore.getState().close();
  useWindowStore.getState().reset();
  useFilesStore.getState().reset();
  useHistoryStore.getState().clear();
  useLogStore.getState().reset();
  useProjectStore.getState().reset();
  useProjectStore.setState({ filter: "changed", treeHidden: false });
  useRepoStore.getState().closeRepo();
  useTagsStore.getState().setStore(tags());
  useUIStore.setState({ ...useUIStore.getInitialState() });
  resetIPC();
}
