/**
 * Text into an SVG card: strip what XML cannot carry, clamp to a width by
 * an estimated advance, and escape. Shared by the card (`card.ts`) and the
 * figures drawn on it, so every string on a card goes through one door.
 */

/** Widest average glyph advance, in em, for the sans stack (bold is wider). */
export const EM = 0.62;

/** Drop what XML 1.0 forbids (controls, lone surrogates); fold whitespace. */
export function clean(s: unknown): string {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/[^\u0009\u000A\u000D -\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "")
    .trim();
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * How wide a string is, in units of one average glyph (`EM`): capitals are
 * wider than that and W, M, m, w, @ and % much wider, so a run of them is not
 * judged as if it were lowercase.
 */
export function advance(text: string): number {
  let units = 0;
  for (const ch of text) units += /[WMmw@%]/.test(ch) ? 1.6 : /[A-Z]/.test(ch) ? 1.25 : 1;
  return units;
}

/**
 * Clamp to `width` px at `size` px type; exported for the tests. A cut falls
 * at a word and ends in an ellipsis, after dropping any separator left at the
 * cut (`·`, `|`, `/`, `•`, punctuation); only a single word wider than the
 * whole width is cut inside the word, and it too ends in one.
 */
export function fit(text: string, size: number, width: number, em = EM): string {
  const limit = width / (size * em);
  const flat = clean(text);
  if (advance(flat) <= limit) return flat;
  const chars = Array.from(flat);
  let end = 0;
  let used = 1; // the ellipsis
  while (end < chars.length && used + advance(chars[end]!) <= limit) used += advance(chars[end++]!);
  const atWord = chars[end] === " " || chars[end - 1] === " ";
  let kept = chars.slice(0, end).join("");
  if (!atWord) {
    const space = kept.lastIndexOf(" ");
    // Back to the word before, unless that leaves nothing worth showing.
    if (space > 0 && /[\p{L}\p{N}]/u.test(kept.slice(0, space))) kept = kept.slice(0, space);
  }
  return kept.replace(/[\s\p{P}\p{S}]+$/u, "") + "…";
}
