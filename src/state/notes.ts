import { create } from "zustand";

import type { DiffTarget } from "../lib/diff-view";

/** The note being edited: on an existing flag, or on lines a save will flag. */
export type NoteEdit = {
  target: DiffTarget;
  /** The flag the note belongs to; null until the first save creates one. */
  flagId: string | null;
  /** The note as last saved — what "unsaved changes" is measured against. */
  saved: string;
};

type NotesState = {
  editing: NoteEdit | null;
  /** Bumped by every `open`, so each opening gets a fresh editor. */
  session: number;
  open: (edit: NoteEdit) => void;
  /** Record a save: the flag it landed on and the text now on disk. */
  saved: (flagId: string, text: string) => void;
  close: () => void;
};

export const useNotesStore = create<NotesState>((set) => ({
  editing: null,
  session: 0,
  open: (edit) => set((s) => ({ editing: edit, session: s.session + 1 })),
  saved: (flagId, text) =>
    set((s) => (s.editing ? { editing: { ...s.editing, flagId, saved: text } } : {})),
  close: () => set({ editing: null }),
}));
