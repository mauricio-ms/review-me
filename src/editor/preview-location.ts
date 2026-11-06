import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

export const setPreviewLocation = StateEffect.define<{
  line: number;
  ranges: readonly { from: number; to: number }[];
}>();

/** Source positions and ranges are UTF-16, like all CodeMirror document offsets. */
export const previewLocation = StateField.define({
  create: () => ({ line: null as number | null, decorations: Decoration.none }),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setPreviewLocation)) continue;
      const line = transaction.state.doc.line(Math.min(Math.max(1, effect.value.line), transaction.state.doc.lines));
      const marks = [Decoration.line({ class: "cm-preview-line" }).range(line.from)];
      for (const range of effect.value.ranges) {
        const from = Math.max(0, Math.min(range.from, line.length));
        const to = Math.max(from, Math.min(range.to, line.length));
        if (to > from) marks.push(Decoration.mark({ class: "cm-preview-match" }).range(line.from + from, line.from + to));
      }
      return { line: line.number, decorations: Decoration.set(marks, true) };
    }
    return transaction.docChanged ? { line: null, decorations: Decoration.none } : value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** Keep a previewed Markdown source row visible while its picker has the keyboard. */
export function pickerPreviewLine(state: EditorState): number | null {
  return state.field(previewLocation, false)?.line ?? null;
}
