import type { CommandId } from "../components/useCommands";

/**
 * Every key binding in the app, in Emacs notation: chords are `C-x`, `M-.`, `RET`,
 * `TAB`, `ESC`, `<down>`, or a plain character, and a sequence is chords separated by
 * spaces (`C-x C-f`, `g g`, `] h`).
 *
 * This table is the single source for three things — what a key does (each scope's
 * dispatcher matches against it), the key column in `M-x`, and the help buffer
 * (`C-h b`) — so the cheat sheet can't drift from the keys. A key that isn't listed
 * here doesn't exist: add it here, then handle its action (the handler maps are typed
 * `Record<…Action, …>`, so a new action that nothing handles fails the build).
 */

export type KeyScope =
  | "global"
  | "start"
  | "diff"
  | "log"
  | "tree"
  | "viewer"
  | "help"
  | "minibuffer"
  | "editor";

export type KeyBinding = {
  /** Alternative sequences that do the same thing. */
  readonly keys: readonly string[];
  /** What it does, as the help buffer says it. */
  readonly doc: string;
  /** The scope's handler that runs it. */
  readonly action?: string;
  /** The `M-x` command it runs (global), or is the key for (M-x shows it). */
  readonly command?: CommandId;
  /** How the help buffer writes the keys when listing every alternative is noise. */
  readonly label?: string;
  /** Provided by vim or the mouse rather than dispatched from here: listed only. */
  readonly external?: true;
};

type ActionOfEntry<E> = E extends { readonly action: infer A extends string } ? A : never;
type ActionOf<T extends readonly unknown[]> = ActionOfEntry<T[number]>;

/** Everywhere outside a text field, a modal, or vim's insert mode. */
const GLOBAL_KEYS = [
  { keys: ["M-x"], action: "execute-extended-command", doc: "run any command by name" },
  {
    keys: ["C-g"],
    action: "keyboard-quit",
    doc: "cancel: a half-typed key, the minibuffer, a selection",
  },
  { keys: ["C-x C-f"], command: "find", doc: "find a file in the revision under review" },
  { keys: ["C-x b"], command: "switch-buffer", doc: "switch buffer" },
  { keys: ["C-x o"], command: "other-window", doc: "between the file tree and the viewer" },
  {
    keys: ["C-x {"],
    command: "shrink-tree",
    doc: "narrower file tree (then { } alone keep adjusting)",
  },
  { keys: ["C-x }"], command: "enlarge-tree", doc: "wider file tree" },
  { keys: ["C-x g"], command: "log", doc: "the commits buffer" },
  { keys: ["C-x p p"], command: "recent", doc: "recent repositories" },
  { keys: ["C-x p k"], command: "close", doc: "close the repository" },
  { keys: ["C-x v ="], command: "worktree", doc: "the working-tree diff" },
  { keys: ["C-x v v"], command: "commit-reviewed", doc: "commit the reviewed changes" },
  { keys: ["C-x x g"], command: "refresh", doc: "refresh" },
  {
    keys: ["C-x C-=", "C-x C-+"],
    command: "text-scale-increase",
    doc: "bigger text (then = + - 0 alone keep adjusting)",
  },
  { keys: ["C-x C--"], command: "text-scale-decrease", doc: "smaller text" },
  { keys: ["C-x C-0"], command: "text-scale-reset", doc: "back to the default text size" },
  { keys: ["C-h b"], command: "help", doc: "every key binding and command" },
  { keys: ["C-h m"], command: "describe-mode", doc: "the current buffer's keys" },
  { keys: ["C-h k"], command: "describe-key", doc: "press a key to see what it runs" },
] as const satisfies readonly KeyBinding[];

/** The start screen, while no repository is open. */
const START_KEYS = [
  { keys: ["j", "<down>"], action: "down", doc: "next repository" },
  { keys: ["k", "<up>"], action: "up", doc: "previous repository" },
  { keys: ["RET"], action: "open", doc: "open the repository" },
  {
    keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    label: "1 … 9",
    action: "open-nth",
    doc: "open a repository by its number",
  },
] as const satisfies readonly KeyBinding[];

