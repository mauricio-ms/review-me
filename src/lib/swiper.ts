/**
 * Swiper's matching, as ivy's `ivy--regex-plus` reads the input: words separated by
 * single spaces (two spaces type one literal space), each a regexp, which must all match
 * a line in order; the words after a `!` must not match it at all. A word is an Emacs
 * regexp — `(`, `)`, `{`, `}` and `|` are literal and `\(`, `\|`, `\{` the operators,
 * which is what makes code searchable as typed — and one that doesn't compile is read
 * literally. Smart case: case matters once the input has a capital in it.
 */

/** A matched stretch of a line: [from, to) in UTF-16 units. */
export type Span = [from: number, to: number];

export type SwiperMatcher = {
  /** Where `line` matches, every occurrence; null when the line doesn't. */
  match: (line: string) => Span[] | null;
};

/** A line that matches (0-based), and where. */
export type SwiperHit = { index: number; spans: Span[] };

const EMACS_SPECIAL = "(){}|";

/** An Emacs regexp in JavaScript's syntax: the two swap what `(` and `\(` mean. */
function fromEmacs(word: string): string {
  let out = "";
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch === "\\" && i + 1 < word.length) {
      const next = word[++i];
      out += EMACS_SPECIAL.includes(next) ? next : `\\${next}`;
    } else {
      out += EMACS_SPECIAL.includes(ch) ? `\\${ch}` : ch;
    }
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A word's JavaScript source: the regexp it spells, else the word itself. */
function wordSource(word: string): string {
  const source = fromEmacs(word);
  try {
    new RegExp(source);
    return source;
  } catch {
    return escapeRegExp(word);
  }
}

/** Single spaces split; a run of n spaces is n - 1 literal ones. */
function words(input: string): string[] {
  const out: string[] = [];
  let word = "";
  for (const part of input.split(/( +)/)) {
    if (!part.startsWith(" ")) word += part;
    else if (part.length > 1) word += part.slice(1);
    else {
      if (word) out.push(word);
      word = "";
    }
  }
  if (word) out.push(word);
  return out;
}

type IndexedMatch = RegExpExecArray & {
  indices?: { groups?: Record<string, Span | undefined> };
};

/** The matcher for `input`, or null when it asks for nothing (every line matches). */
export function compileSwiper(input: string): SwiperMatcher | null {
  // The first `!` not written `\!` starts what must not match.
  const bang = input.split("").findIndex((ch, i) => ch === "!" && input[i - 1] !== "\\");
  const positive = words((bang < 0 ? input : input.slice(0, bang)).replace(/\\!/g, "!"));
  const negative = bang < 0 ? [] : words(input.slice(bang + 1).replace(/\\!/g, "!"));
  if (positive.length === 0 && negative.length === 0) return null;

  const flags = input === input.toLowerCase() ? "i" : "";
  // Each word a named group, so its own `\(…\)` groups can't shift where it is.
  const names = positive.map((_, i) => `w${i}`);
  const all = positive.length
    ? new RegExp(
        positive.map((w, i) => `(?<${names[i]}>${wordSource(w)})`).join(".*?"),
        // `d` reports where each group matched.
        `${flags}dg`,
      )
    : null;
  const excluded = negative.map((w) => new RegExp(wordSource(w), flags));

  return {
    match: (line) => {
      if (excluded.some((re) => re.test(line))) return null;
      if (!all) return [];
      const spans: Span[] = [];
      all.lastIndex = 0;
      let found = false;
      for (let m = all.exec(line) as IndexedMatch | null; m; m = all.exec(line) as IndexedMatch | null) {
        found = true;
        for (const name of names) {
          const span = m.indices?.groups?.[name];
          if (span && span[1] > span[0]) spans.push([span[0], span[1]]);
        }
        // An empty match (`^`) would match there forever.
        if (m[0].length === 0) all.lastIndex++;
      }
      return found ? spans : null;
    },
  };
}

/** The lines `matcher` matches, in order (every line, for no matcher). */
export function swipe(lines: readonly string[], matcher: SwiperMatcher | null): SwiperHit[] {
  const hits: SwiperHit[] = [];
  lines.forEach((line, index) => {
    const spans = matcher ? matcher.match(line) : [];
    if (spans) hits.push({ index, spans });
  });
  return hits;
}

/**
 * Which hit is selected while `line` is: the first at or after it, else the last — so
 * narrowing the search keeps the selection where it was, or moves it on (ivy's
 * `ivy-recompute-index-swiper`). -1 when nothing matches.
 */
export function nearestHit(hits: readonly SwiperHit[], line: number): number {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hits[mid].index < line) lo = mid + 1;
    else hi = mid;
  }
  return lo < hits.length ? lo : hits.length - 1;
}

/** `text` as a search for itself: what `M-n` types for the symbol at the cursor. */
export function quoteSwiper(text: string): string {
  return text.replace(/[.*+?^$[\]\\!]/g, "\\$&").replace(/ /g, "  ");
}
