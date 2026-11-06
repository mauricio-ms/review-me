import { afterEach, assert, beforeEach, calls, deferred, equal, mock, rejects, run, test, waitFor } from "./support";
import { commit, commitSpec, file, hunk, line, OID, openFile, PARENT, repoFixture, resetState, summary, tag, tags } from "./fixtures";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import DiffBuffer from "../src/components/DiffBuffer";
import Minibuffer from "../src/components/Minibuffer";
import NoteEditorHost from "../src/components/NoteEditorHost";
import { flagFile, ignoreFile, projectFileNoteTarget, reviewFile } from "../src/lib/project-review";
import { addFlag, ignoreGeneratedFiles, reviewWholeFile, saveNote, unmarkWholeFile } from "../src/lib/review-actions";
import { useMinibufferStore } from "../src/state/minibuffer";
import { useNotesStore } from "../src/state/notes";
import { useRepoStore } from "../src/state/repo";
import { useTagsStore } from "../src/state/tags";
import { useUIStore } from "../src/state/ui";
import { useWindowStore } from "../src/state/windows";
import type { AnchorKind, AnchorSide, ReviewScope, TagStore } from "../src/types/tags";

let root: Root | null = null;
let parent: HTMLDivElement | null = null;
let saved: TagStore;
beforeEach(() => {
  resetState(); repoFixture(); saved = tags();
  const makeTag = (args: Record<string, unknown>) => tag({
    file: args.file as string, startLine: args.startLine as number, endLine: args.endLine as number,
    side: args.side as AnchorSide, kind: args.kind as AnchorKind, scope: args.scope as ReviewScope,
  }, { id: `tag-${calls.length}`, note: (args.note as string | null) ?? null, severity: (args.severity as string | null) ?? null });
  mock("add_reviewed_tag", args => { saved.reviewed.push(makeTag(args)); return structuredClone(saved); });
  mock("add_ignored_tag", args => { saved.ignored.push(makeTag(args)); return structuredClone(saved); });
  mock("add_flag_tag", args => { saved.flags.push(makeTag(args)); return structuredClone(saved); });
  mock("unmark_range", () => { saved = tags(); return saved; });
  mock("set_flag_note", ({ id, note }) => {
    saved = { ...saved, flags: saved.flags.map(f => f.id === id ? { ...f, note: note as string | null } : f) };
    return structuredClone(saved);
  });
});
afterEach(async () => {
  root?.unmount(); root = null; parent?.remove(); parent = null;
  resetState();
  await new Promise(resolve => setTimeout(resolve, 0));
});

async function mount() {
  useRepoStore.getState().setExpanded(new Set(["a.ts"]));
  parent = document.body.appendChild(document.createElement("div")); parent.className = "fixture";
  root = createRoot(parent); root.render(<><DiffBuffer /><Minibuffer /><NoteEditorHost /></>);
  await waitFor(() => document.querySelector(".diff-buffer"));
  document.querySelector<HTMLElement>(".diff-buffer")!.focus();
}
function key(key: string, extra: KeyboardEventInit = {}) {
  assert(document.activeElement instanceof HTMLElement, "No keyboard target");
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
}
async function click(selector: string, index = 0) {
  const element = document.querySelectorAll<HTMLElement>(selector)[index]; assert(element, `Missing ${selector}`);
  element.click(); await new Promise(resolve => setTimeout(resolve, 0));
}
const edit = (flagId: string | null = null, saved = "") => ({
  flagId, saved, target: { file: "a.ts", lo: 2, hi: 2, kind: "range" as const, side: "new" as const },
});

test("reviewing a file through its diff key marks its complete hunk and updates the section", async () => {
  await mount(); await click(".diff-file-row"); key("r");
  await waitFor(() => useTagsStore.getState().reviewed.length === 1);
  equal(calls.find(c => c.command === "add_reviewed_tag")?.args, {
    repo: "/fixture", scope: { kind: "worktree" }, file: "a.ts", startLine: 1, endLine: 3, kind: "hunk", side: "new",
  });
  await waitFor(() => document.querySelector(".diff-section-header.section-reviewed"), "Reviewed section missing");
});

