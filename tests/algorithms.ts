import { assert, equal, run, test } from "./support";
import { branches, commit, file, hunk, line, OID, PARENT, summary } from "./fixtures";
import { buildChanged, changedFileOrder } from "../src/lib/changed-tree";
import { blockStart, changeAtLine, changeBlocks, changeForFile, deletionForFile } from "../src/lib/project-diff";
import { ambientSource, baseSource } from "../src/lib/project";
import { sideRead } from "../src/lib/project-review";
import { wordDiff } from "../src/lib/word-diff";

test("word diffs preserve both inputs for empty, whitespace, punctuation and Unicode edits", () => {
  for (const [old, next] of [["", ""], ["", "hello"], ["gone", ""], ["same", "same"],
    ["const x = 1;", "const x = 2;"], ["a  b", "a\tb"], ["olá 世界 👋", "olá 世界 🚀"]]) {
    const result = wordDiff(old, next);
    equal(result.removed.map(s => s.text).join(""), old);
    equal(result.added.map(s => s.text).join(""), next);
    equal(result.removed.filter(s => !s.changed).map(s => s.text).join(""), result.added.filter(s => !s.changed).map(s => s.text).join(""));
  }
});

test("word diffs highlight only replaced tokens and leave equal lines unmarked", () => {
  equal(wordDiff("a = 1;", "a = 2;"), {
    removed: [{ text: "a = ", changed: false }, { text: "1", changed: true }, { text: ";", changed: false }],
    added: [{ text: "a = ", changed: false }, { text: "2", changed: true }, { text: ";", changed: false }],
  });
  equal(wordDiff("same", "same"), { removed: [{ text: "same", changed: false }], added: [{ text: "same", changed: false }] });
});

test("very long token sequences fall back to whole-line highlights", () => {
  const old = "x ".repeat(500), next = "y ".repeat(500);
  equal(wordDiff(old, next), { removed: [{ text: old, changed: true }], added: [{ text: next, changed: true }] });
});

test("change blocks pair replacements and preserve extra additions", () => {
  const blocks = changeBlocks(file({ hunks: [hunk({ lines: [line("removed", 1, null, "old"), line("added", null, 1, "new"), line("added", null, 2, "extra")] })] }));
  equal(blocks.length, 1); equal(blocks[0].modified, [1]); equal(blocks[0].added, [2]);
  equal(blocks[0].removedAt, 1); equal(blocks[0].trailingRemoval, false);
  equal(blockStart(blocks[0]), 1); equal(changeAtLine(blocks, 2), 0); equal(changeAtLine(blocks, 3), -1);
});

test("extra removed lines remain reachable beside the replacement", () => {
  const blocks = changeBlocks(file({ hunks: [hunk({ lines: [line("removed", 1, null), line("removed", 2, null), line("added", null, 1)] })] }));
  equal(blocks[0].trailingRemoval, true);
  equal(changeAtLine(blocks, 2), 0);
});

test("pure deletions at the beginning and end remain reachable from adjacent lines", () => {
  for (const start of [0, 8]) {
    const blocks = changeBlocks(file({ hunks: [hunk({ newStart: start, newLines: 0, lines: [line("removed", start + 1, null)] })] }));
    equal(blocks[0].removedAt, start + 1);
    equal(blockStart(blocks[0]), start + 1);
    equal(changeAtLine(blocks, start), 0);
    equal(changeAtLine(blocks, start + 1), 0);
    equal(changeAtLine(blocks, start + 2), -1);
  }
});

test("context separates distinct change blocks in source order", () => {
  const blocks = changeBlocks(file({ hunks: [hunk({ lines: [line("added", null, 1), line("context", 1, 2), line("added", null, 3)] })] }));
  equal(blocks.map(blockStart), [1, 3]);
  assert(blocks[0].id !== blocks[1].id);
});

test("changed-file trees compact folder chains and expand by their deepest path", () => {
  const files = [file({ path: "src/java/com/App.java" }), file({ path: "README.md" })];
  equal(buildChanged(files, () => false).map(n => [n.entry.name, n.entry.path, n.depth]), [
    ["src/java/com", "src/java/com", 0], ["README.md", "README.md", 0],
  ]);
  equal(buildChanged(files, path => path === "src/java/com").map(n => n.entry.path), ["src/java/com", "src/java/com/App.java", "README.md"]);
});

test("changed-file navigation follows folder-first, case-insensitive tree order", () => {
  const files = ["z.ts", "B.ts", "a.ts", "src/Z.ts", "src/a.ts", "lib/a.ts"].map(path => file({ path }));
  equal(changedFileOrder(files).map(f => f.path), ["lib/a.ts", "src/a.ts", "src/Z.ts", "a.ts", "B.ts", "z.ts"]);
  equal(files[0].path, "z.ts");
  equal(buildChanged([], () => true), []);
});

test("revision selection uses target, merge base, first parent, and HEAD as appropriate", () => {
  equal(ambientSource(branches()).source, { kind: "commit", oid: OID });
  equal(baseSource(branches()).source, { kind: "commit", oid: PARENT });
  equal(baseSource(commit()).source, { kind: "commit", oid: PARENT });
  equal(baseSource(summary().comparison).source, { kind: "commit", oid: PARENT });
  equal(baseSource(commit({ parentOid: null })).source, { kind: "commit", oid: OID });
  equal(sideRead(commit({ parentOid: null }), { kind: "commit", oid: OID }), "new");
  equal(sideRead(commit(), { kind: "commit", oid: "c".repeat(40) }), null);
});

test("change marks only describe the matching revision and deletions only the old side", () => {
  const changed = file(), deleted = file({ path: "gone.ts", status: "deleted" });
  const diff = summary(commit(), [changed, deleted, file({ path: "binary", binary: true })]);
  equal(changeForFile(diff, { kind: "commit", oid: OID }, "a.ts"), changed);
  equal(changeForFile(diff, { kind: "worktree" }, "a.ts"), null);
  equal(changeForFile(diff, { kind: "commit", oid: OID }, "gone.ts"), null);
  equal(changeForFile(diff, { kind: "commit", oid: OID }, "binary"), null);
  equal(deletionForFile(diff, { kind: "commit", oid: PARENT }, "gone.ts"), deleted);
  equal(deletionForFile(diff, { kind: "commit", oid: OID }, "gone.ts"), null);
});

void run();
