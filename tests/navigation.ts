import { assert, beforeEach, equal, run, test } from "./support";
import { openFile, repoFixture, resetState } from "./fixtures";
import { killFileBuffers, quitFile, quitWindow, showBuffer, showDiff, stepBuffer } from "../src/lib/buffers";
import { goBack, goForward } from "../src/lib/history";
import { positionOf, savePosition } from "../src/lib/project-view";
import { deleteOtherWindows, deleteWindow, display, otherWindow, otherWindowFor, showProject, splitWindow } from "../src/lib/windows";
import { useFilesStore } from "../src/state/files";
import { samePlace, useHistoryStore, type Place } from "../src/state/history";
import { useProjectStore } from "../src/state/project";
import { useUIStore } from "../src/state/ui";
import { inProjectMode, onScreen, useWindowStore, windowOrder } from "../src/state/windows";

beforeEach(() => { resetState(); repoFixture(); });
const ws = () => useWindowStore.getState();
const place = (line: number): Extract<Place, { kind: "file" }> => ({ kind: "file", path: "a.ts", choice: { source: { kind: "worktree" }, label: null }, line, col: 0 });

test("splitting a file preserves selection and starts its other view at the same cursor", () => {
  const a = openFile(); display(a.id, 1);
  savePosition(1, a.id, { line: 2, col: 1, top: 1, center: true });
  splitWindow("column");
  equal(windowOrder(ws().layout), [1, 2]); equal(ws().selected, 1);
  equal(ws().shown[2], a.id);
  equal(positionOf(2, a.id), { line: 2, col: 1, top: 1, center: false });
  savePosition(2, a.id, { line: 3, col: 0 });
  equal(positionOf(1, a.id)?.line, 2);
});

test("singleton buffers reuse their existing window", () => {
  const a = openFile(); display(a.id, 1);
  const other = ws().split(1, "row", "log");
  equal(display("log", 1), other);
  equal(ws().selected, other); equal(ws().shown[1], a.id);
  equal(Object.values(ws().shown).filter(k => k === "log").length, 1);
  equal(otherWindowFor("log", other), other);
});

test("other-window targets an existing file, then the next window, then creates a split", () => {
  const a = openFile(), b = openFile("b.ts"); display(a.id, 1);
  const other = otherWindowFor(b.id, 1);
  equal(windowOrder(ws().layout), [1, other]);
  equal(otherWindowFor(b.id, 1), other);
  equal(otherWindowFor("help", 1), other);
});

test("closing a nested window selects the neighbour that takes its space", () => {
  const a = openFile(); display(a.id, 1);
  const right = ws().split(1, "row", a.id);
  const below = ws().split(right, "column", a.id);
  ws().select(right); deleteWindow();
  equal(windowOrder(ws().layout), [1, below]); equal(ws().selected, below);
  equal(ws().shown[right], undefined);
});

test("the last window cannot be closed, and keep-only retains the selected window", () => {
  deleteWindow(); equal(windowOrder(ws().layout), [1]);
  assert(useUIStore.getState().flash?.includes("only window"));
  const other = ws().split(1, "row", "log"); ws().select(other);
  deleteOtherWindows(); equal(windowOrder(ws().layout), [other]); equal(ws().selected, other);
});

test("diff takes the frame and returning to project restores layout, selection, and tree focus", () => {
  const a = openFile(), b = openFile("b.ts"); display(a.id, 1);
  const other = ws().split(1, "row", b.id); ws().select(other); ws().setTreeFocused(true);
  const layout = ws().layout;
  showDiff(); equal(windowOrder(ws().layout), [1]); equal(ws().shown[1], "diff");
  assert(ws().stash);
  showProject(); equal(ws().layout, layout); equal(ws().selected, other);
  equal(ws().shown, { 1: a.id, [other]: b.id }); equal(ws().treeFocused, true); equal(ws().stash, null);
});

test("returning to a file already in the restored layout selects that window", () => {
  const a = openFile(), b = openFile("b.ts"); display(a.id, 1);
  const other = ws().split(1, "row", b.id);
  showDiff(); equal(display(b.id, 1), other);
  equal(ws().shown[1], a.id); equal(ws().shown[other], b.id); equal(ws().selected, other);
});

test("a killed file does not reappear when the project layout is restored", () => {
  const a = openFile(), b = openFile("b.ts"); display(a.id, 1);
  ws().split(1, "row", b.id); showDiff(); killFileBuffers([b.id]); showProject();
  assert(!Object.values(ws().shown).includes(b.id));
  assert(!Object.values(ws().prev).flat().includes(b.id));
  equal(useFilesStore.getState().buffers.map(f => f.id), [a.id]);
});

test("buffer back and forward round-trip and a new switch clears the forward path", () => {
  const a = openFile(), b = openFile("b.ts"); display(a.id, 1); display(b.id, 1);
  stepBuffer("back"); equal(ws().shown[1], a.id);
  stepBuffer("ahead"); equal(ws().shown[1], b.id);
  stepBuffer("back"); showBuffer("help"); equal(ws().ahead[1], []);
});

test("quitting help forgets help instead of cycling back to it", () => {
  const a = openFile(); display(a.id, 1); showBuffer("help"); quitWindow();
  equal(ws().shown[1], a.id); assert(!ws().prev[1].includes("help"));
});

