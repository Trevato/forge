/**
 * Tokens → HTML. One function, used by three callers that must agree
 * character for character: the file browser, the diff viewer, and the browser
 * bundle the editor loads. The editor draws highlighted text *underneath* a
 * transparent textarea, so if the client's markup differed from the server's
 * by one span the caret would sit in the wrong place — sharing this module is
 * what makes that impossible rather than merely unlikely.
 *
 * It is deliberately free of anything but string work: `Bun.build` turns it
 * (and `highlight.ts`) into the served asset, and nothing in either file can
 * reach for a server API.
 */

import { highlightLines, type Language, type Token } from "./highlight.ts";
import { escapeHtml } from "./html.ts";

/**
 * The class attribute for a token: its colour class, plus the refinement when
 * it has one. A plain token with no refinement gets no span at all.
 */
export function tokenClasses(token: Token): string {
  const base = token.cls === "plain" ? "" : `tok-${token.cls}`;
  if (token.kind === undefined) return base;
  return base === "" ? `tok-${token.kind}` : `${base} tok-${token.kind}`;
}

/** One line of tokens as HTML. */
export function renderTokens(tokens: readonly Token[]): string {
  let out = "";
  for (const token of tokens) {
    const classes = tokenClasses(token);
    const text = escapeHtml(token.text);
    out += classes === "" ? text : `<span class="${classes}">${text}</span>`;
  }
  return out;
}

/** Every line of `code`, highlighted, as HTML strings. */
export function highlightToLines(code: string, lang: Language): string[] {
  return highlightLines(code, lang).map(renderTokens);
}

/** `code`, highlighted, as one HTML string with the newlines kept. */
export function highlightToHtml(code: string, lang: Language): string {
  return highlightToLines(code, lang).join("\n");
}
