import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";

import { useProjectStore } from "../state/project";
import { useRepoStore } from "../state/repo";
import { useUIStore } from "../state/ui";
import { inProjectMode, useWindowStore } from "../state/windows";
import { currentFile } from "./buffers";
import { recordJump } from "./jumps";
import { revealInTree, visitFile } from "./project";
import { activeView } from "./project-view";
import { listRepoDir, readFile } from "./tauri";
import { focusTree, showProject } from "./windows";

/** A Markdown file: the viewer renders it (`editor/markdown-view.ts`). */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mkd)$/i.test(path);
}

/** A link label as CommonMark matches one: case and runs of whitespace don't count. */
function labelKey(label: string): string {
  return label.replace(/^\[|\]$/g, "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** A link destination as written, without the `<…>` that lets it hold spaces. */
function destination(text: string): string {
  return text.startsWith("<") && text.endsWith(">") ? text.slice(1, -1) : text;
}

// Leaf blocks hold no definitions: the scan for them needn't read their inline content.
const NO_DEFINITIONS = new Set([
  "Paragraph",
  "FencedCode",
  "CodeBlock",
  "Table",
  "HTMLBlock",
  "CommentBlock",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
]);

const definitionsByTree = new WeakMap<Tree, Map<string, string>>();

/** The document's link reference definitions (`[label]: url`): label → url. */
function definitions(state: EditorState): Map<string, string> {
  const tree = syntaxTree(state);
  let defs = definitionsByTree.get(tree);
  if (defs) return defs;
  const found = new Map<string, string>();
  tree.iterate({
    enter: (ref) => {
      if (NO_DEFINITIONS.has(ref.name)) return false;
      if (ref.name !== "LinkReference") return;
      const label = ref.node.getChild("LinkLabel");
      const url = ref.node.getChild("URL");
      if (label && url) {
        // The first definition of a label is the one that counts.
        const key = labelKey(state.sliceDoc(label.from, label.to));
        if (!found.has(key)) found.set(key, destination(state.sliceDoc(url.from, url.to)));
      }
      return false;
    },
  });
  defs = found;
  definitionsByTree.set(tree, defs);
  return defs;
}

/**
 * Where a link node points, as written — null when it isn't one. A reference link
 * (`[text][ref]`, `[ref]`) is a link only when its label is defined: otherwise it is
 * just text in brackets, `[WIP]`.
 */
export function linkHref(state: EditorState, node: SyntaxNode): string | null {
  switch (node.name) {
    case "Link":
    case "Image": {
      const url = node.getChild("URL");
      if (url) return destination(state.sliceDoc(url.from, url.to));
      const label = node.getChild("LinkLabel");
      const marks = node.getChildren("LinkMark");
      const key =
        label && label.to - label.from > 2
          ? state.sliceDoc(label.from, label.to)
          : marks.length >= 2
            ? state.sliceDoc(marks[0].to, marks[1].from)
            : null;
      return key == null ? null : (definitions(state).get(labelKey(key)) ?? null);
    }
    case "Autolink":
    case "LinkReference": {
      const url = node.getChild("URL");
      return url ? destination(state.sliceDoc(url.from, url.to)) : null;
    }
    case "URL":
      // A bare URL (GFM's autolinks); inside a link, the link answers.
      return node.parent && /^(Link|Image|Autolink|LinkReference)$/.test(node.parent.name)
        ? null
        : state.sliceDoc(node.from, node.to);
    default:
      return null;
  }
}

/** The link at `pos` — where it points, as written — or null. */
export function linkAt(state: EditorState, pos: number): string | null {
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      const href = linkHref(state, node);
      if (href != null) return href;
    }
  }
  return null;
}

export type LinkTarget =
  /** A heading of this file. */
  | { kind: "heading"; slug: string }
  /** A file or folder of the repository (a repo-relative path), at a heading maybe. */
  | { kind: "path"; path: string; slug: string | null }
  /** Somewhere outside the repository. */
  | { kind: "external"; url: string };

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * What a link written in the file at `from` points to, the way GitHub reads it: a
 * relative path from the file's folder, `/…` from the repository's root, `#…` a heading.
 * Null for a path that climbs out of the repository.
 */
