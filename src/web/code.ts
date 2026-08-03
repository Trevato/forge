/**
 * Rendering highlighted code. Syntax tokens give each character a color class;
 * a diff can additionally mark characters as changed. These are two different
 * segmentations of the same line, so we merge them at the character level and
 * emit one span per run of (class, changed) — the clean way to compose the
 * syntax layer (text color) with the diff layer (background + underline)
 * without either having to agree on the other's boundaries.
 */

import {
  detectLanguage,
  highlightLines,
  type Language,
  type Token,
  type TokenClass,
} from "./highlight.ts";
import { html, type Html } from "./html.ts";

/** Per-character token classes for one line, or null where none apply. */
function classMask(
  text: string,
  tokens: Token[] | undefined,
): (TokenClass | null)[] {
  const mask: (TokenClass | null)[] = new Array(text.length).fill(null);
  if (!tokens) return mask;
  let pos = 0;
  for (const token of tokens) {
    for (let k = 0; k < token.text.length && pos < text.length; k++)
      mask[pos++] = token.cls;
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
    if (cls === null && !isChanged) {
      parts.push(html`${slice}`);
    } else {
      const names = [cls ? `tok-${cls}` : "", isChanged ? "wd" : ""]
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
  const language = lang ?? detectLanguage(path);
  return highlightLines(content, language).map((tokens) =>
    composeLine(tokens.map((t) => t.text).join(""), tokens, undefined),
  );
}

export { detectLanguage, highlightLines };