test("rename-only rows display both paths and can be reviewed with r", async () => {
  const renamed = file({ oldPath: "old.ts", status: "renamed", hunks: [], addedLines: 0, removedLines: 0 });
  repoFixture(undefined, summary(undefined, [renamed]));
  await mount(); await click(".diff-file-row");
  equal(document.querySelector(".diff-file-path")?.textContent, "old.ts → a.ts");
  equal(document.querySelector(".diff-status-glyph")?.textContent, "R");
  key("r");
  await waitFor(() => useTagsStore.getState().reviewed.length === 1);
  equal(calls.find(c => c.command === "add_reviewed_tag")?.args, {
    repo: "/fixture", scope: { kind: "worktree" }, file: "a.ts", startLine: 0, endLine: 0, kind: "file", side: "file",
  });
  await waitFor(() => document.querySelector(".section-reviewed .diff-section-count")?.textContent === "1");
  assert(document.querySelector(".diff-file-row .mark-reviewed"));
});

test("rename-only files support review, flag and ignore from project mode", async () => {
  repoFixture(undefined, summary(undefined, [file({ oldPath: "old.ts", status: "renamed", hunks: [] })]));
  await reviewFile("a.ts");
  await flagFile("a.ts");
  await ignoreFile("a.ts");
  equal(calls.filter(c => c.command.startsWith("add_")).map(c => [c.command, c.args.side, c.args.startLine, c.args.endLine]), [
    ["add_reviewed_tag", "file", 0, 0], ["add_flag_tag", "file", 0, 0], ["add_ignored_tag", "file", 0, 0],
  ]);
});

test("flag and ignore keys update the selected hunk's classification", async () => {
  await mount(); await click(".diff-hunk-row"); key("i");
  await waitFor(() => useTagsStore.getState().ignored.length === 1);
  await click(".diff-hunk-row"); key("f");
  await waitFor(() => useTagsStore.getState().flags.length === 1);
  await waitFor(() => document.querySelector(".diff-section-header.section-flagged"), "Flagged section missing");
  equal(calls.filter(c => c.command.startsWith("add_")).map(c => c.command), ["add_ignored_tag", "add_flag_tag"]);
});

test("unmark cancellation preserves a note and returns keyboard focus to the diff", async () => {
  saved = tags({ flags: [tag({}, { note: "Keep this concern" })] }); useTagsStore.getState().setStore(saved);
  await mount(); await click(".diff-file-row"); key("u");
  await waitFor(() => document.activeElement?.id === "minibuffer-input", "Confirmation did not receive focus");
  equal(useUIStore.getState().modalDepth, 1); key("Escape");
  await waitFor(() => useMinibufferStore.getState().request === null);
  await waitFor(() => document.activeElement?.classList.contains("diff-buffer"), "Diff did not regain focus");
  equal(saved.flags[0].note, "Keep this concern"); assert(!calls.some(c => c.command === "unmark_range"));
  equal(useUIStore.getState().modalDepth, 0);
});

test("unmark confirmation requires y, then removes the note and marks", async () => {
  saved = tags({ flags: [tag({}, { note: "Concern" })], reviewed: [tag()] }); useTagsStore.getState().setStore(saved);
  await mount(); await click(".diff-file-row"); key("u");
  await waitFor(() => document.activeElement?.id === "minibuffer-input");
  key("Enter"); assert(useMinibufferStore.getState().request, "Enter accepted a destructive prompt");
  key("y"); await waitFor(() => calls.some(c => c.command === "unmark_range"));
  await waitFor(() => useTagsStore.getState().flags.length === 0);
  equal(saved.reviewed, []); equal(saved.flags, []);
});

test("whole-file review sends deletion and modification hunks to their own sides", async () => {
  const mixed = file({ hunks: [hunk(), hunk({ id: "delete", lines: [line("removed", 8, null)] })] });
  await reviewWholeFile(mixed);
  equal(calls.filter(c => c.command === "add_reviewed_tag").map(c => [c.args.side, c.args.startLine, c.args.endLine]), [["new", 1, 3], ["old", 8, 8]]);
});

