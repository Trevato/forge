/**
 * Shared red (#6551): a test failing on three or more open pulls is a clash
 * between pulls, not separate bugs; name it once so the pulls are re-checked
 * together after the fix. Pure: rows in, rows out.
 */

export const SHARED_RED_PULLS = 3;

export interface RedRow {
  readonly pull: number;
  readonly failingTests: readonly string[];
}

export interface SharedRed {
  readonly test: string;
  readonly pulls: number[];
}

/** Tests failing on at least three distinct pulls, most pulls first, ties by test name. */
export function sharedRed(rows: readonly RedRow[]): SharedRed[] {
  const byTest = new Map<string, Set<number>>();
  for (const row of rows) {
    for (const test of row.failingTests) {
      let pulls = byTest.get(test);
      if (!pulls) byTest.set(test, (pulls = new Set()));
      pulls.add(row.pull);
    }
  }
  const out: SharedRed[] = [];
  for (const [test, pulls] of byTest) {
    if (pulls.size >= SHARED_RED_PULLS) out.push({ test, pulls: [...pulls].sort((a, b) => a - b) });
  }
  return out.sort((a, b) => b.pulls.length - a.pulls.length || (a.test < b.test ? -1 : a.test > b.test ? 1 : 0));
}

/** One sentence per shared test; empty when none. */
export function sharedRedSays(rows: readonly RedRow[]): string[] {
  return sharedRed(rows).map(
    (s) => `${s.test} fails on ${s.pulls.length} pulls: one clash, re-check together after the fix`,
  );
}
