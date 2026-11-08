import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";

/**
 * True when vim is in insert/replace mode. In those modes keys must insert literal
 * characters, so the app's own bindings bail out. We read the authoritative
 * vim state from the view rather than relying on keymap precedence (which fires in
 * insert mode too). This is the hard-won rule from video-studio's CLAUDE.md.
 */
export function inVimInsertMode(view: EditorView): boolean {
  const cm = getCM(view) as
    | { state?: { vim?: { insertMode?: boolean } } }
    | null;
  return !!cm?.state?.vim?.insertMode;
}

/**
 * Hand Escape / Ctrl+[ to Vim directly: cancel prefixes and exit modes, preserving
 * search highlights as Evil does. The extension's DOM handler also clears highlights.
 * WebKitGTK additionally drops its Ctrl+[ binding.
 */
export const vimEscapeKeymap = Prec.highest(
  keymap.of(
    ["Escape", "Ctrl-["].map((key) => ({
      key,
      run: (view: EditorView) => {
        const cm = getCM(view);
        if (!cm) return false;
        Vim.handleKey(cm, "<Esc>", "user");
        return true;
      },
    })),
  ),
);

/**
 * The arrows, Home/End and PageUp/PageDown as vim's own keys (`<Down>` is its `j`, …).
 * CodeMirror's default keymap reads keys before vim and would move the cursor itself —
 * by a wrapped line, and dropping a visual selection the diff's arrows extend.
 */
export const vimNavKeymap = Prec.highest(
  keymap.of(
    ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].map(
      (key) => ({
        key,
        run: (view: EditorView) => {
          if (inVimInsertMode(view)) return false;
          const cm = getCM(view);
          if (!cm) return false;
          Vim.handleKey(cm, `<${key.replace("Arrow", "")}>`, "user");
          return true;
        },
      }),
    ),
  ),
);
