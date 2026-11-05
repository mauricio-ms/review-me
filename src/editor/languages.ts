import { LanguageDescription, LanguageSupport, LRLanguage } from "@codemirror/language";
import { languages as builtin } from "@codemirror/language-data";
import { parseMixed, type Input, type SyntaxNodeRef } from "@lezer/common";

/**
 * The viewer's languages: `@codemirror/language-data`'s, plus the component formats it
 * lacks — Svelte (Replit's grammar) and Astro (HTML with TypeScript mixed in over the
 * frontmatter and every `{…}` expression), loaded lazily like the rest — and Markdown as
 * GitHub writes it: language-data's is plain CommonMark, which reads no tables, task
 * lists or strikethrough and leaves fenced code unhighlighted.
 */
const extra = [
  LanguageDescription.of({
    name: "Markdown",
    extensions: ["md", "markdown", "mkd"],
    load: () =>
      import("@codemirror/lang-markdown").then((m) =>
        m.markdown({ base: m.markdownLanguage, codeLanguages: languages }),
      ),
  }),
  LanguageDescription.of({
    name: "Svelte",
    extensions: ["svelte"],
    load: () => import("@replit/codemirror-lang-svelte").then((m) => m.svelte()),
  }),
  LanguageDescription.of({
    name: "Astro",
    extensions: ["astro"],
    load: () => astro(),
  }),
];

// These languages already load the JavaScript grammar, directly or through HTML.
// Mark its data facet so the viewer can distinguish JSDoc from other languages'
// block comments, including when only its parser is mounted in a Markdown fence.
const withJSDoc = new Set(["JavaScript", "JSX", "TypeScript", "TSX", "HTML", "Vue", "Svelte", "Astro", "Markdown"]);
export const languages: readonly LanguageDescription[] = [...extra, ...builtin].map((desc) =>
  !withJSDoc.has(desc.name) ? desc : LanguageDescription.of({
    name: desc.name, alias: desc.alias, extensions: desc.extensions, filename: desc.filename,
    async load() {
      const [support, { javascriptLanguage }] = await Promise.all([
        desc.load(), import("@codemirror/lang-javascript"),
      ]);
      return new LanguageSupport(support.language, [support.support, javascriptLanguage.data.of({ jsdoc: true })]);
    },
  }),
);

async function astro(): Promise<LanguageSupport> {
  const [{ htmlLanguage, html }, { tsxLanguage, typescriptLanguage }] = await Promise.all([
    import("@codemirror/lang-html"),
    import("@codemirror/lang-javascript"),
  ]);
  const language = LRLanguage.define({
    name: "astro",
    parser: htmlLanguage.parser.configure({
      wrap: parseMixed((node: SyntaxNodeRef, input: Input) => {
        if (node.type.isTop) {
          const fence = frontmatter(input.read(0, Math.min(input.length, 64 * 1024)));
          return fence ? { parser: typescriptLanguage.parser, overlay: [fence] } : null;
        }
        if (node.name === "Text" || node.name === "UnquotedAttributeValue") {
          const ranges = braces(input.read(node.from, node.to), node.from);
          return ranges.length > 0 ? { parser: tsxLanguage.parser, overlay: ranges } : null;
        }
        return null;
      }),
    }),
  });
  return new LanguageSupport(language, html().support);
}

/** The TypeScript between an Astro file's opening `---` fences, if it has them. */
function frontmatter(text: string): { from: number; to: number } | null {
  const start = text.length - text.trimStart().length;
  if (!text.startsWith("---", start)) return null;
  const close = text.indexOf("\n---", start + 3);
  return close < 0 ? null : { from: start + 3, to: close };
}

/** The insides of every top-level `{…}` in `text` (which starts at `offset`). */
function braces(text: string, offset: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let depth = 0;
  let open = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth++ === 0) open = i + 1;
    } else if (text[i] === "}" && depth > 0 && --depth === 0) {
      if (i > open) out.push({ from: offset + open, to: offset + i });
    }
  }
  return out;
}
