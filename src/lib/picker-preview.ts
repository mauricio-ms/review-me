import { newFileBufferId, useFilesStore, type FileBuffer } from "../state/files";
import { usePickerPreviewStore } from "../state/picker-preview";
import { useRepoStore } from "../state/repo";
import { useMinibufferStore } from "../state/minibuffer";
import { useXrefStore } from "../state/xref";
import { useLogStore } from "../state/log";
import { useWindowStore, windowOrder, windowShowing, type FrameBufferKey, type WindowId } from "../state/windows";
import { sameSource } from "../types/repo";
import { findFileBuffer } from "./buffers";
import type { SourceChoice } from "./project";
import { positionOf } from "./project-view";
import { readPreview } from "./tauri";
import { targetWindow } from "./windows";
import { loadLog } from "./log";

export type FilePreviewTarget = {
  path: string;
  choice: SourceChoice;
  line?: number;
  col?: number;
  ranges?: readonly { from: number; to: number }[];
  /** Validate asynchronous candidate sets even before React commits their replacement. */
  current?: () => boolean;
};

export type PreviewTarget = FilePreviewTarget | { buffer: FrameBufferKey };

export type PreviewOptions = { other?: boolean; window?: WindowId; bufferSwitch?: boolean };
let nextOwner = 0;
let active: ReturnType<typeof startPickerPreview> | null = null;
const NO_RANGES: readonly { from: number; to: number }[] = [];

/** Own all preview work until this picker accepts, cancels, or is invalidated. */
export function startPickerPreview(options: PreviewOptions = {}, onInvalidate = () => {}): {
  move: (target: PreviewTarget | null, delay: number) => void;
  finish: (accept?: boolean, path?: string) => boolean;
} {
  active?.finish();
  const owner = ++nextOwner;
  const repo = useRepoStore.getState();
  const ws = useWindowStore.getState();
  const from = ws.selected;
  const base = options.window ?? (options.bufferSwitch ? from : targetWindow());
  let split: WindowId | null = null;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  let target: PreviewTarget | null = null;
  // A small session cache also shares a read between multiple matches in one file.
  const reads = new Map<string, Promise<string>>();
  const buffers = new Map<string, FileBuffer>();
  const valid = () => !ended && useRepoStore.getState().repoPath === repo.repoPath &&
    useRepoStore.getState().diff === repo.diff && useWindowStore.getState().shown[base] === ws.shown[base];
  usePickerPreviewStore.setState({ owner, shown: null, frame: null });

  const unsubscribe = useRepoStore.subscribe((now) => {
    if (now.repoPath !== repo.repoPath || now.diff !== repo.diff) {
      finish();
      onInvalidate();
    }
  });
  const request = useMinibufferStore.getState().request;
  const xref = useXrefStore.getState();
  const stopMinibuffer = useMinibufferStore.subscribe((now) => {
    if (now.request !== request) finish();
  });
  const stopXref = useXrefStore.subscribe((now) => {
    if (now.open !== xref.open || now.results !== xref.results) finish();
  });

  function finish(accept = false, path?: string): boolean {
    if (ended) return false;
    const current = valid();
    ended = true;
    generation++;
    clearTimeout(timer);
    unsubscribe();
    stopMinibuffer();
    stopXref();
    const pane = usePickerPreviewStore.getState().shown;
    if (accept && current && pane && target && "path" in target && (path == null || pane.buffer.path === path) && pane.buffer.path === target.path &&
        sameSource(pane.buffer.source, target.choice.source) && pane.buffer.content != null && !pane.error) {
      const files = useFilesStore.getState();
      if (!findFileBuffer(pane.buffer.source, pane.buffer.path)) {
        if (files.preview?.id === pane.buffer.id) files.adopt(pane.buffer.id);
        else files.add(pane.buffer);
      }
    }
    if (usePickerPreviewStore.getState().owner === owner) {
      usePickerPreviewStore.setState({ owner: null, shown: null, frame: null });
    }
    if (split != null && useWindowStore.getState().shown[split] === "project") {
      useWindowStore.getState().remove(split);
    }
    reads.clear();
    buffers.clear();
    if (active === session) active = null;
    return current;
  }

  async function show(candidate: FilePreviewTarget, ticket: number): Promise<void> {
    const current = () => valid() && ticket === generation && (candidate.current?.() ?? true);
    if (!current() || !repo.repoPath) return;
    const key = JSON.stringify([candidate.choice.source, candidate.path]);
    const open = findFileBuffer(candidate.choice.source, candidate.path);
    const tree = useFilesStore.getState().preview;
    const existing = open ?? (tree?.path === candidate.path && sameSource(tree.source, candidate.choice.source) ? tree : undefined);
    const buffer: FileBuffer = existing?.content != null ? existing : buffers.get(key) ?? existing ?? { id: newFileBufferId(), path: candidate.path,
      source: candidate.choice.source, sourceLabel: candidate.choice.label, content: null };
    buffers.set(key, buffer);
    const now = useWindowStore.getState();
    let win = base;
    if (options.other) {
      const order = windowOrder(now.layout);
      const elsewhere = open ? windowShowing(now, open.id, from) : null;
      if (elsewhere != null) win = elsewhere;
      else if (split != null) win = split;
      else if (order.length > 1) win = order[(order.indexOf(from) + 1) % order.length];
      else {
        split = now.split(from, "row", "project");
        // A temporary window must not reorder the buffer switcher's candidates.
        useWindowStore.setState({ recent: now.recent });
        win = split;
      }
    }
    const position = candidate.line != null ? { line: candidate.line, col: candidate.col ?? 0, center: true } :
      positionOf(win, buffer.id) ?? positionOf(from, buffer.id) ?? { line: 1, col: 0 };
    const pane = { win, buffer, position, ranges: candidate.ranges ?? NO_RANGES, error: null };
    usePickerPreviewStore.setState({ shown: pane, frame: null });
    if (buffer.content != null) return;
    let read = reads.get(key);
    if (!read) {
      read = readPreview(repo.repoPath, candidate.choice.source, candidate.path);
      reads.set(key, read);
      if (reads.size > 8) {
        const oldest = reads.keys().next().value!;
        reads.delete(oldest);
        buffers.delete(oldest);
      }
    }
    try {
      const content = await read;
      if (!ended && buffers.has(key)) buffers.set(key, { ...buffer, content });
      if (current()) {
        usePickerPreviewStore.setState({ shown: { ...pane, buffer: { ...buffer, content } } });
      }
    } catch (error) {
      if (current()) {
        usePickerPreviewStore.setState({ shown: { ...pane, error: String(error) } });
      }
    }
  }

  const session = {
    move(candidate: PreviewTarget | null, delay: number) {
      target = candidate;
      const ticket = ++generation;
      clearTimeout(timer);
      // Clear stale query results immediately; row navigation may retain the old view
      // during the debounce, labelled with its own path rather than the new candidate's.
      if (!candidate) usePickerPreviewStore.setState({ shown: null, frame: null });
      else if ("buffer" in candidate) {
        // Full-frame buffers never belong in the other-window picker.
        usePickerPreviewStore.setState({ shown: null, frame: options.other ? null : candidate.buffer });
        if (!options.other && candidate.buffer === "log" && useLogStore.getState().ref == null) void loadLog();
      }
      else if (delay === 0) void show(candidate, ticket);
      else timer = setTimeout(() => { void show(candidate, ticket); }, delay);
    },
    finish,
  };
  active = session;
  return session;
}
