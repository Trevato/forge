/**
 * Themes for the planner (#8850): the words a title is about, and issues
 * grouped by the word they share most. Plain data in, plain data out; no
 * model, so the same issues always fall into the same groups.
 */

const STOP = new Set([
  "about", "add", "after", "allow", "also", "and", "are", "can", "does", "each", "for", "from", "have", "into", "make",
  "more", "not", "one", "should", "show", "that", "the", "their", "them", "then", "there", "this", "use", "when",
  "with", "without", "your",
]);

/** The words of a text worth grouping by: lowercase, 4+ letters, not filler. */
export function themeWords(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOP.has(w)))];
}

/**
 * Group items by shared title words: repeatedly take the word in the most
 * ungrouped titles (ties: alphabetical) while at least two share it. Items
 * sharing no word with another are left out. Order of the input is kept
 * inside each group.
 */
export function groupByWords<T extends { title: string }>(items: readonly T[]): Map<string, T[]> {
  const words = items.map((i) => ({ item: i, words: new Set(themeWords(i.title)) }));
  let rest = words;
  const out = new Map<string, T[]>();
  for (;;) {
    const count = new Map<string, number>();
    for (const r of rest) for (const w of r.words) count.set(w, (count.get(w) ?? 0) + 1);
    const best = [...count].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best === undefined) return out;
    out.set(best[0], rest.filter((r) => r.words.has(best[0])).map((r) => r.item));
    rest = rest.filter((r) => !r.words.has(best[0]));
  }
}
