import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

/** Replace the set of flagged line ranges (1-based, inclusive) shown in the viewer. */
export const setFlagLines = StateEffect.define<Array<[number, number]>>();

const flaggedLine = Decoration.line({ attributes: { class: "cm-flagged-line" } });

export const flagDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFlagLines)) {
        const builder = new RangeSetBuilder<Decoration>();
        const doc = tr.state.doc;
        // Lines must be added in ascending position order.
        const lines = new Set<number>();
        for (const [lo, hi] of effect.value) {
          for (let ln = lo; ln <= hi; ln++) lines.add(ln);
        }
        for (const ln of [...lines].sort((a, b) => a - b)) {
          if (ln >= 1 && ln <= doc.lines) {
            builder.add(doc.line(ln).from, doc.line(ln).from, flaggedLine);
          }
        }
        return builder.finish();
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
