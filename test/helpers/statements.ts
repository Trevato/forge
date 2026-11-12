/**
 * Count the SQL statements a block of work runs, the same way every time.
 *
 * `db.query` is the one door every read and write goes through, so wrapping it
 * counts statements without threading a counter through the code under test.
 * But a server in the same process shares that door with everything else it
 * does: the standing sweep, an earlier request's fire-and-forget work, an
 * event handler that lands late. That noise is only ever *added* to a count,
 * and it is the whole reason two runs of one test disagreed (108 vs 158,
 * #1799). So:
 *
 *  - `quiet` waits until nothing has touched the database for a moment, so a
 *    measurement starts from rest rather than in the tail of the last step;
 *  - `statements` measures the work several times and keeps the smallest. A
 *    real N+1 costs more in every run, so the minimum still shows it; noise
 *    costs more in some runs, so the minimum drops it.
 *
 * The waits read `performance.now()`, never `Date.now()`: a test file earlier in
 * the same process that leaves the wall clock frozen (`setSystemTime`, a spy)
 * would otherwise stop `quiet` ever seeing time pass and hang the test for its
 * whole timeout (#9299: 60 s, on three pulls, only beside other files).
 *
 * `work` must be repeatable: a request for the same page, not a mutation.
 */

import type { Database } from "bun:sqlite";

const QUIET_MS = 40;
const GIVE_UP_MS = 2_000;
const RUNS = 5;

type Door = { query: unknown };

/** Run `work` once with the statement counter on; return what it cost. */
export async function once(
  db: Database,
  work: () => Promise<void> | void,
): Promise<number> {
  const door = db as unknown as Door;
  const original = db.query.bind(db);
  let count = 0;
  door.query = (sql: string) => {
    count++;
    return original(sql);
  };
  try {
    await work();
  } finally {
    door.query = original;
  }
  return count;
}

/** Resolve once no statement has run for `QUIET_MS` (or after `GIVE_UP_MS`). */
export async function quiet(db: Database): Promise<void> {
  const door = db as unknown as Door;
  const original = db.query.bind(db);
  let last = performance.now();
  door.query = (sql: string) => {
    last = performance.now();
    return original(sql);
  };
  try {
    const started = performance.now();
    for (;;) {
      const now = performance.now();
      if (now - last >= QUIET_MS || now - started >= GIVE_UP_MS) break;
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS / 4));
    }
  } finally {
    door.query = original;
  }
}

/** The fewest statements `work` costs over several runs from rest. */
export async function statements(
  db: Database,
  work: () => Promise<void> | void,
  runs: number = RUNS,
): Promise<number> {
  let fewest = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run++) {
    await quiet(db);
    fewest = Math.min(fewest, await once(db, work));
  }
  return fewest;
}
