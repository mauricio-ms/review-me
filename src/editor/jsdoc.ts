import { syntaxTree } from "@codemirror/language";
import { type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { NodeProp, type Tree } from "@lezer/common";

type Kind = "tag" | "type" | "name" | "link";
export type JSDocToken = { from: number; to: number; kind: Kind };

const typeTags = new Set([
  "param", "arg", "argument", "property", "prop", "returns", "return", "type", "typedef",
  "throws", "exception", "yields", "yield", "extends", "augments", "implements", "this",
  "enum", "member", "var", "template", "satisfies",
]);
const nameTags = new Set(["param", "arg", "argument", "property", "prop", "typedef", "callback", "template"]);
const linkTags = new Set(["link", "linkcode", "linkplain", "tutorial"]);

/** Read nested type braces or optional parameter brackets, including quoted defaults. */
function delimitedEnd(text: string, start: number, limit: number): number {
  const closes: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
  const stack = [closes[text[start]]];
  let quote = "";
  for (let i = start + 1; i < limit; i++) {
    const ch = text[i];
    if (ch === "\\") { i++; continue; }
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (closes[ch]) {
      stack.push(closes[ch]);
    } else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return limit;
}

/** Offsets stay in the original comment; masking its line prefixes keeps multiline types intact. */
export function jsdocTokens(comment: string): JSDocToken[] {
  if (!comment.startsWith("/**") || comment.startsWith("/***")) return [];
  const end = comment.endsWith("*/") ? comment.length - 2 : comment.length;
  const body = comment.slice(3, end).replace(/(^|\n)[\t ]*\*(?!\/)/g,
    (prefix) => prefix.replace(/[^\n]/g, " "));
  const tokens: JSDocToken[] = [];
  const add = (from: number, to: number, kind: Kind) => {
    if (to > from) tokens.push({ from: from + 3, to: to + 3, kind });
  };
  const tags = Array.from(body.matchAll(/^[\t ]*(@[a-zA-Z][\w-]*)\b/gm));
  for (let i = 0; i < tags.length; i++) {
    const match = tags[i];
    const tag = match[1];
    const from = match.index! + match[0].length - tag.length;
    const limit = i + 1 < tags.length ? tags[i + 1].index! : body.length;
    add(from, from + tag.length, "tag");
    const name = tag.slice(1).toLowerCase();
    let pos = from + tag.length;
    const skipSpace = () => { while (pos < limit && /\s/.test(body[pos])) pos++; };
    skipSpace();
    if (typeTags.has(name) && body[pos] === "{") {
      const to = delimitedEnd(body, pos, limit);
      add(pos, to, "type");
      pos = to;
      skipSpace();
    }
    if (!nameTags.has(name) || pos >= limit) continue;
    if (body[pos] === "[") {
      add(pos, delimitedEnd(body, pos, limit), "name");
    } else {
      const pattern = name === "template"
        ? /^[a-zA-Z_$][\w$]*(?:[\t ]*,[\t ]*[a-zA-Z_$][\w$]*)*/
        : /^(?:\.\.\.)?[a-zA-Z_$][\w$.[\]#~]*/;
      const param = pattern.exec(body.slice(pos, limit));
      if (param) add(pos, pos + param[0].length, "name");
    }
  }
  for (const match of body.matchAll(/\{@([a-zA-Z][\w-]*)\b/g)) {
    const from = match.index!;
    // A string literal in a type or default is not an inline documentation tag.
    if (tokens.some((token) => token.from <= from + 3 && token.to > from + 3)) continue;
    const tagEnd = from + match[0].length;
    add(from + 1, tagEnd, "tag");
    if (!linkTags.has(match[1].toLowerCase())) continue;
    const target = /^[\t ]*([^\s|}]+)/.exec(body.slice(tagEnd));
    if (target) {
      const start = tagEnd + target[0].length - target[1].length;
      add(start, start + target[1].length, "link");
    }
  }
  return tokens.sort((a, b) => a.from - b.from);
}

const marks = {
  prose: Decoration.mark({ class: "cm-jsdoc" }),
  tag: Decoration.mark({ class: "cm-jsdoc cm-jsdoc-tag" }),
  type: Decoration.mark({ class: "cm-jsdoc cm-jsdoc-type" }),
  name: Decoration.mark({ class: "cm-jsdoc cm-jsdoc-name" }),
  link: Decoration.mark({ class: "cm-jsdoc cm-jsdoc-link" }),
};
type Span = { from: number; to: number };
type CachedComment = { to: number; tokens: JSDocToken[]; ranges: readonly Span[] };

function intersect(left: readonly Span[], right: readonly Span[]): Span[] {
  const ranges: Span[] = [];
  for (const a of left) for (const b of right) {
    const from = Math.max(a.from, b.from), to = Math.min(a.to, b.to);
    if (from < to) ranges.push({ from, to });
  }
  return ranges;
}

/** Mask text omitted from a mounted parser, such as Markdown quote prefixes. */
function commentText(text: string, offset: number, ranges: readonly Span[]): string {
  const parts: string[] = [];
  let pos = 0;
  for (const { from, to } of ranges) {
    parts.push(text.slice(pos, from - offset).replace(/[^\r\n]/g, " "), text.slice(from - offset, to - offset));
    pos = to - offset;
  }
  parts.push(text.slice(pos).replace(/[^\r\n]/g, " "));
  return parts.join("");
}

/** Visit regular mounts and overlays (ordinary tree iteration skips the latter). */
function commentsIn(tree: Tree, offset: number, from: number, to: number,
  comment: (from: number, to: number, regions?: readonly Span[]) => void, regions?: readonly Span[]): void {
  tree.iterate({
    from: from - offset, to: to - offset,
    enter(ref) {
      const start = ref.from + offset;
      if (ref.name === "BlockComment") comment(start, ref.to + offset, regions);
      const mount = ref.tree?.prop(NodeProp.mounted);
      if (mount?.overlay?.length) {
        const overlay = mount.overlay.map((range) => ({ from: start + range.from, to: start + range.to }));
        commentsIn(mount.tree, start + mount.overlay[0].from, from, to, comment,
          regions ? intersect(regions, overlay) : overlay);
      }
    },
  });
}

/** Highlight only real JS/TS documentation comments, without changing source or its syntax tree. */
export const jsdocHighlight = ViewPlugin.fromClass(class {
  decorations: DecorationSet = Decoration.none;
  private comments = new Map<number, CachedComment>();

  constructor(view: EditorView) { this.build(view); }

  update(update: ViewUpdate) {
    const parsed = syntaxTree(update.startState) !== syntaxTree(update.state);
    if (update.docChanged || parsed) this.comments.clear();
    if (update.docChanged || update.viewportChanged || parsed) {
      this.build(update.view);
    }
  }

  private build(view: EditorView) {
    const { state, visibleRanges } = view;
    const comments = new Map<number, CachedComment>();
    for (const { from, to } of visibleRanges) {
      commentsIn(syntaxTree(state), 0, from, to, (start, end, regions) => {
        if (comments.has(start) || !state.languageDataAt<boolean>("jsdoc", start + 2).includes(true)) return;
        if (state.sliceDoc(start, start + 3) !== "/**" || state.sliceDoc(start, start + 4) === "/***") return;
        const cached = this.comments.get(start);
        if (cached?.to === end) {
          comments.set(start, cached);
        } else {
          const ranges = regions ? intersect([{ from: start, to: end }], regions) : [{ from: start, to: end }];
          comments.set(start, { to: end, ranges, tokens: jsdocTokens(commentText(state.sliceDoc(start, end), start, ranges)) });
        }
      });
    }
    const ranges: Range<Decoration>[] = [];
    for (const [from, { to, tokens, ranges: sourceRanges }] of comments) {
      const shown = intersect(sourceRanges, visibleRanges);
      const add = (start: number, end: number, mark: Decoration) => {
        for (const visible of shown) {
          const left = Math.max(start, visible.from), right = Math.min(end, visible.to);
          if (left < right) ranges.push(mark.range(left, right));
        }
      };
      let pos = from;
      for (const token of tokens) {
        add(pos, from + token.from, marks.prose);
        add(from + token.from, from + token.to, marks[token.kind]);
        pos = from + token.to;
      }
      add(pos, to, marks.prose);
    }
    this.comments = comments;
    this.decorations = Decoration.set(ranges, true);
  }
}, { decorations: (plugin) => plugin.decorations });
