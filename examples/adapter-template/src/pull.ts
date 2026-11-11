/**
 * One pull: read the page after the stored cursor, write what is new, move
 * the cursor, and answer the four counts the forge records
 * (docs/ADAPTERS.md).
 *
 * Records and the cursor are written in one transaction, so the cursor
 * never runs ahead of the records it covers. A pull from the same cursor
 * reads the same page, finds every record held, and counts them `skipped`.
 */

import { isCursor, parseRecord, type Page } from "./source.ts";
import type { Store } from "./store.ts";

export interface PullResult {
  readonly pulled: number;
  readonly skipped: number;
  readonly cursor: string;
  readonly errors: number;
}

/** The upper bound the forge accepts for each count. */
const COUNT_MAX = 1_000_000;

export async function pull(
  store: Store,
  read: (cursor: string) => Promise<Page>,
): Promise<PullResult> {
  const from = store.cursor();
  const page = await read(from);
  const records = page.records.slice(0, COUNT_MAX);
  const cursor = isCursor(page.cursor) ? page.cursor : from;
  return store.atomically(() => {
    let pulled = 0;
    let skipped = 0;
    let errors = 0;
    for (const raw of records) {
      const record = parseRecord(raw);
      if (record === undefined) errors++;
      else if (store.put(record)) pulled++;
      else skipped++;
    }
    store.setCursor(cursor);
    return { pulled, skipped, cursor, errors };
  });
}