const DIFF_KEYS = [
  { keys: ["j", "<down>"], action: "down", doc: "next row" },
  { keys: ["k", "<up>"], action: "up", doc: "previous row" },
  { keys: ["g g"], action: "first", doc: "first row" },
  { keys: ["G"], action: "last", doc: "last row" },
  { keys: ["] h"], action: "next-hunk", doc: "next hunk" },
  { keys: ["[ h"], action: "prev-hunk", doc: "previous hunk" },
  { keys: ["] f"], action: "next-file", doc: "next file" },
  { keys: ["[ f"], action: "prev-file", doc: "previous file" },
  { keys: ["] s"], action: "next-section", doc: "next section" },
  { keys: ["[ s"], action: "prev-section", doc: "previous section" },
  { keys: ["TAB"], action: "toggle", doc: "fold or unfold" },
  { keys: ["RET"], action: "open", doc: "open the file in the project buffer" },
  { keys: ["v", "V"], action: "visual", doc: "select lines" },
  { keys: ["ESC", "C-g"], action: "escape", doc: "end the selection" },
  { keys: ["r"], action: "review", doc: "mark reviewed" },
  { keys: ["f"], action: "flag", doc: "flag" },
  { keys: ["i"], action: "ignore", doc: "ignore" },
  { keys: ["u"], action: "unmark", doc: "unmark" },
  { keys: ["C-e"], action: "scroll-down", doc: "scroll one line down" },
  { keys: ["C-r"], action: "scroll-up", doc: "scroll one line up" },
  {
    keys: ["q"],
    action: "quit",
    doc: "back to the commits buffer (reviewing a commit or a range)",
  },
] as const satisfies readonly KeyBinding[];

const LOG_KEYS = [
  { keys: ["j", "<down>"], action: "down", doc: "next commit" },
  { keys: ["k", "<up>"], action: "up", doc: "previous commit" },
  { keys: ["g g"], action: "first", doc: "first commit" },
  { keys: ["G"], action: "last", doc: "last commit" },
  { keys: ["RET"], action: "open", doc: "review this commit" },
  { keys: ["b"], action: "range", doc: "review the whole listed range as one diff" },
] as const satisfies readonly KeyBinding[];

const TREE_KEYS = [
  { keys: ["j", "<down>"], action: "down", doc: "next row" },
  { keys: ["k", "<up>"], action: "up", doc: "previous row" },
  { keys: ["g g"], action: "first", doc: "first row" },
  { keys: ["G"], action: "last", doc: "last row" },
  { keys: ["TAB"], action: "toggle", doc: "fold or unfold the folder" },
  { keys: ["RET", "l", "<right>"], action: "open", doc: "open the file or the folder" },
  { keys: ["h", "<left>"], action: "close", doc: "close the folder, or go to its parent" },
  {
    keys: ["c"],
    action: "filter",
    command: "changed",
    doc: "all files ↔ only what the comparison changed",
  },
  { keys: ["q"], action: "quit", doc: "back to the diff" },
] as const satisfies readonly KeyBinding[];

/** The code viewer is CodeMirror in vim normal mode; these go through its keymap. */
const VIEWER_KEYS = [
  { keys: ["M-."], action: "definition", command: "goto-def", doc: "go to definition" },
  { keys: ["M-,"], action: "back", command: "jump-back", doc: "back to where you jumped from" },
  { keys: ["M-?"], action: "references", command: "find-refs", doc: "find references" },
  { keys: ["M-g g"], action: "goto-line", doc: "go to line" },
  { keys: ["C-<mouse-1>"], label: "C-click", external: true, doc: "go to definition" },
  { keys: ["q"], external: true, doc: "back to the diff" },
  {
    keys: ["h", "j", "k", "l"],
    label: "h j k l w b / …",
    external: true,
    doc: "vim motions and search (the viewer is read-only)",
  },
] as const satisfies readonly KeyBinding[];

