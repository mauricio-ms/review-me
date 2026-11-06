# File preview proposal

Status: grep, references, ambiguous definitions, and file candidates in the buffer
switcher are implemented. The normal buffer switcher also previews diff/log/help across
the full app area; its other-window variant lists only files. Fuzzy finder previews were
declined and remain excluded. Other surfaces below remain proposals.

Implementation note: picker sessions reuse the file viewer in a separate overlay while
keeping the original view mounted, preserving its exact selection and scroll. Existing
tree previews remain underneath. The first version uses automatic picker previews and
does not add the proposed manual `C-o` gesture. Its backend bounds new preview reads to
2 MiB. See `npm run test:previews` for the interaction regressions.

Add temporary file previews where a reviewer is choosing among locations and needs
surrounding code to decide. Start with grep and cross-reference results, then extend
the same lifecycle to the file finder. Keep the existing project-tree behavior.

Here, a **preview** shows a candidate without opening a persistent buffer or recording
a jump. **Display without selecting** is a separate operation: it can open a normal
buffer while leaving the keyboard in the originating list.

## Baseline before implementation

| Surface | Current behavior | Relevant code |
| --- | --- | --- |
| Project tree | Cursor rests for 60 ms, or a file is clicked: temporary preview in the selected project window. RET, double-click, or entering the viewer adopts it. | [ProjectTree](../src/components/ProjectTree.tsx), [previewFile / openPreview](../src/lib/project.ts) |
| Diff | RET opens the file; `o` opens it in another window; `C-o` opens/displays it there without selecting. Moving through rows does not follow the file automatically. | [DiffBuffer](../src/components/DiffBuffer.tsx) |
| Repository grep | Bottom picker with matching lines. Selection moves within the results; only acceptance reads/visits a file. No preview or persistent results buffer. | [GrepPrompt](../src/components/GrepPrompt.tsx), [grep actions](../src/lib/grep.ts) |
| References and ambiguous definitions | Bottom list with a snippet and confirmed/unconfirmed grouping. Only acceptance visits the location. A single resolved definition jumps directly. | [XrefHost](../src/components/XrefHost.tsx), [xref actions](../src/lib/xref.ts) |
| Fuzzy file finder | Paths, grouped changed/unchanged when appropriate. A file opens only on acceptance, including the other-window variant. | [FuzzyFinderHost](../src/components/FuzzyFinderHost.tsx) |
| Buffer switcher | Names, paths, and revisions; switches only on acceptance. | [Minibuffer](../src/components/Minibuffer.tsx) |
| Swiper | Already follows the selected match within the current file, diff, or log. Cancellation restores the starting place; acceptance records the jump. | [SwiperPrompt](../src/components/SwiperPrompt.tsx), [editor search](../src/editor/swiper.ts), [list search](../src/lib/swiper-list.ts) |
| Commit log | RET enters a commit comparison; `o` enters it in another window. This changes the active comparison and review scope. | [LogBuffer](../src/components/LogBuffer.tsx), [comparison loading](../src/lib/open-repo.ts) |

The tree already supplies the core mechanism: a window overlay separate from `shown`,
and one temporary file outside the persistent buffer list. Adoption preserves its
buffer identity. Existing tests cover history isolation and stale preview reads in
[navigation](../tests/navigation.ts) and [loading](../tests/loading.ts).

One documentation mismatch should be corrected during implementation:
[the diff keymap](../src/lib/keymap.ts) describes `j` as previewing a file, but its
handler only moves the cursor. The tree's equivalent description is accurate.

## Emacs precedents

Emacs offers several distinct behaviors to borrow:

