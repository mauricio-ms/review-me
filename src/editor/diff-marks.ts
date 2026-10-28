import { RangeSet, StateEffect, StateField, type Range, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  gutter,
  GutterMarker,
  WidgetType,
} from "@codemirror/view";

import type { ChangeBlock } from "../lib/project-diff";
import type { WordSeg } from "../lib/word-diff";

/**
 * A change block plus how much of its diff the viewer shows: `shown` is the full inline
 * diff (`M-x hunk`/`M-x hunks`), `showRemoved` just the removed lines — the changed-files view
 * always has those.
 */
export type ShownBlock = ChangeBlock & { shown: boolean; showRemoved: boolean };

/**
 * Replace the change marks of the file in the project viewer: gutter signs and line
 * tints always, and — for blocks shown inline — the removed lines and word highlights.
 */
export const setDiffMarks = StateEffect.define<ShownBlock[]>();

/** A gutter sign: a bar for written lines, a notch where lines were removed. */
class ChangeSign extends GutterMarker {
  constructor(readonly cls: string) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof ChangeSign && other.cls === this.cls;
  }

  toDOM(): Node {
    const el = document.createElement("div");
    el.className = this.cls;
    return el;
  }
}

/** The old lines a change took out, rendered between the new ones. */
class RemovedLines extends WidgetType {
  constructor(
    readonly id: string,
    readonly lines: string[],
    readonly segs: (WordSeg[] | null)[],
    /** Highlight the changed words — only as part of the full inline diff. */
    readonly words: boolean,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof RemovedLines && other.id === this.id && other.words === this.words;
  }

  toDOM(): HTMLElement {
    const root = document.createElement("div");
    root.className = "cm-diff-removed";
    this.lines.forEach((text, i) => {
      const line = document.createElement("div");
      line.className = "cm-diff-removed-line";
      const segs = this.words ? this.segs[i] : null;
      if (!segs) {
        // A run with nothing to pair against: the line simply went.
        line.textContent = text || "​";
      } else {
        for (const seg of segs) {
          const span = document.createElement("span");
          if (seg.changed) span.className = "cm-diff-word";
          span.textContent = seg.text;
          line.appendChild(span);
        }
        if (!line.textContent) line.textContent = "​";
      }
      root.appendChild(line);
    });
    return root;
  }
}

type Marks = { deco: DecorationSet; signs: RangeSet<GutterMarker> };

const EMPTY_MARKS: Marks = { deco: Decoration.none, signs: RangeSet.empty };

const lineClass = (cls: string) => Decoration.line({ attributes: { class: cls } });
const ADDED_LINE = lineClass("cm-diff-line-added");
const MODIFIED_LINE = lineClass("cm-diff-line-modified");
// A shown change reads like the diff buffer: everything it wrote is new (green).
const NEW_LINE = lineClass("cm-diff-line-new");
const WORD = Decoration.mark({ class: "cm-diff-word" });

function buildMarks(doc: Text, blocks: ShownBlock[]): Marks {
  const deco: Range<Decoration>[] = [];
  // Per line: one sign, whose classes stack (a bar plus a removal notch).
  const signs = new Map<number, string[]>();
  const sign = (line: number, cls: string) => {
    const at = Math.min(Math.max(1, line), doc.lines);
    signs.set(at, [...(signs.get(at) ?? []), cls]);
  };
  // A removal before line `at`: a notch at its top, or the last line's bottom when
  // the lines went from the very end.
  const removalSign = (at: number) =>
    at > doc.lines
      ? sign(doc.lines, "cm-diff-sign-removed-below")
      : sign(at, "cm-diff-sign-removed");

  for (const block of blocks) {
    const valid = (ln: number) => ln >= 1 && ln <= doc.lines;
    for (const ln of block.modified.filter(valid)) {
      sign(ln, "cm-diff-sign-modified");
      deco.push((block.shown ? NEW_LINE : MODIFIED_LINE).range(doc.line(ln).from));
    }
    for (const ln of block.added.filter(valid)) {
      sign(ln, "cm-diff-sign-added");
      deco.push((block.shown ? NEW_LINE : ADDED_LINE).range(doc.line(ln).from));
    }
    if (block.removed.length > 0 && block.modified.length === 0 && block.added.length === 0) {
      removalSign(block.removedAt);
    }
    if (block.trailingRemoval) {
      // More went than came: the rest were taken out just below the new lines.
      const written = [...block.modified, ...block.added];
      removalSign(written[written.length - 1] + 1);
    }

    if (block.removed.length > 0 && (block.shown || block.showRemoved)) {
      const widget = new RemovedLines(
        block.id,
        block.removed.map((l) => l.content),
        block.removedSegs,
        block.shown,
      );
      deco.push(
        block.removedAt > doc.lines
          ? Decoration.widget({ widget, block: true, side: 1 }).range(doc.length)
          : Decoration.widget({ widget, block: true, side: -1 }).range(
              doc.line(Math.max(1, block.removedAt)).from,
            ),
      );
    }
    if (!block.shown) continue;
    for (const [ln, segs] of block.newSegs) {
      // Only where the viewer still holds the text the diff saw — a file changed on
      // disk since the diff was computed would put the highlights on the wrong words.
      if (!valid(ln) || doc.line(ln).text !== block.newText.get(ln)) continue;
      let pos = doc.line(ln).from;
      for (const seg of segs) {
        if (seg.changed && seg.text.length > 0) {
          deco.push(WORD.range(pos, pos + seg.text.length));
        }
        pos += seg.text.length;
      }
    }
  }

  const signRanges = [...signs]
    .sort(([a], [b]) => a - b)
    .map(([ln, classes]) => new ChangeSign(classes.join(" ")).range(doc.line(ln).from));
  return { deco: Decoration.set(deco, true), signs: RangeSet.of(signRanges) };
}

const diffMarksField = StateField.define<Marks>({
  create: () => EMPTY_MARKS,
  update(marks, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDiffMarks)) return buildMarks(tr.state.doc, effect.value);
    }
    if (!tr.docChanged) return marks;
    return { deco: marks.deco.map(tr.changes), signs: marks.signs.map(tr.changes) };
  },
  provide: (f) => EditorView.decorations.from(f, (marks) => marks.deco),
});

const REMOVED_SIGN = new ChangeSign("cm-diff-sign-removed-lines");

/** The project viewer's change marks: add `diffMarks`, then dispatch `setDiffMarks`. */
export const diffMarks = [
  diffMarksField,
  gutter({
    class: "cm-diff-gutter",
    markers: (view) => view.state.field(diffMarksField).signs,
    // The inline removed lines get a red bar of their own.
    widgetMarker: (_view, widget) => (widget instanceof RemovedLines ? REMOVED_SIGN : null),
    initialSpacer: () => new ChangeSign(""),
  }),
];
