import { afterEach, assert, beforeEach, equal, run, test, waitFor } from "./support";
import { openFile, repoFixture, resetState } from "./fixtures";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import { inVimInsertMode, vimEscapeKeymap } from "../src/editor/cm-shared";
import { viewerKeymap } from "../src/editor/viewer-keymap";
import {
  armRepeat, chordOf, contextScope, describeNextKey, dispatchKey, feedKey, feedRepeat,
  isDescribingKey, startDescribeKey,
} from "../src/lib/key-dispatch";
import type { KeyBinding } from "../src/lib/keymap";
import { registerFileView } from "../src/lib/project-view";
import { useMinibufferStore } from "../src/state/minibuffer";
import { useUIStore } from "../src/state/ui";
import { useWindowStore } from "../src/state/windows";

const event = (key: string, extra: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
const bindings: KeyBinding[] = [
  { keys: ["C-x b"], action: "switch", doc: "switch buffer" },
  { keys: ["g g"], action: "top", doc: "go to top" },
  { keys: [":w"], external: true, doc: "vim write" },
];
let view: EditorView | null = null;
let unregister: (() => void) | null = null;
beforeEach(() => {
  resetState();
  feedKey("test", "C-g", []); armRepeat({});
  if (isDescribingKey()) describeNextKey(event("Escape"), "global", [], () => null);
});
afterEach(() => { unregister?.(); unregister = null; view?.destroy(); view = null; document.querySelectorAll(".keyboard-fixture").forEach(node => node.remove()); });

test("keyboard chords normalize modifiers, shifted names and punctuation", () => {
  equal(chordOf(event("X", { ctrlKey: true })), "C-x");
  equal(chordOf(event("x", { ctrlKey: true, shiftKey: true })), "C-X");
  equal(chordOf(event("?", { altKey: true, shiftKey: true })), "M-?");
  equal(chordOf(event("Tab", { shiftKey: true })), "S-TAB");
  equal(chordOf(event("ArrowLeft", { ctrlKey: true })), "C-<left>");
  equal(chordOf(event("F5")), "<f5>");
});

test("desktop keys, composition events and lone modifiers are not app chords", () => {
  for (const key of ["Shift", "Control", "AltGraph", "Dead", "Process", "Unidentified"]) equal(chordOf(event(key)), null);
  equal(chordOf(event("x", { metaKey: true })), null);
});

test("prefix sequences match only after completion and clear after a match", () => {
  equal(feedKey("one", "C-x", bindings), { kind: "pending", keys: "C-x" });
  const matched = feedKey("one", "b", bindings);
  equal(matched.kind, "match");
  if (matched.kind === "match") equal(matched.binding.action, "switch");
  equal(feedKey("one", "b", bindings), { kind: "none" });
});

test("a prefix in one key scope cannot combine with a key in another", () => {
  feedKey("global", "C-x", bindings);
  equal(feedKey("diff", "b", bindings), { kind: "none" });
  equal(feedKey("diff", "g", bindings), { kind: "pending", keys: "g" });
  equal(feedKey("global", "g", bindings), { kind: "pending", keys: "g" });
});

test("C-g cancels a pending prefix regardless of which scope owns it", () => {
  feedKey("global", "C-x", bindings);
  equal(feedKey("minibuffer", "C-g", bindings), { kind: "quit" });
  equal(feedKey("global", "b", bindings), { kind: "none" });
});

test("undefined prefixed keys are consumed and reported while unrelated keys pass through", () => {
  const handlers = { switch: () => true, top: () => true };
  const unrelated = event("z"); equal(dispatchKey("diff", unrelated, bindings, handlers), false); equal(unrelated.defaultPrevented, false);
  dispatchKey("diff", event("x", { ctrlKey: true }), bindings, handlers);
  const undefinedKey = event("z"); equal(dispatchKey("diff", undefinedKey, bindings, handlers), true);
  equal(undefinedKey.defaultPrevented, true); equal(useUIStore.getState().flash, "C-x z is undefined");
});

test("declined handlers and externally handled bindings leave events unconsumed", () => {
  const keys: KeyBinding[] = [{ keys: ["r"], action: "review", doc: "review" }, ...bindings];
  const e = event("r"); equal(dispatchKey("viewer", e, keys, { review: () => false }), false);
  equal(e.defaultPrevented, false); equal(feedKey("viewer", ":w", keys), { kind: "none" });
});

test("repeat maps run matching keys and disarm on the first different key", () => {
  let repeats = 0; armRepeat({ "<left>": () => repeats++ });
  const left = event("ArrowLeft"); equal(feedRepeat(left), true); equal(left.defaultPrevented, true);
  equal(repeats, 1); equal(feedRepeat(event("z")), false); equal(feedRepeat(event("ArrowLeft")), false);
});

test("context follows the actual focused buffer and tree, including help without a repository", () => {
  equal(contextScope(), "start"); useWindowStore.getState().show(1, "help"); equal(contextScope(), "help");
  repoFixture(); const a = openFile(); useWindowStore.getState().show(1, a.id); equal(contextScope(), "viewer");
  useWindowStore.getState().setTreeFocused(true); equal(contextScope(), "tree");
  useWindowStore.getState().select(1); useWindowStore.getState().show(1, "log"); equal(contextScope(), "log");
});

test("describe-key reports a command without executing it", () => {
  startDescribeKey(); assert(isDescribingKey());
  describeNextKey(event("x", { ctrlKey: true }), "global", bindings, () => "switch-buffer");
  assert(isDescribingKey());
  describeNextKey(event("b"), "global", bindings, () => "switch-buffer");
  equal(isDescribingKey(), false); equal(useUIStore.getState().keyEcho, null);
  equal(useUIStore.getState().flash, "C-x b runs switch-buffer: switch buffer");
});

test("pending prefixes appear in the echo area and disappear on cancellation", async () => {
  feedKey("global", "C-x", bindings);
  await waitFor(() => useUIStore.getState().keyEcho === "C-x-");
  feedKey("global", "C-g", bindings); equal(useUIStore.getState().keyEcho, null);
});

test("viewer shortcuts defer to Vim insert mode and work again after Ctrl-[", () => {
  repoFixture(); const a = openFile(); useWindowStore.getState().show(1, a.id);
  const parent = document.body.appendChild(document.createElement("div")); parent.className = "keyboard-fixture";
  view = new EditorView({ parent, state: EditorState.create({ doc: "one\ntwo", extensions: [viewerKeymap, vimEscapeKeymap, vim()] }) });
  registerFileView(1, a.id, view); unregister = () => registerFileView(1, a.id, null);
  const cm = getCM(view); assert(cm); Vim.handleKey(cm, "i", "user"); assert(inVimInsertMode(view));
  view.contentDOM.dispatchEvent(event("s", { ctrlKey: true })); equal(useMinibufferStore.getState().request, null);
  view.contentDOM.dispatchEvent(event("[", { ctrlKey: true })); equal(inVimInsertMode(view), false);
  view.contentDOM.dispatchEvent(event("s", { ctrlKey: true }));
  equal(useMinibufferStore.getState().request?.kind, "swiper");
});

void run();
