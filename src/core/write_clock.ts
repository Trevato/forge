/**
 * The write clock: how a page cache knows, exactly, that what it holds may
 * be stale (#2675, docs/CACHING.md).
 *
 * Two numbers SQLite already keeps, read in one statement:
 *
 *   - `total_changes()` — every row this connection has inserted, updated
 *     or deleted since it opened, in any table, through any code path. The
 *     forge writes through one connection (`kernel/db.ts`), so a write that
 *     names no event, or that a future table adds, still moves it.
 *   - `PRAGMA data_version` — moves when *another* connection commits (the
 *     chaos worker, a person at the sqlite3 shell), which `total_changes`
 *     cannot see.
 *
 * Equal stamps mean nothing was written in between. The clock is forge-wide
 * on purpose: a finer one — per repository — would need either triggers,
 * which bun counts in a statement's `changes` and so would break every
 * compare-and-swap that checks `changes === 1`, or a promise that every
 * write names its repository in the outbox, which `issue_raise` and
 * `limb_place` writes do not. A coarse clock costs hit rate; a wrong one
 * would cost a stale page. We pay the first.
 *
 * Inside an open transaction there is no stamp: a rolled-back write leaves
 * `total_changes` where it went, so a value read mid-transaction could
 * outlive the rows it saw.
 */

import type { Database } from "bun:sqlite";

/** The forge's write clock now, or undefined inside a transaction (cache nothing). */
export function writeStamp(db: Database): string | undefined {
  if (db.inTransaction) return undefined;
  const row = db
    .query<{ n: number; v: number }, []>(
      "SELECT total_changes() AS n, (SELECT data_version FROM pragma_data_version) AS v",
    )
    .get();
  return row === null ? undefined : `${row.v}.${row.n}`;
}
