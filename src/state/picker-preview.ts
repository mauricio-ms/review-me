import { create } from "zustand";
import type { ViewPos } from "../lib/project-view";
import type { FileBuffer } from "./files";
import type { WindowId } from "./windows";

/** A separate view: the covered buffer keeps its exact cursor, selection and scroll. */
export type PickerPreview = {
  win: WindowId;
  buffer: FileBuffer;
  position: ViewPos;
  ranges: readonly { from: number; to: number }[];
  error: string | null;
};

export const usePickerPreviewStore = create<{
  owner: number | null;
  shown: PickerPreview | null;
}>(() => ({ owner: null, shown: null }));