export function linkTarget(from: string, href: string): LinkTarget | null {
  const url = href.trim();
  if (!url) return null;
  if (/^[a-z][a-z0-9+.-]*:|^\/\/|^www\./i.test(url)) return { kind: "external", url };
  if (/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(url)) return { kind: "external", url: `mailto:${url}` };
  const hash = url.indexOf("#");
  const slug = hash < 0 ? null : decode(url.slice(hash + 1)).toLowerCase() || null;
  const written = decode((hash < 0 ? url : url.slice(0, hash)).replace(/\?.*$/, ""));
  if (!written) return slug ? { kind: "heading", slug } : null;
  const parts = written.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const seg of written.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg !== "..") parts.push(seg);
    else if (parts.pop() === undefined) return null;
  }
  return { kind: "path", path: parts.join("/"), slug };
}

/** A heading's anchor as GitHub makes it: lower case, punctuation dropped, `-` for spaces. */
export function headingSlug(text: string): string {
  const plain = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*~]/g, "")
    .replace(/(^|\W)_+|_+(?=\W|$)/g, "$1");
  return plain
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/**
 * The 1-based line of the heading `#slug` names in a Markdown text — a repeated heading's
 * anchor is `slug-1`, `slug-2`…, as on GitHub. Code fences hold no headings.
 */
export function headingLine(text: string, slug: string): number | null {
  const lines = text.split("\n");
  const seen = new Map<string, number>();
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      continue;
    }
    const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    const setext =
      i > 0 && /^ {0,3}(=+|-+)[ \t]*$/.test(line) && /\S/.test(lines[i - 1]) ? lines[i - 1] : null;
    const heading = atx ? (atx[1] ?? "") : setext;
    if (heading == null) continue;
    const base = headingSlug(heading);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    // A setext heading's text is the line above its underline.
    if ((n === 0 ? base : `${base}-${n}`) === slug) return atx ? i + 1 : i;
  }
  return null;
}

/**
 * Follow the link at `pos` in the selected window's Markdown file (`C-c C-o`, `M-.`, a
 * Ctrl+click): a file opens at the revision this one was read at — at the heading its
 * `#…` names — a folder shows in the tree, a heading here is a jump, and an address
 * outside the repository is copied, there being no browser to hand it to. Every move is
 * a jump `M-,` comes back from. False when there's no link at `pos`.
 */
export async function followLink(state: EditorState, pos: number, other = false): Promise<boolean> {
  const href = linkAt(state, pos);
  if (href == null) return false;
  const repo = useRepoStore.getState().repoPath;
  const file = currentFile();
  if (!repo || !file) return true;
  const flash = useUIStore.getState().showFlash;
  const choice = { source: file.source, label: file.sourceLabel };
  const target = linkTarget(file.path, href);
  if (!target) {
    flash(`${href} is outside the repository`);
  } else if (target.kind === "external") {
    const url = target.url;
    void navigator.clipboard?.writeText(url).then(
      () => flash(`Copied ${url}`),
      () => flash(url),
    );
  } else if (target.kind === "heading") {
    const line = headingLine(state.doc.toString(), target.slug);
    if (line == null) {
      flash(`No heading #${target.slug} here`);
    } else {
      recordJump();
      visitFile(file.path, choice, { line }, { other });
    }
  } else {
    const { path, slug } = target;
    const at = file.sourceLabel ? ` at ${file.sourceLabel}` : "";
    const text = await readFile(repo, file.source, path).catch(() => null);
    if (text == null) {
      const folder = await listRepoDir(repo, file.source, path).then(
        () => true,
        () => false,
      );
      if (folder) revealFolder(path);
      else flash(`No ${path}${at}`);
      return true;
    }
    const line = slug && isMarkdownPath(path) ? headingLine(text, slug) : null;
    recordJump();
    visitFile(path, choice, line == null ? undefined : { line }, { other });
    if (slug && line == null) flash(`No heading #${slug} in ${path.slice(path.lastIndexOf("/") + 1)}`);
  }
  return true;
}

/** `C-c C-o`: follow the link at the selected window's cursor. */
export async function followLinkAtCursor(): Promise<void> {
  const view = activeView();
  if (view && !(await followLink(view.state, view.state.selection.main.head))) {
    useUIStore.getState().showFlash("No link here");
  }
}

/** A link to a folder: the folder in the tree, which takes the keyboard. */
function revealFolder(path: string): void {
  const ps = useProjectStore.getState();
  if (ps.filter === "changed") {
    ps.toggleFilter();
    useUIStore.getState().showFlash("Showing all files");
  }
  recordJump();
  if (!inProjectMode(useWindowStore.getState())) showProject();
  revealInTree(path);
  focusTree();
}
