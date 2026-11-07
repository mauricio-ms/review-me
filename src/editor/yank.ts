import { getCM, Vim, type CodeMirrorV } from "@replit/codemirror-vim";
import { ViewPlugin } from "@codemirror/view";

import { yankText } from "../lib/clipboard";

const viewers = new WeakSet<CodeMirrorV>();
let defined = false;

function defineYank(): void {
  if (defined) return;
  defined = true;
  // Operators are global in codemirror-vim. Preserve its register/cursor semantics
  // everywhere; only file viewers opt into the additional system clipboard write.
  Vim.defineOperator("yank", (cm, args, ranges, oldAnchor) => {
    const vim = cm.state.vim;
    let text = cm.getSelection();
    if (args.linewise && !text.endsWith("\n")) text += "\n";
    const registers = Vim.getRegisterController();
    const enabled = viewers.has(cm);
    if (enabled && args.registerName === "+") {
      // The built-in + register uses navigator.clipboard without handling failures.
      // Use the native writer below, retaining both Vim registers synchronously.
      registers.getRegister("+").setText(text, args.linewise, vim.visualBlock);
      registers.getRegister('"').setText(text, args.linewise, vim.visualBlock);
    } else {
      registers.pushText(args.registerName, "yank", text, args.linewise, vim.visualBlock);
    }
    if (enabled && args.registerName !== "_") yankText(text, !!args.linewise);
    return vim.visualMode
      ? [vim.sel.anchor, vim.sel.head, ranges[0].head, ranges[0].anchor].reduce(
        (a, b) => a.line < b.line || (a.line === b.line && a.ch <= b.ch) ? a : b,
      )
      : oldAnchor;
  });
}

/** Let Vim calculate motions, counts, text objects and visual ranges before copying. */
export const clipboardYank = ViewPlugin.fromClass(class {
  private readonly cm: CodeMirrorV | null;

  constructor(view: import("@codemirror/view").EditorView) {
    defineYank();
    this.cm = getCM(view) as CodeMirrorV | null;
    if (this.cm) viewers.add(this.cm);
  }

  destroy(): void {
    if (this.cm) viewers.delete(this.cm);
  }
});
