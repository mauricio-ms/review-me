import { assert, beforeEach, equal, run, test } from "./support";
import { file, hunk, line, resetState, tag } from "./fixtures";
import {
  fileReviewState, fileTarget, firstToReview, hunkTarget, isFileReviewed, isHunkFlagged,
  isHunkReviewed, isLineFlagged, isLineReviewed, reviewProgress, sectionForFile, sectionForHunk,
} from "../src/lib/coverage";

beforeEach(resetState);

test("a modified hunk requires its complete new-side span, including context", () => {
  equal(hunkTarget(hunk()), { side: "new", lo: 1, hi: 3 });
  assert(!isHunkReviewed([tag({ startLine: 2, endLine: 2 })], "a.ts", hunk()));
  assert(isHunkReviewed([tag()], "a.ts", hunk()));
  assert(!isHunkReviewed([tag({ side: "old" })], "a.ts", hunk()));
});

test("pure deletion reviews use removed old lines rather than surviving context", () => {
  const deleted = hunk({ lines: [line("context", 1, 1), line("removed", 2, null), line("removed", 3, null)] });
  equal(hunkTarget(deleted), { side: "old", lo: 2, hi: 3 });
  assert(isHunkReviewed([tag({ side: "old", startLine: 2 })], "a.ts", deleted));
  assert(!isHunkReviewed([tag()], "a.ts", deleted));
});

test("empty hunks have no line target and hunkless files use a file target", () => {
  equal(hunkTarget(hunk({ lines: [] })), null);
  equal(fileTarget(file({ hunks: [] })), { side: "file", lo: 0, hi: 0 });
  equal(isFileReviewed([], file({ hunks: [] })), false);
});

test("rename-only files can be reviewed, flagged, ignored and counted without text hunks", () => {
  const renamed = file({ path: "new.ts", oldPath: "old.ts", status: "renamed", hunks: [], addedLines: 0, removedLines: 0 });
  const mark = tag({ file: "new.ts", side: "file", kind: "file", startLine: 0, endLine: 0 });
  equal(fileTarget(renamed), { side: "file", lo: 0, hi: 0 });
  equal(firstToReview([], [], [], renamed), "file");
  equal(reviewProgress([renamed], []), { done: 0, total: 1 });
  assert(isFileReviewed([mark], renamed));
  equal(reviewProgress([renamed], [mark]), { done: 1, total: 1 });
  equal(fileReviewState([mark], [], [], renamed), "done");
  equal(fileReviewState([], [], [mark], renamed), "done");
  equal(fileReviewState([mark], [mark], [], renamed), "flagged");
  equal(firstToReview([mark], [], [], renamed), null);
  assert(!isFileReviewed([tag()], renamed));
  assert(!isFileReviewed([{ ...mark, anchor: { ...mark.anchor, stale: true } }], renamed));
});

test("whole-file targets distinguish binaries, edits, and deleted text", () => {
  equal(fileTarget(file({ binary: true, hunks: [] })), { side: "file", lo: 0, hi: 0 });
  equal(fileTarget(file()), { side: "new", lo: 1, hi: 3 });
  equal(fileTarget(file({ status: "deleted", hunks: [hunk({ lines: [line("removed", 7, null)] })] })), { side: "old", lo: 7, hi: 7 });
});

test("stale marks and marks on another path never claim a hunk", () => {
  for (const mark of [tag({ stale: true }), tag({ file: "other.ts" })]) {
    equal(sectionForHunk([mark], [mark], [mark], "a.ts", hunk()), "toReview");
  }
});

test("legacy marks without a side count as new-side marks", () => {
  const legacy = tag();
  Reflect.deleteProperty(legacy.anchor, "side");
  assert(isLineReviewed([legacy], "a.ts", 2, "new"));
  assert(!isLineReviewed([legacy], "a.ts", 2, "old"));
});

test("flags need only overlap a hunk while reviewed marks must cover it", () => {
  const partial = tag({ startLine: 3, endLine: 5 });
  assert(isHunkFlagged([partial], "a.ts", hunk()));
  assert(!isHunkReviewed([partial], "a.ts", hunk()));
  assert(!isHunkFlagged([tag({ startLine: 4, endLine: 5 })], "a.ts", hunk()));
});

test("hunk section precedence is flagged, ignored, reviewed, then to-review", () => {
  equal(sectionForHunk([tag()], [tag()], [tag()], "a.ts", hunk()), "flagged");
  equal(sectionForHunk([tag()], [], [tag()], "a.ts", hunk()), "ignored");
  equal(sectionForHunk([tag()], [], [], "a.ts", hunk()), "reviewed");
  equal(sectionForHunk([], [], [], "a.ts", hunk()), "toReview");
});

test("a whole-file note flags every hunk without flagging individual lines", () => {
  const note = tag({ side: "file", kind: "file", startLine: 0, endLine: 0 });
  assert(isHunkFlagged([note], "a.ts", hunk()));
  assert(!isLineFlagged([note], "a.ts", 2, "new"));
  equal(firstToReview([], [note], [], file()), null);
});

test("commit notes do not flag file hunks", () => {
  const note = tag({ file: "", side: "commit", kind: "commit" });
  equal(sectionForHunk([], [note], [], "a.ts", hunk()), "toReview");
});

test("binary review requires a file mark and uses the same section precedence", () => {
  const binary = file({ binary: true, hunks: [] });
  const mark = tag({ side: "file", kind: "file", startLine: 0, endLine: 0 });
  assert(!isFileReviewed([tag()], binary));
  assert(isFileReviewed([mark], binary));
  equal(sectionForFile([mark], [mark], [mark], "a.ts"), "flagged");
  equal(sectionForFile([mark], [], [mark], "a.ts"), "ignored");
  equal(sectionForFile([mark], [], [], "a.ts"), "reviewed");
  equal(firstToReview([], [], [], binary), "file");
});

test("a flag takes only its own hunk out of the remaining review", () => {
  const second = hunk({ id: "h2", lines: [line("added", null, 8)] });
  const changed = file({ hunks: [hunk(), second] });
  equal(firstToReview([], [tag()], [], changed), second);
  equal(fileReviewState([], [tag()], [], changed), "flagged");
});

test("reviewed and ignored units together finish a file", () => {
  const second = hunk({ id: "h2", lines: [line("added", null, 8)] });
  const changed = file({ hunks: [hunk(), second] });
  equal(fileReviewState([tag()], [], [], changed), "open");
  equal(fileReviewState([tag()], [], [tag({ startLine: 8, endLine: 8 })], changed), "done");
  equal(firstToReview([tag()], [], [tag({ startLine: 8, endLine: 8 })], changed), null);
});

test("progress counts text hunks and binary files, excluding empty hunks", () => {
  const binary = file({ path: "image.png", binary: true, hunks: [] });
  const files = [file({ hunks: [hunk(), hunk({ id: "empty", lines: [] })] }), binary];
  equal(reviewProgress(files, [tag({ startLine: 2, endLine: 2 })]), { done: 0, total: 2 });
  equal(reviewProgress(files, [tag()]), { done: 1, total: 2 });
  equal(reviewProgress(files, [tag(), tag({ file: "image.png", side: "file" })]), { done: 2, total: 2 });
  equal(reviewProgress([], []), { done: 0, total: 0 });
});

test("a file needs every reviewable hunk covered, but empty hunks do not block it", () => {
  assert(isFileReviewed([tag()], file({ hunks: [hunk(), hunk({ id: "empty", lines: [] })] })));
  assert(!isFileReviewed([tag()], file({ hunks: [hunk(), hunk({ id: "next", lines: [line("added", null, 9)] })] })));
});

void run();
