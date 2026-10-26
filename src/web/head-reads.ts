/**
 * The Files page's other git reads, kept per pair of commit oids.
 *
 * `wallOf` (two contract reads) and `commitLog` (one `git log`) are pure
 * functions of the oids they are given, so the next reader of the same head
 * gets them from memory, as the diff does (`diff-cache.ts`). In memory only,
 * bounded by entries, least recently used out first. Callers treat values as
 * read-only; a value that `keep` refuses is served and forgotten.
 */

export const MAX_READS = 256;

const kept = new Map<string, unknown>();

/** What `make` returns for `key`, from memory when it has been asked before. */
export async function keptRead<T>(
  key: string,
  make: () => Promise<T>,
  keep: (value: T) => boolean = () => true,
): Promise<T> {
  if (kept.has(key)) {
    const known = kept.get(key) as T;
    kept.delete(key);
    kept.set(key, known);
    return known;
  }
  const value = await make();
  if (keep(value)) {
    kept.set(key, value);
    while (kept.size > MAX_READS) kept.delete(kept.keys().next().value as string);
  }
  return value;
}

/** Forget everything (tests). */
export function clearHeadReads(): void {
  kept.clear();
}