test("binary reviews use a file anchor and committed reviews use the commit scope", async () => {
  repoFixture(commitSpec(), summary(commit()));
  await reviewWholeFile(file({ binary: true, hunks: [] }));
  equal(calls[0].args, { repo: "/fixture", scope: { kind: "commit", oid: OID }, file: "a.ts", startLine: 0, endLine: 0, kind: "file", side: "file" });
});

test("a failed write preserves the existing review state", async () => {
  const before = tags({ flags: [tag()] }); useTagsStore.getState().setStore(before);
  mock("add_reviewed_tag", () => { throw new Error("Disk full"); });
  await rejects(() => reviewWholeFile(file()), "Disk full");
  equal(useTagsStore.getState().flags, before.flags); equal(useTagsStore.getState().reviewed, []);
});

test("reflagging exact lines preserves the existing note and severity", async () => {
  useTagsStore.getState().setStore(tags({ flags: [tag({}, { note: "Explain this", severity: "high" })] }));
  await addFlag("a.ts", 1, 3, "hunk", "new");
  equal(calls[0].args.note, "Explain this"); equal(calls[0].args.severity, "high");
});

test("ignore-generated skips ordinary, flagged and already completed files", async () => {
  const files = [file({ path: "open", generated: true }), file({ path: "flagged", generated: true }),
    file({ path: "done", generated: true }), file({ path: "ordinary" })];
  repoFixture(undefined, summary(undefined, files));
  saved = tags({ flags: [tag({ file: "flagged" })], reviewed: [tag({ file: "done" })] }); useTagsStore.getState().setStore(saved);
  equal(await ignoreGeneratedFiles(), 1);
  equal(calls.filter(c => c.command === "add_ignored_tag").map(c => c.args.file), ["open"]);
  equal(useTagsStore.getState().flags[0].anchor.file, "flagged");
});

test("unmarking a whole file removes all marked sides after one confirmation", async () => {
  saved = tags({ reviewed: [tag()], flags: [tag({ side: "old", startLine: 5, endLine: 6 }, { note: "Old-side note" })],
    ignored: [tag({ side: "file", startLine: 0, endLine: 0 })] }); useTagsStore.getState().setStore(saved);
  const request = unmarkWholeFile("a.ts");
  const prompt = useMinibufferStore.getState().request; assert(prompt?.kind === "confirm"); prompt.onAnswer(true);
  equal(await request, "unmarked");
  equal(calls.filter(c => c.command === "unmark_range").map(c => [c.args.side, c.args.startLine, c.args.endLine]), [["new", 1, 3], ["old", 5, 6], ["file", 0, 0]]);
});

test("empty notes create nothing and clearing an existing note preserves its flag", async () => {
  equal(await saveNote(edit(), " \n "), null); equal(calls, []);
  saved = tags({ flags: [tag({}, { id: "existing", note: "Before" })] }); useTagsStore.getState().setStore(saved);
  equal(await saveNote(edit("existing"), "  "), "existing");
  equal(saved.flags.length, 1); equal(saved.flags[0].note, null);
});

test("a first note creates a flag and trims only trailing whitespace", async () => {
  const id = await saveNote(edit(), "  Keep indentation\n\n");
  assert(id); equal(saved.flags[0].id, id); equal(saved.flags[0].note, "  Keep indentation");
  equal(saved.flags[0].anchor.startLine, 2); equal(saved.flags[0].anchor.endLine, 2);
});

test("note editor saves an edited note through Ctrl-c Ctrl-c", async () => {
  repoFixture(commitSpec(), summary(commit()));
  saved = tags({ flags: [tag({ scope: { kind: "commit", oid: OID } }, { id: "existing", note: "Before" })] }); useTagsStore.getState().setStore(saved);
  await mount(); useNotesStore.getState().open(edit("existing", "Before"));
  await waitFor(() => document.querySelector(".note-editor .cm-editor"));
  const dom = document.querySelector<HTMLElement>(".note-editor .cm-editor")!;
  const view = EditorView.findFromDOM(dom); assert(view);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "After\n" } });
  await waitFor(() => document.querySelector(".note-dirty"));
  view.contentDOM.focus(); key("c", { ctrlKey: true }); key("c", { ctrlKey: true });
  await waitFor(() => useNotesStore.getState().editing === null);
  equal(saved.flags[0].note, "After"); equal(calls.find(c => c.command === "set_flag_note")?.args.scope, { kind: "commit", oid: OID });
});

