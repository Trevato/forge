/**
 * A repo-wide rule as tests (#7138): one red test per breach, named for
 * the breach itself (`test/x.test.ts:5: expect(…)…`), so a red check's
 * summary — which quotes the failing tests' names — says the rule (the
 * describe around it) and the file and line, and the builder fixes it in
 * one run. A tree with no breach is the one green test named `clean`.
 */

import { test } from "bun:test";

export function breaches(clean: string, found: readonly string[]): void {
  if (found.length === 0) {
    test(clean, () => {});
    return;
  }
  for (const breach of found)
    test(breach, () => {
      throw new Error(`${clean}: ${breach}`);
    });
}
