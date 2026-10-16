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

/** Clamp to `width` px at `size` px type; exported for the tests. */
export function fit(text: string, size: number, width: number, em = EM): string {
  const max = Math.max(1, Math.floor(width / (size * em)));
  const chars = Array.from(clean(text));
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, max - 1).join("").trimEnd() + "…";
}
