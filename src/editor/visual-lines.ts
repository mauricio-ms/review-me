import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { getCM, type CodeMirrorV } from "@replit/codemirror-vim";

const visualLine = Decoration.line({ class: "cm-visual-line" });

/** The whole lines vim's `V` has selected, in view — none outside line-wise visual mode. */
function decorate(view: EditorView): DecorationSet {
  const vim = (getCM(view) as CodeMirrorV | null)?.state.vim;
  if (!vim?.visualMode || !vim.visualLine) return Decoration.none;
  const { doc, selection } = view.state;
  const sel = selection.main;
  const from = doc.lineAt(Math.max(sel.from, view.viewport.from)).number;
  const to = doc.lineAt(Math.min(sel.to, view.viewport.to)).number;
  const builder = new RangeSetBuilder<Decoration>();
  for (let n = from; n <= to; n++) builder.add(doc.line(n).from, doc.line(n).from, visualLine);
  return builder.finish();
}

/**
 * Vim's `V` marks whole rows, as the diff buffer's `V` does — what `!`, `u` and
 * `M-x note` act on. CodeMirror's own selection stops where each line's text does.
 *
 * Leaving visual mode moves the cursor first and clears vim's flags after, with no
 * update between, so the mode change asks for one more — from a microtask, since vim
 * can signal it inside an update (a mouse selection).
 */
export const visualLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private readonly onMode = () =>
      queueMicrotask(() => {
        if (!this.destroyed) this.view.dispatch({});
      });
    private destroyed = false;

    constructor(private readonly view: EditorView) {
      this.decorations = decorate(view);
      getCM(view)?.on("vim-mode-change", this.onMode);
    }

    update(update: ViewUpdate) {
      this.decorations = decorate(update.view);
    }

    destroy() {
      this.destroyed = true;
      getCM(this.view)?.off("vim-mode-change", this.onMode);
    }
  },
  { decorations: (p) => p.decorations },
);
