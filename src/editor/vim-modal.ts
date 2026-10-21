import { Vim } from "@replit/codemirror-vim";

/**
 * What the vim ex commands do in the modal editor that has focus. codemirror-vim's ex
 * commands are global — defining `:wq` twice just replaces the first — so every modal
 * editor (the commit message, a review note) shares this one set and installs its own
 * actions while it is open.
 */
export type ModalEditorActions = {
  /** `:w` — save and keep editing. Omit where that means nothing. */
  write?: () => void;
  /** `:wq` / `:x`. */
  writeQuit: () => void;
  /** `:q` / `:cq`; `force` is set for `:q!` / `:cq!`. */
  quit: (force: boolean) => void;
};

type ExParams = { argString?: string };

let defined = false;
let actions: ModalEditorActions | null = null;
let owner: symbol | null = null;

/**
 * Point the ex commands at `next` until the returned release runs. Releasing only
 * clears a claim that is still current, so one editor closing can never disarm
 * another that opened since.
 */
export function claimModalEditor(next: ModalEditorActions): () => void {
  const token = Symbol("modal-editor");
  owner = token;
  actions = next;
  return () => {
    if (owner !== token) return;
    owner = null;
    actions = null;
  };
}

export function defineModalEditorVim(): void {
  if (defined) return;
  defined = true;
  const v = Vim as unknown as {
    defineEx: (
      name: string,
      prefix: string,
      fn: (cm: unknown, params: ExParams) => void,
    ) => void;
  };
  // `:q!` parses as command `q` with argument `!`.
  const forced = (params: ExParams) => (params.argString ?? "").trim().startsWith("!");
  v.defineEx("wReviewMe", "w", () => actions?.write?.());
  v.defineEx("wqReviewMe", "wq", () => actions?.writeQuit());
  v.defineEx("xReviewMe", "x", () => actions?.writeQuit());
  v.defineEx("qReviewMe", "q", (_cm, params) => actions?.quit(forced(params)));
  v.defineEx("cqReviewMe", "cq", (_cm, params) => actions?.quit(forced(params)));
}
