import { syntaxTree } from "@codemirror/language";
import {
  CharCategory,
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { getStyleTags, tags, type Tag } from "@lezer/highlight";

import type { Occurrences } from "../types/xref";

/**
 * Asks the cross-reference index where the symbol at a cursor (1-based line, 0-based
 * col) occurs in this file. Null means the index can't say, and the viewer matches the
 * word by name instead.
 */
export type OccurrenceLookup = (line: number, col: number) => Promise<Occurrences | null>;

type Span = { from: number; to: number };

/** How long the cursor rests on a symbol before its occurrences light up. */
const REST_MS = 120;
/** A name used more often than this in one file marks only its first ones. */
const MAX_MARKS = 2000;

const setOccurrences = StateEffect.define<Span[]>();
const occurrenceMark = Decoration.mark({ class: "cm-occurrence" });

/**
 * The marked occurrences. They go the moment the cursor leaves them, before the next
 * answer arrives, so a mark never stands for a symbol the cursor has moved off; a
 * document change (a re-read) drops them too.
 */
const occurrenceField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const e of tr.effects) {
      if (e.is(setOccurrences)) {
        return Decoration.set(e.value.map((s) => occurrenceMark.range(s.from, s.to)));
      }
    }
    if (tr.docChanged) return Decoration.none;
    if (tr.selection && marks.size > 0) {
      const head = tr.state.selection.main.head;
      let under = false;
      marks.between(head, head, (from, to) => {
        if (from <= head && head < to) under = true;
      });
      if (!under || !tr.state.selection.main.empty) return Decoration.none;
    }
    return marks;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Keywords, comments and literals are words, but not symbols anyone means to trace. */
const NOT_A_SYMBOL = new Set<Tag>([tags.keyword, tags.comment, tags.literal]);

/** Whether the word at `pos` is a symbol, as far as the file's grammar says. */
function isSymbol(state: EditorState, pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, 1);
  for (;;) {
    const style = getStyleTags(node);
    if (style) return !style.tags.some((t) => t.set.some((p) => NOT_A_SYMBOL.has(p)));
    if (!node.parent) return true;
    node = node.parent;
  }
}

/** The symbol whose word the cursor is on (vim's block cursor: the character at `head`). */
function wordUnder(state: EditorState, head: number): string | null {
  const isWord = state.charCategorizer(head);
  if (isWord(state.sliceDoc(head, head + 1)) !== CharCategory.Word) return null;
  const range = state.wordAt(head);
  if (!range) return null;
  const word = state.sliceDoc(range.from, range.to);
  if (/^\d/.test(word) || !isSymbol(state, head)) return null;
  return word;
}

/** The index's answer as document ranges, or null when it no longer fits the document. */
function fromIndex(state: EditorState, found: Occurrences, head: number): Span[] | null {
  const spans: Span[] = [];
  for (const s of found.spans) {
    if (s.line > state.doc.lines) return null;
    const from = state.doc.line(s.line).from + s.col;
    const to = from + found.name.length;
    // The index read the file when it was built; a file changed on disk since then
    // reads differently here, and its positions would mark the wrong text.
    if (state.sliceDoc(from, to) !== found.name) return null;
    spans.push({ from, to });
  }
  if (spans.length > 0 && !spans.some((s) => s.from <= head && head < s.to)) return null;
  return spans;
}

let docText: { doc: Text; text: string } | null = null;

/** Every whole-word occurrence of `word` that is a symbol — the fallback without an index. */
function byName(state: EditorState, word: string): Span[] {
  if (docText?.doc !== state.doc) docText = { doc: state.doc, text: state.doc.toString() };
  const { text } = docText;
  const isWord = state.charCategorizer(0);
  const wordAt = (i: number) => i >= 0 && i < text.length && isWord(text[i]) === CharCategory.Word;
  const spans: Span[] = [];
  for (let i = text.indexOf(word); i >= 0 && spans.length < MAX_MARKS; i = text.indexOf(word, i + 1)) {
    if (wordAt(i - 1) || wordAt(i + word.length) || !isSymbol(state, i)) continue;
    spans.push({ from: i, to: i + word.length });
  }
  return spans;
}

/**
 * Highlight the other occurrences of the symbol under the cursor once it rests there —
 * by the cross-reference index where it reads the language (`lookup`), so a field and
 * a same-named local stay apart, else by name. A selection shows its own matches
 * (`highlightSelectionMatches`), so it shows none of these.
 */
export function occurrenceHighlight(lookup: OccurrenceLookup | null): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      timer: number | null = null;
      /** Bumped by every move, so an answer for a place already left is dropped. */
      ticket = 0;

      constructor(readonly view: EditorView) {
        this.schedule();
      }

      update(update: ViewUpdate) {
        if (update.selectionSet || update.docChanged) this.schedule();
      }

      destroy() {
        if (this.timer != null) window.clearTimeout(this.timer);
        this.ticket++;
      }

      schedule() {
        const ticket = ++this.ticket;
        if (this.timer != null) window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
          this.timer = null;
          void this.mark(ticket);
        }, REST_MS);
      }

      async mark(ticket: number) {
        const { state } = this.view;
        const sel = state.selection.main;
        const word = sel.empty ? wordUnder(state, sel.head) : null;
        if (!word) return this.show(ticket, []);
        if (lookup) {
          const line = state.doc.lineAt(sel.head);
          const found = await lookup(line.number, sel.head - line.from).catch(() => null);
          if (ticket !== this.ticket) return;
          const spans = found && fromIndex(this.view.state, found, sel.head);
          if (spans) return this.show(ticket, spans);
        }
        this.show(ticket, byName(this.view.state, word));
      }

      show(ticket: number, spans: Span[]) {
        if (ticket !== this.ticket) return;
        const marks = this.view.state.field(occurrenceField);
        if (spans.length === 0 && marks.size === 0) return;
        this.view.dispatch({ effects: setOccurrences.of(spans) });
      }
    },
  );
  return [occurrenceField, plugin];
}