const HELP_KEYS = [
  { keys: ["j", "<down>"], action: "down", doc: "scroll down" },
  { keys: ["k", "<up>"], action: "up", doc: "scroll up" },
  { keys: ["g g"], action: "first", doc: "top" },
  { keys: ["G"], action: "last", doc: "bottom" },
  { keys: ["C-s"], action: "search", doc: "search the bindings" },
  { keys: ["q"], action: "quit", doc: "back to where you were" },
] as const satisfies readonly KeyBinding[];

/** `M-x`, `C-x b`, and every prompt read at the bottom of the window. */
const MINIBUFFER_KEYS = [
  { keys: ["<down>", "C-n"], action: "next", doc: "next candidate" },
  { keys: ["<up>", "C-p"], action: "prev", doc: "previous candidate" },
  { keys: ["TAB"], action: "complete", doc: "complete the candidate's name" },
  { keys: ["RET"], action: "accept", doc: "run, open, or accept" },
  { keys: ["C-g", "ESC"], action: "quit", doc: "quit" },
] as const satisfies readonly KeyBinding[];

/** The note and commit-message editors (vim inside, Emacs to finish). */
const EDITOR_KEYS = [
  { keys: ["C-c C-c", "C-RET"], action: "finish", doc: "save and close" },
  { keys: ["C-c C-k"], action: "cancel", doc: "cancel, discarding the edit" },
  { keys: [":wq", ":q"], label: ":wq :q", external: true, doc: "the same, from vim" },
] as const satisfies readonly KeyBinding[];

export type GlobalAction = ActionOf<typeof GLOBAL_KEYS>;
export type StartAction = ActionOf<typeof START_KEYS>;
export type DiffAction = ActionOf<typeof DIFF_KEYS>;
export type LogAction = ActionOf<typeof LOG_KEYS>;
export type TreeAction = ActionOf<typeof TREE_KEYS>;
export type ViewerAction = ActionOf<typeof VIEWER_KEYS>;
export type HelpAction = ActionOf<typeof HELP_KEYS>;
export type MinibufferAction = ActionOf<typeof MINIBUFFER_KEYS>;
export type EditorAction = ActionOf<typeof EDITOR_KEYS>;

export const KEYMAP: Record<KeyScope, readonly KeyBinding[]> = {
  global: GLOBAL_KEYS,
  start: START_KEYS,
  diff: DIFF_KEYS,
  log: LOG_KEYS,
  tree: TREE_KEYS,
  viewer: VIEWER_KEYS,
  help: HELP_KEYS,
  minibuffer: MINIBUFFER_KEYS,
  editor: EDITOR_KEYS,
};

export const SCOPE_TITLE: Record<KeyScope, string> = {
  global: "Everywhere",
  start: "Start screen",
  diff: "Diff buffer",
  log: "Commits buffer (log)",
  tree: "Project tree",
  viewer: "Code viewer",
  help: "Help",
  minibuffer: "Minibuffer",
  editor: "Note and commit editors",
};

/** How the help buffer and `M-x` write a binding's keys. */
export function keysLabel(binding: KeyBinding): string {
  return binding.label ?? binding.keys.join(", ");
}

/** The key for `command` reachable from `scope` (global keys first), if it has one. */
export function commandKeys(command: CommandId, scope: KeyScope): string | null {
  const binding = [...KEYMAP.global, ...KEYMAP[scope]].find(
    (b) => b.command === command && !b.external,
  );
  return binding ? keysLabel(binding) : null;
}

/** Every command some binding runs or names — the rest are `M-x` only. */
export function boundCommands(): Set<CommandId> {
  const out = new Set<CommandId>();
  for (const bindings of Object.values(KEYMAP)) {
    for (const b of bindings) if (b.command) out.add(b.command);
  }
  return out;
}
