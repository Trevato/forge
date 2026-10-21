/**
 * New app's starter sentences: a few ways to begin for someone who does not
 * know what to type. Each is a plain link to `/apps/new?description=…`, so
 * it works with no script; the page reads the value back through
 * `starterFromQuery`, the one door a `description` query comes in by.
 */

export const STARTERS: readonly string[] = [
  "Notes my team can share",
  "A form that collects answers and lists them",
  "A list with a page for each item",
  "A counter that everyone can bump",
];

/** The longest sentence the query may prefill; the longest starter is far under. */
export const MAX_STARTER_LENGTH = 200;

/**
 * The prefill a `?description=` carries, or "" when it is not plain text of a
 * sensible length (control characters, too long, blank). Never an error: a
 * bad value is simply ignored. Escaping is the template's job on output.
 */
export function starterFromQuery(raw: string | null): string {
  if (raw === null) return "";
  const text = raw.trim();
  if (text === "" || text.length > MAX_STARTER_LENGTH) return "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return "";
  }
  return text;
}

/** The link for one starter; `owner` rides along so an org's form stays the org's. */
export function starterHref(sentence: string, owner?: string): string {
  const own = owner === undefined ? "" : `&owner=${encodeURIComponent(owner)}`;
  return `/apps/new?description=${encodeURIComponent(sentence)}${own}`;
}
