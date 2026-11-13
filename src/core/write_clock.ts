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
 * Telemetry is not a write the pages can show: route timings, usage counts,
 * flag reads, a session's last-seen time, page vitals, samples. They land
 * on this connection every second or so and would keep every cache cold
 * forever (#7896), so the writers that only record how the forge is used
 * run inside `quietly`, and the stamp does not count their rows. A page
 * that shows telemetry is bounded by its cache's age (30 s), not by the clock.
 *
 * With the engine on a thread of its own (`engine/`) there are two connections
 * on the file, and what `data_version` says is exact and no more: a number per
 * connection that changes when ANOTHER connection commits, and never for this
 * connection's own commits (those are `total_changes`). It is a changed-since-
 * you-last-looked mark, not a count: many commits between two reads move it
 * once. So the stamp stays correct as it is, and every commit of the other
 * thread is a meaningful one. Two rules keep it so (test/write-clock-split.test.ts):
 *
 *   - a cache reads the stamp BEFORE it computes, never after: the other thread
 *     commits while this one computes, and a stamp read afterwards would label a
 *     value built from the older rows with the newer clock;
 *   - telemetry the stamp must leave out is written on THIS connection, in
 *     `quietly`: it is this connection's ledger, and a commit of the other
 *     connection's cannot be told from a meaningful one (counting them does not
 *     work, since `data_version` does not count). The engine's telemetry is
 *     therefore posted to the serving thread to write, not written; today it
 *     writes none (the machine samples' retention stays with the sampler).
 *
 * Inside an open transaction there is no stamp: a rolled-back write leaves
 * `total_changes` where it went, so a value read mid-transaction could
 * outlive the rows it saw.
 */

import type { Database } from "bun:sqlite";

const quiet = new WeakMap<Database, number>();

const changesOf = (db: Database): number =>
  db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n ?? 0;

/**
 * Run a telemetry write: the rows it changes (kept or rolled back) are left
 * out of the stamp. Wrap only statements that touch tables no cached page
 * is built from; anything else written inside would go unseen by the caches.
 */
export function quietly<T>(db: Database, write: () => T): T {
  const before = changesOf(db);
  try {
    return write();
  } finally {
    quiet.set(db, (quiet.get(db) ?? 0) + changesOf(db) - before);
  }
}

/** The forge's write clock now, or undefined inside a transaction (cache nothing). */
export function writeStamp(db: Database): string | undefined {
  if (db.inTransaction) return undefined;
  const row = db
    .query<{ n: number; v: number }, []>(
      "SELECT total_changes() AS n, (SELECT data_version FROM pragma_data_version) AS v",
    )
    .get();
  return row === null ? undefined : `${row.v}.${row.n - (quiet.get(db) ?? 0)}`;
}