test("discarding an edited note leaves its saved text intact and closes the modal", async () => {
  repoFixture(commitSpec(), summary(commit()));
  saved = tags({ flags: [tag({}, { id: "existing", note: "Before" })] }); useTagsStore.getState().setStore(saved);
  await mount(); useNotesStore.getState().open(edit("existing", "Before"));
  await waitFor(() => document.querySelector(".note-editor .cm-editor"));
  const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".note-editor .cm-editor")!); assert(view);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "Unsaved" } });
  await waitFor(() => document.querySelector(".note-dirty"));
  view.contentDOM.focus(); key("c", { ctrlKey: true }); key("k", { ctrlKey: true });
  await waitFor(() => useNotesStore.getState().editing === null);
  equal(saved.flags[0].note, "Before"); assert(!calls.some(c => c.command === "set_flag_note"));
  equal(useUIStore.getState().modalDepth, 0);
});

test("note editor reports write failures and retains the unsaved edit for retry", async () => {
  repoFixture(commitSpec(), summary(commit()));
  mock("add_flag_tag", () => { throw new Error("Disk full"); });
  await mount(); useNotesStore.getState().open(edit());
  await waitFor(() => document.querySelector(".note-editor .cm-editor"));
  const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".note-editor .cm-editor")!); assert(view);
  view.dispatch({ changes: { from: 0, insert: "Keep this edit" } });
  await waitFor(() => document.querySelector(".note-dirty"));
  view.contentDOM.focus(); key("c", { ctrlKey: true }); key("c", { ctrlKey: true });
  await waitFor(() => document.querySelector(".note-editor .neo-footer")?.textContent?.includes("Disk full"));
  assert(useNotesStore.getState().editing); equal(view.state.doc.toString(), "Keep this edit"); equal(saved.flags, []);
});

test("file notes reject a revision outside the comparison and accept a deleted file's old side", () => {
  repoFixture(commitSpec(), summary(commit(), [file({ status: "deleted" })]));
  const other = openFile("a.ts", { kind: "commit", oid: "c".repeat(40) }); useWindowStore.getState().show(1, other.id);
  equal(projectFileNoteTarget(), null); assert(useUIStore.getState().flash?.includes("revision under review"));
  const old = openFile("a.ts", { kind: "commit", oid: PARENT }); useWindowStore.getState().show(1, old.id);
  equal(projectFileNoteTarget(), { file: "a.ts", lo: 0, hi: 0, kind: "file", side: "file" });
});

test("a completed write from a previous comparison cannot replace the current tags", async () => {
  const pending = deferred<TagStore>(); mock("add_reviewed_tag", () => pending.promise);
  const request = reviewWholeFile(file());
  repoFixture(commitSpec(), summary(commit())); const current = tags({ flags: [tag({}, { id: "current" })] }); useTagsStore.getState().setStore(current);
  pending.resolve(tags({ reviewed: [tag()] })); await request;
  equal(useTagsStore.getState().flags.map(f => f.id), ["current"]); equal(useTagsStore.getState().reviewed, []);
});

test("confirming an old unmark prompt after a comparison change cannot delete new marks", async () => {
  useTagsStore.getState().setStore(tags({ flags: [tag({}, { note: "Old concern" })] }));
  const request = unmarkWholeFile("a.ts"); const prompt = useMinibufferStore.getState().request; assert(prompt?.kind === "confirm");
  repoFixture(commitSpec(), summary(commit())); prompt.onAnswer(true); await request;
  assert(!calls.some(c => c.command === "unmark_range"), "Old prompt deleted marks in the new comparison");
});

test("whole-file batches stop sending writes after their comparison changes", async () => {
  const pending = deferred<TagStore>(); mock("add_reviewed_tag", () => pending.promise);
  const request = reviewWholeFile(file({ hunks: [hunk(), hunk({ id: "next", lines: [line("added", null, 8)] })] }));
  repoFixture(commitSpec(), summary(commit()));
  pending.resolve(tags({ reviewed: [tag()] })); await request;
  equal(calls.filter(c => c.command === "add_reviewed_tag").length, 1);
  equal(useTagsStore.getState().reviewed, []);
});

void run();
