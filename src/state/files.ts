import { create } from "zustand";

import type { ProjectSource } from "../types/repo";
import type { FileBufferId } from "./windows";

/**
 * An open file: one path read at one revision. Opening a file never replaces another
 * — each keeps its own buffer (and, per window, its own cursor and scroll), listed in
 * `C-x b` until `C-x k` kills it.
 */
export type FileBuffer = {
  id: FileBufferId;
  path: string;
  /** The revision it was read from — the comparison's new side, or its old side. */
  source: ProjectSource;
  /** How to name `source` (e.g. "feature@e780b4a"); null = the working tree. */
  sourceLabel: string | null;
  /** The text, or null while it is being read. */
  content: string | null;
};

let nextId = 1;

export function newFileBufferId(): FileBufferId {
  return `file:${nextId++}`;
}

type FilesState = {
  /** Open buffers, in the order they were opened (`C-x <left>`/`<right>` cycle them). */
  buffers: FileBuffer[];
  /**
   * A file read only to be previewed from the tree (`lib/project.ts`'s `previewFile`):
   * not open, so nothing that lists buffers sees it — until opening it adopts it, id and
   * all, which keeps the window's view of it.
   */
  preview: FileBuffer | null;
  add: (buffer: FileBuffer) => void;
  setPreview: (buffer: FileBuffer | null) => void;
  /** The preview, opened: one of `buffers` from now on. */
  adopt: (id: FileBufferId) => void;
  update: (id: FileBufferId, patch: Partial<Omit<FileBuffer, "id">>) => void;
  remove: (ids: FileBufferId[]) => void;
  reset: () => void;
};

const EMPTY_BUFFERS: FileBuffer[] = [];

export const useFilesStore = create<FilesState>((set) => ({
  buffers: EMPTY_BUFFERS,
  preview: null,
  add: (buffer) => set((s) => ({ buffers: [...s.buffers, buffer] })),
  setPreview: (buffer) => set({ preview: buffer }),
  adopt: (id) =>
    set((s) =>
      s.preview?.id === id ? { buffers: [...s.buffers, s.preview], preview: null } : {},
    ),
  update: (id, patch) =>
    set((s) => ({ buffers: s.buffers.map((b) => (b.id === id ? { ...b, ...patch } : b)) })),
  remove: (ids) =>
    set((s) => {
      const gone = new Set(ids);
      const buffers = s.buffers.filter((b) => !gone.has(b.id));
      return buffers.length === s.buffers.length ? {} : { buffers };
    }),
  reset: () => set({ buffers: EMPTY_BUFFERS, preview: null }),
}));

/** A buffer a window can have on screen: an open one, or the file being previewed. */
export function bufferOnScreen(s: FilesState, id: FileBufferId): FileBuffer | undefined {
  return s.buffers.find((b) => b.id === id) ?? (s.preview?.id === id ? s.preview : undefined);
}

/** The buffer with this id, if it is still open. */
export function fileBuffer(id: FileBufferId): FileBuffer | undefined {
  return useFilesStore.getState().buffers.find((b) => b.id === id);
}
