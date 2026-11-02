/**
 * Rendering highlighted code. Syntax tokens give each character a color class;
 * a diff can additionally mark characters as changed. These are two different
 * segmentations of the same line, so we merge them at the character level and
 * emit one span per run of (class, changed) — the clean way to compose the
 * syntax layer (text color) with the diff layer (background + underline)
 * without either having to agree on the other's boundaries.
 *
 * A token now carries a colour class *and*, sometimes, a finer kind ("this
 * string is a regex", "this keyword is a tag"). The mask therefore holds the
 * whole class attribute rather than one name, which is also what keeps a
 * plain file's markup identical to what the browser bundle renders: both go
 * through `tokenClasses`.
 */

import {
  detectLanguage,
  highlightLines,
  type Language,
  type Token,
} from "./highlight.ts";
import { highlightToLines, tokenClasses } from "./highlight-html.ts";
import { html, raw, type Html } from "./html.ts";

/** Per-character class attributes for one line, or null where none apply. */
function classMask(
  text: string,
  tokens: Token[] | undefined,
): (string | null)[] {
  const mask: (string | null)[] = new Array(text.length).fill(null);
  if (!tokens) return mask;
  let pos = 0;
  for (const token of tokens) {
    const classes = tokenClasses(token);
    const value = classes === "" ? null : classes;
    for (let k = 0; k < token.text.length && pos < text.length; k++)
      mask[pos++] = value;
  }
  // If the token stream didn't cover the line (source mismatch), the tail
  // simply stays unclassified — still correct, just uncolored.
  return mask;
}

/**
 * Compose a line into spans. `tokens` colors it; `changed` (per character)
 * marks the diff highlight. Either may be omitted.
 */
export function composeLine(
  text: string,
  tokens: Token[] | undefined,
  changed: boolean[] | undefined,
): Html {
  if (text === "") return html``;
  const classes = classMask(text, tokens);
  const parts: Html[] = [];

  let runStart = 0;
  const flush = (end: number) => {
    if (end <= runStart) return;
    const slice = text.slice(runStart, end);
    const cls = classes[runStart];
    const isChanged = changed?.[runStart] ?? false;
    if ((cls === null || cls === undefined) && !isChanged) {
      parts.push(html`${slice}`);
    } else {
      const names = [cls ?? "", isChanged ? "wd" : ""]
        .filter(Boolean)
        .join(" ");
      parts.push(html`<span class="${names}">${slice}</span>`);
    }
    runStart = end;
  };

  for (let i = 1; i < text.length; i++) {
    const sameClass = classes[i] === classes[runStart];
    const sameChanged =
      (changed?.[i] ?? false) === (changed?.[runStart] ?? false);
    if (!sameClass || !sameChanged) flush(i);
  }
  flush(text.length);
  return html`${parts}`;
}

/** Highlight a whole blob into per-line Html, for the file browser. */
export function highlightBlob(
  content: string,
  path: string,
  lang?: Language,
): Html[] {
  const language = lang ?? detectLanguage(path, firstLineOf(content));
  return highlightToLines(content, language).map(raw);
}

const firstLineOf = (content: string): string => {
  const end = content.indexOf("\n");
  return end === -1 ? content.slice(0, 200) : content.slice(0, end);
};

export { detectLanguage, highlightLines };

/** Highlighted lines kept by content hash, so a repeat view highlights nothing. */
const CACHE_MAX = 32;
const cache = new Map<string, Html[]>();

export const countLines = (text: string): number => {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
};

/**
 * The first `limit` lines of a blob, highlighted. Keyed by what the file
 * says (a blob's oid is a hash of the same bytes), its name and the limit;
 * bounded to the last CACHE_MAX files, least recently used out.
 */
export function highlightPrefix(
  text: string,
  path: string,
  limit: number,
): Html[] {
  const key = `${Bun.hash(text).toString(36)}:${text.length}:${limit}:${path.slice(path.lastIndexOf("/") + 1)}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let end = -1;
  for (let n = 0; n < limit; n++) {
    end = text.indexOf("\n", end + 1);
    if (end === -1) break;
  }
  const lines = highlightBlob(end === -1 ? text : text.slice(0, end), path);
  cache.set(key, lines);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return lines;
}
