/**
 * Words a zero-technical client should not meet on their first page (#10752).
 * Whole words, case-insensitive. The list is meant to shrink; it has no
 * allow list. A hyphen breaks a word, so "ssh-key" and "model-key" are hits.
 */

export const JARGON = [
  "egress",
  "sentinel",
  "shard",
  "cell",
  "gate",
  "rebase",
  "tbw",
  "token",
  "origin",
  "palette",
  "model key",
  "ssh",
] as const;

const WORDS = new RegExp(
  `(?<![A-Za-z0-9_])(?:${JARGON.map((w) => w.replace(/ /g, "[\\s-]+")).join("|")})s?(?![A-Za-z0-9_])`,
  "gi",
);

/** What a reader sees or hears of `html`: visible text plus aria-label, title, alt and placeholder values. */
export function readableText(html: string): string {
  const parts: string[] = [];
  for (const m of html.matchAll(/\b(?:aria-label|title|alt|placeholder)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi))
    parts.push(m[1] ?? m[2] ?? "");
  const body = html
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  parts.push(body);
  return parts.join("\n").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
}

/** Every jargon word found in `html`'s readable text, in order, with a little context. */
export function jargonIn(html: string): string[] {
  const text = readableText(html);
  return [...text.matchAll(WORDS)].map((m) => {
    const at = m.index ?? 0;
    return `${m[0]}: …${text.slice(Math.max(0, at - 30), at + m[0].length + 30)}…`;
  });
}