- **Dired:** `C-o` displays the file in another window while retaining focus in Dired;
  `o` visits it in another window. This corresponds closely to our existing diff
  commands. It is a file visit, without temporary-buffer cleanup implied by the key.
  [GNU Emacs: Dired Visiting](https://www.gnu.org/s/emacs/manual/html_node/emacs/Dired-Visiting.html).
- **Xref:** `C-o` shows the selected location. Its `n`/`p` commands also display the
  next/previous result, while ordinary cursor movement can move without displaying.
  [GNU Emacs: Xref Commands](https://www.gnu.org/software/emacs/manual/html_node/emacs/Xref-Commands.html).
- **Grep/Compilation:** Next Error Follow mode makes cursor movement automatically
  display the source location; `C-c C-f` toggles it.
  [GNU Emacs: Compilation Mode](https://www.gnu.org/software/emacs/manual/html_node/emacs/Compilation-Mode.html).
- **Consult, an additional Emacs package:** supports live previews for search, xref,
  and buffer selection, with automatic, delayed, manual, or disabled preview policies.
  It cleans up files opened only for preview after completion and supports partial
  previews of large files. This is the closest precedent for our bottom pickers.
  [Consult manual: Live previews](https://elpa.gnu.org/packages/doc/consult.html#Live-previews).
- **Magit:** its log can show or scroll the selected commit's diff with `SPC` while
  the log remains useful for navigation. Commit inspection is a separate presentation
  from visiting a file.
  [Magit: Log Buffer](https://docs.magit.vc/magit/Logging.html#Log-Buffer).

The recommendation below combines these patterns with review-me's existing temporary
buffer model. It is a product choice, not a claim that every Emacs list previews alike.

## Recommended placements

| Priority | Surface | Proposed behavior | Why it helps |
| --- | --- | --- | --- |
| Keep | Project tree | Retain the current preview and adoption gestures. | Browsing files already works without accumulating buffers. |
| First | Grep results | Automatically preview a selected result after roughly 150 ms, centered on its line, with matching spans highlighted. Only current, ready results can trigger it. | A matching line rarely explains whether a hit is relevant. |
| First | References / ambiguous definitions | Automatically preview after roughly 150 ms at the result's line and UTF-16 column. Preserve confirmed/unconfirmed labels. | Surrounding code helps distinguish callers and ambiguous definitions before jumping. |
| Next | Fuzzy finder | Add `C-o` for an explicit temporary preview. Keep typing/navigation inexpensive; automatic file-finder previews can be evaluated later. | Useful for similar filenames, while avoiding reads for every broad filename query. |
| Later | Buffer switcher | Preview existing file-buffer candidates immediately; initially leave diff/log/help/project candidates as names only. | Quickly recognize a file and its revision without changing buffer order. |
| Later | Diff | Offer an explicit `M-x follow-preview` toggle that follows the current file/line in a neighboring preview window. Keep ordinary row motion unchanged until enabled, and retain the existing `C-o` display command. | Full-file context helps with a small hunk, while an always-open split would take space from the diff. |
| Existing behavior sufficient | Swiper and a single resolved definition | Keep Swiper's in-place following and direct definition jumps. | Each already has a clear navigation model. |
| Defer | Commit log / commit picker | Consider a separate commit-diff preview after file previews work. | Calling `enterCommit` to preview would change comparison, tags, tree revision, file buffers, and navigation history. |
| Omit | Commands, repository pickers, branch selectors, confirmations, note/commit editors | Keep their current presentation. | A file preview does not help make these decisions; branch/commit inspection would require a different preview type. |

Ambiguous test/code counterpart choices can later use the file-picker policy when
they carry a typed file target. Generic choice prompts should not assume every choice
is a filename.

## Interaction contract

Use the normal file viewer above the bottom picker. Show the preview in the destination
window that acceptance would use, selected once for that session. For a normal picker
this temporarily covers that window's buffer; the picker retains the keyboard. For an
other-window picker, reuse the appropriate neighbor or create a temporary split.
Cancellation removes a split created only for preview. Do not add a second miniature
code pane inside the candidate list.

1. Opening a picker captures the originating place, destination, and state needed for
   restoration. Candidate changes update one preview slot. Keep the picker height stable.
2. Previewing does not change persistent buffers, recent order, window back/forward
   history, jump history, active comparison, project source, tree cursor, or tree filter.
   For an already-open file, temporary cursor/scroll changes must also be reversible.
3. RET or a result click accepts through that surface's existing navigation path. Adopt
   a matching loaded preview where possible, preserving its identity and viewport, and
   record exactly one jump from the captured origin. Other-window acceptance keeps the
   destination window; grep acceptance still reveals the path and adjusts the tree filter.
   Transfer ownership before closing the picker so its cleanup cannot discard an
   accepted preview or restore the previous layout over the completed navigation.
4. `C-g`/Escape cancels and restores the original buffer, cursor, scroll, layout, and
   focus. Replacing the picker or changing repository/comparison ends its session too;
   invalidation must not restore an obsolete repository or layout.
5. Picker previews remain owned by the picker. Clicking their content does not implicitly
   accept or adopt it in the first version. The existing tree gesture, where entering
   the viewer opens the preview, remains specific to tree browsing.
6. Add `C-o` as “preview this candidate now” in supported picker/result scopes; automatic
   grep/xref previews can use it to bypass the delay. Leave viewer/Vim bindings alone.
   Show the policy and available gestures in the picker hint and preview header.

For example: search for a method, move through its callers while their surrounding code
appears above the picker, then press RET to visit one. Pressing `C-g` instead returns to
the exact code or diff position from before the search.

## Implementation boundaries

Generalize the current preview lifecycle into a session owned by the tree or a specific
picker instance. Reuse `FileView`, the temporary file buffer, and the window overlay.
The existing `previewFile` cannot simply be called from picker selection: it requires
tree focus, and the window-store cleanup only permits previews in project mode.

The controller should accept a target containing repository, resolved `SourceChoice`,
path, line/column, and optional highlight ranges. Protect every read, including errors,
with the owner/session identity and a request generation. Freeze the finder's source
when it opens; previewing a deletion must not retarget its next query. Grep uses the
comparison's target revision; xref uses its originating file's revision; changed-file
finder deletions use the old side. Repeated matches in one file should reuse its text.

Add opt-in selection/preview callbacks to `NeoPicker`; wire grep and xref through their
own selection state. Hosts resolve candidate targets; the shared controller handles
reading, display, acceptance handoff, and cleanup. Suspend an existing tree preview
while a picker owns the slot and restore it on cancellation when still valid.

Focus requires explicit work: `FileView` currently focuses a selected window, `Window`
adopts previews on focus, and pickers use a modal focus trap. Suppress focus/adoption
while a picker owns the preview, and use owner-specific header hints. Capture xref's
jump origin when the picker opens, since its current acceptance logic assumes no preview
has moved the view.

Before broadening automatic file reads, add a bounded preview read result. The current
`read_file` reads an entire file, and `readText` presents errors as comment text. A preview
should show a distinct loading/unavailable state for binary, invalid text, missing, or
oversized files. A 2 MiB limit would match grep's existing file bound. Preserve the
repository boundary and revision rules. Explicit acceptance can use the normal file
opening path when preview content is unavailable.

## Delivery and verification

Implement the shared lifecycle with grep first, then xref, then the manual file-finder
gesture. Buffer-switcher previews and optional diff following are separate follow-ups.
Commit inspection should have its own design for state isolation.

Extend existing browser tests to verify preview content and location, retained picker
focus, cancellation restoration, adoption without rereading, and one accepted jump.
Include already-open candidates, repeated locations in one file, other-window splits,
starting from diff/log/tree, and a picker opened over a tree preview. Exercise out-of-order
successes and failures, dismissal, query/scope changes, repository/revision changes, and
failed reads. Old grep candidates retained while updating must never start a new preview;
clear their preview until the current query is ready.

[Grep tests](../tests/grep.tsx) explicitly assert that candidate movement causes no file
reads or previews today. Update that contract deliberately while retaining the assertions
that unaccepted candidates do not create persistent buffers or jumps. Add backend tests
for the bounded reader and its worktree/commit, boundary, encoding, and size cases.

For implementation, run `npm run test:frontend`, `npm run build`, and
`(cd src-tauri && cargo test --locked)` as required by repository guidance. This
documentation-only proposal needs a document/link and diff check, with no runtime tests.