test("log and help take the full frame and preserve the project stash across buffer switches", () => {
  const a = openFile(), b = openFile("b.ts"); display(a.id, 1);
  const other = ws().split(1, "row", b.id); ws().select(other);
  const layout = ws().layout;
  showBuffer("log"); equal(windowOrder(ws().layout), [other]);
  const stash = ws().stash; assert(stash);
  showBuffer("help"); equal(ws().stash, stash); equal(ws().shown[other], "help");
  showDiff(); equal(ws().stash, stash);
  showProject(); equal(ws().layout, layout); equal(ws().shown, { 1: a.id, [other]: b.id });
  equal(ws().selected, other);
});

test("buffer history displays help across the frame and restores the project split", () => {
  const a = openFile(), b = openFile("b.ts"); display(a.id, 1);
  const other = ws().split(1, "row", b.id);
  const layout = ws().layout;
  useWindowStore.setState({ prev: { ...ws().prev, 1: ["help"] } });
  stepBuffer("back"); equal(windowOrder(ws().layout), [1]); equal(ws().shown[1], "help");
  stepBuffer("ahead"); equal(ws().layout, layout); equal(ws().shown, { 1: a.id, [other]: b.id });
});

test("quitting a secondary file closes its window while the main file goes to diff", () => {
  const a = openFile(); display(a.id, 1);
  const other = ws().split(1, "row", a.id); ws().select(other); quitFile();
  equal(windowOrder(ws().layout), [1]); equal(ws().shown[1], a.id);
  quitFile(); equal(ws().shown[1], "diff");
});

test("killing a buffer clears all window histories and saved positions", () => {
  const a = openFile(), b = openFile("b.ts"); display(a.id, 1); display(b.id, 1);
  savePosition(1, b.id, { line: 2, col: 0 }); killFileBuffers([b.id]);
  equal(ws().shown[1], a.id); assert(!ws().recent.includes(b.id));
  assert(!ws().ahead[1].includes(b.id)); equal(positionOf(1, b.id), undefined);
});

test("tree previews never enter buffer history and disappear when another window is selected", () => {
  const a = openFile(), b = openFile("b.ts"); display(a.id, 1);
  const other = ws().split(1, "row", "help"); ws().setTreeFocused(true);
  const recent = ws().recent, prev = ws().prev;
  ws().setPreview({ win: 1, key: b.id, under: a.id });
  equal(onScreen(ws(), 1), b.id); equal(ws().shown[1], a.id);
  equal(ws().recent, recent); equal(ws().prev, prev);
  ws().select(other); equal(ws().preview, null); equal(onScreen(ws(), 1), a.id);
});

test("window cycling includes the tree and restores a hidden tree in a single-window project", () => {
  const a = openFile(); display(a.id, 1); ws().setTreeFocused(true);
  const other = ws().split(1, "row", "help");
  otherWindow(); equal(ws().selected, 1); equal(ws().treeFocused, false);
  otherWindow(); equal(ws().selected, other);
  otherWindow(); equal(ws().treeFocused, true);
  ws().keepOnly(1); ws().setTreeFocused(false); useProjectStore.getState().setTreeHidden(true);
  otherWindow(); equal(ws().treeFocused, true); equal(useProjectStore.getState().treeHidden, false);
  assert(inProjectMode(ws()));
});

test("jump history deduplicates a line but keeps the same path at different revisions", () => {
  const history = useHistoryStore.getState();
  history.record(place(1)); history.record({ ...place(1), col: 4 } as Place);
  equal(useHistoryStore.getState().back.length, 1);
  assert(!samePlace(place(1), { kind: "file", path: "a.ts", choice: { source: { kind: "commit", oid: "b".repeat(40) }, label: null }, line: 1, col: 0 }));
});

test("jump history round-trips and recording a new jump clears forward history", () => {
  const history = useHistoryStore.getState(); history.record(place(1)); history.record(place(2));
  equal(history.stepBack(place(3)), place(2)); equal(history.stepForward(place(2)), place(3));
  history.stepBack(place(3)); history.record(place(4)); equal(useHistoryStore.getState().forward, []);
});

test("jump history skips no-op jumps and bounds retained places", () => {
  const history = useHistoryStore.getState();
  for (let i = 1; i <= 105; i++) history.record(place(i));
  equal(useHistoryStore.getState().back.length, 100);
  equal(useHistoryStore.getState().back[0], place(6));
  equal(history.stepBack(place(105)), place(104));
  history.clear(); equal(history.stepBack(null), null); equal(history.stepForward(null), null);
});

test("jump back reuses the originating file's window and restores its cursor", () => {
  const a = openFile(), b = openFile("b.ts"); display(a.id, 1);
  savePosition(1, a.id, { line: 1, col: 0 });
  useHistoryStore.getState().record({ ...place(2), path: a.path });
  const other = ws().split(1, "row", b.id); ws().select(other);
  savePosition(other, b.id, { line: 3, col: 1 });
  goBack(); equal(ws().selected, 1); equal(ws().shown[other], b.id); equal(positionOf(1, a.id)?.line, 2);
  goForward(); equal(ws().selected, other); equal(positionOf(other, b.id)?.line, 3);
});

void run();
