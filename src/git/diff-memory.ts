/**
 * Diffs between two commits, and the merge base a pull's diff starts from,
 * kept for the next reader of the same pair.
 *
 * A diff between two object ids never changes, so the second reader of an
 * unmoved pull — a reviewer, the terminal, an agent through the API — is
 * served from here and spawns no git. The key carries the repository's
 * directory as well as both oids: a diff read in one repository is never
 * answered to a reader of another, whatever oids they name.
 *
 * Bounded by estimated bytes, least recently used out first. One diff over
 * `MAX_DIFF_BYTES` is never kept, so a single huge change cannot empty the
 * memory for everyone else. Values are deeply frozen: every reader shares
 * one copy and none can change another's. A failed git run is not kept.
 * Nothing is allocated until a process reads a diff, and it lives only as
 * long as that process.
 */

import type { Diff } from "./diff.ts";

/** All kept diffs together, estimated as their parsed size. */
export const MAX_BYTES = 32 * 1024 * 1024;
/** One diff larger than this is served but never kept. */
export const MAX_DIFF_BYTES = 4 * 1024 * 1024;

const kept = new Map<string, { diff: Diff; bytes: number }>();
let total = 0;

export function diffMemoryKey(dir: string, from: string, to: string): string {
  return `${dir}\0${from}\0${to}`;
}

/**
 * What a parsed diff holds in memory, roughly: each line's text twice over
 * (strings are UTF-16) plus the row object around it.
 */
export function sizeOfDiff(diff: Diff): number {
  let n = 0;
  for (const file of diff.files) {
    n += 128 + file.path.length * 2;
    for (const hunk of file.hunks) {
      n += 64 + hunk.section.length * 2;
      for (const line of hunk.lines) n += 48 + line.content.length * 2;
    }
  }
  return n;
}

/** The kept diff for `key`, freshened as most recently used. */
export function recalled(key: string): Diff | undefined {
  const known = kept.get(key);
  if (known === undefined) return undefined;
  kept.delete(key);
  kept.set(key, known);
  return known.diff;
}

/** Keep `diff` under `key` when it fits; returns the frozen value to serve. */
export function remember(key: string, diff: Diff): Diff {
  const frozen = deepFreeze(diff);
  const bytes = sizeOfDiff(frozen);
  if (bytes > MAX_DIFF_BYTES) return frozen;
  const known = kept.get(key);
  if (known !== undefined) {
    total -= known.bytes;
    kept.delete(key);
  }
  kept.set(key, { diff: frozen, bytes });
  total += bytes;
  while (total > MAX_BYTES) {
    const oldest = kept.keys().next().value as string;
    total -= kept.get(oldest)!.bytes;
    kept.delete(oldest);
  }
  return frozen;
}

/** What is held now, for tests. */
export function diffMemoryCounts(): { entries: number; bytes: number } {
  return { entries: kept.size, bytes: total };
}

/** Forget every kept diff and merge base (tests). */
export function forgetDiffs(): void {
  kept.clear();
  total = 0;
  mergeBases.clear();
}

// ---- merge bases ----
//
// The fork point a pull's diff is measured from is as fixed as the diff:
// two commits have one merge base. Each entry is three short strings, so
// these are bounded by count, least recently used out first.

/** How many merge bases are kept: a few hundred bytes each. */
export const MERGE_BASES_KEPT = 4096;
const mergeBases = new Map<string, string>();

/** The kept merge base for `key` (`diffMemoryKey`), freshened as most recently used. */
export function recalledBase(key: string): string | undefined {
  const known = mergeBases.get(key);
  if (known === undefined) return undefined;
  mergeBases.delete(key);
  mergeBases.set(key, known);
  return known;
}

/** Keep the merge base found for `key`; never call this with a failed lookup. */
export function rememberBase(key: string, base: string): void {
  mergeBases.delete(key);
  mergeBases.set(key, base);
  if (mergeBases.size > MERGE_BASES_KEPT) mergeBases.delete(mergeBases.keys().next().value as string);
}

/** How many merge bases are held now, for tests. */
export function mergeBaseCount(): number {
  return mergeBases.size;
}

function deepFreeze(diff: Diff): Diff {
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) Object.freeze(line);
      Object.freeze(hunk.lines);
      Object.freeze(hunk);
    }
    Object.freeze(file.hunks);
    Object.freeze(file);
  }
  Object.freeze(diff.files);
  return Object.freeze(diff);
}
