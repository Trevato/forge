/**
 * Retention for `deploy_pull` (#12009, part of #11973): the old per-deploy
 * ledger of which merged pulls each production deploy carried. Nothing writes
 * it any more: what a deploy carries is a fact of git (`core/carried.ts`,
 * walked when a page asks and kept in memory), and when each pull first went
 * live is one row per pull in `deploy_landed`. The rows an older release wrote
 * are trimmed here, in slices, to those of the deploys of the last
 * `DEPLOY_PULL_KEEP_DAYS` days and of the deploy each app is running now (live,
 * or sleeping and woken on it: the newest successful production deploy of its
 * repository), and the table is dropped in a later release.
 *
 * The rule starts only once `deploy_landed` has been filled from the rows
 * about to go (`ready`, `backfillLanded` in `core/carried.ts`).
 *
 * A slice reads `DEPLOY_PULL_SCAN` rows by rowid, looks up the few distinct
 * runs they name once, and deletes the old ones by rowid in one short
 * transaction, so the work of a slice is bounded by the cap whatever the table
 * holds; `retention.ts` paces the slices so they take a tenth of the thread at
 * most. Rows of a deleted run are not swept here: finding them is a scan of the
 * whole table.
 */

import type { Database } from "bun:sqlite";
import { transact } from "../kernel/db.ts";

/**
 * Deploys this recent keep their rows, by default; an admin moves it with the
 * `retention.deploy_pull_days` limit (`settings/limits.ts`). It was 14 and
 * floored at 7, the window ask-to-live read from the rows; that reads
 * `deploy_landed` now, so a day is what a page that has not walked git yet may find.
 */
export const DEPLOY_PULL_KEEP_DAYS = 1;

export interface Pruned {
  readonly deleted: number;
  /** A full batch went: another may follow on the next tick. */
  readonly more: boolean;
}

/**
 * Rows one slice reads at most; what it deletes is those of them past the rule. 250 rows
 * took 15 ms at the median on a copy of production (62 µs a row: the table, its key index and
 * the issue index, whose entries for one deploy are 2,500 leaves apart).
 */
export const DEPLOY_PULL_SCAN = 250;
/**
 * The time a slice may spend deleting before it hands the thread back, and the rows it deletes between
 * looks at the clock. On a copy of production a 250-row slice took 3 ms at the median, 34 at the 99th
 * percentile and 136 at the worst (a leaf not yet read: the issue index's entries for one deploy lie
 * 2,500 pages apart); checked every 10 rows, no slice goes past the budget by more than 10 rows' cost.
 */
export const DEPLOY_PULL_SLICE_MS = 10;
const DEPLOY_PULL_CHUNK = 10;

/**
 * Delete the rows past the rule among the next `rowCap` rows after `after`
 * (by rowid), and say where the next batch starts.
 *
 * The first form asked SQLite for "5,000 rows of old deploys" by joining
 * every deploy run to its rows; on production's 9.9M rows each batch held
 * the forge's one thread for 2.5 to 3.8 s, back to back (2026-11-13). This
 * one walks the table in rowid order a slice at a time: a slice is read by
 * primary key, its few distinct runs are looked up once, and the work of a
 * batch is bounded by `rowCap` whatever the table holds.
 */
export function pruneDeploys(
  db: Database,
  now: Date = new Date(),
  rowCap: number = DEPLOY_PULL_SCAN,
  after = 0,
  keepDays: number = DEPLOY_PULL_KEEP_DAYS,
  budgetMs: number = DEPLOY_PULL_SLICE_MS,
): Pruned & { readonly next: number } {
  const cap = Math.max(0, Math.floor(rowCap));
  if (cap === 0) return { deleted: 0, more: false, next: after };
  const slice = db
    .query<{ rid: number; run_id: string }, [number, number]>(
      "SELECT rowid AS rid, run_id FROM deploy_pull WHERE rowid > ?1 ORDER BY rowid LIMIT ?2",
    )
    .all(after, cap);
  if (slice.length === 0) return { deleted: 0, more: false, next: 0 };
  const cutoff = new Date(now.getTime() - keepDays * 86_400_000).toISOString();
  const runIds = [...new Set(slice.map((row) => row.run_id))];
  const old = new Set<string>();
  const isOld = db.query<{ id: string; repo_id: string }, [string, string]>(
    `SELECT r.id, r.repo_id FROM run r
      WHERE r.id = ?1 AND r.kind = 'deploy' AND COALESCE(r.serving_at, r.finished_at, r.created_at) < ?2`,
  );
  // The deploy an app is serving keeps its rows however old it is.
  const serving = db.query<{ id: string }, [string]>(
    `SELECT r.id FROM run r
      WHERE r.repo_id = ?1 AND r.kind = 'deploy' AND r.env = 'production' AND r.state = 'ok'
        AND EXISTS (SELECT 1 FROM app a WHERE a.repo_id = r.repo_id)
      ORDER BY COALESCE(r.serving_at, r.finished_at) DESC, r.id DESC LIMIT 1`,
  );
  const servingOf = new Map<string, string | undefined>();
  for (const id of runIds) {
    const run = isOld.get(id, cutoff);
    if (run === null) continue;
    if (!servingOf.has(run.repo_id)) servingOf.set(run.repo_id, serving.get(run.repo_id)?.id);
    if (servingOf.get(run.repo_id) !== id) old.add(id);
  }
  const remove = db.query("DELETE FROM deploy_pull WHERE rowid = ?1");
  // Walk the slice in order, deleting what is old, and look at the clock between chunks of rows: a slice
  // that runs out of its budget ends where it is, and the next one starts after the last row it passed.
  const started = performance.now();
  let deleted = 0;
  let passed = 0;
  transact(db, () => {
    while (passed < slice.length) {
      const end = Math.min(slice.length, passed + DEPLOY_PULL_CHUNK);
      for (; passed < end; passed++) {
        const row = slice[passed]!;
        if (old.has(row.run_id)) deleted += remove.run(row.rid).changes;
      }
      if (performance.now() - started >= budgetMs) break;
    }
  });
  const whole = slice.length === cap || passed < slice.length;
  return { deleted, more: whole, next: whole ? slice[passed - 1]!.rid : 0 };
}

/**
 * The rule as a job's slice: one slice per call while the last one was full,
 * and after a pass reaches its end one a time `every` later (an hour). Returns
 * the slice's result, or undefined when this call runs none. `keepDays` is read
 * as each slice runs, so a changed setting governs the next slice; `ready` says
 * `deploy_landed` has what the rows hold, and nothing is deleted before it does.
 */
export function deployRetention(
  db: Database,
  every: number = 60 * 60_000,
  keepDays: () => number = () => DEPLOY_PULL_KEEP_DAYS,
  ready: () => boolean = () => true,
): (now?: Date) => Pruned | undefined {
  let more = true;
  let last = 0;
  let after = 0;
  return (now = new Date()) => {
    if (!ready()) return undefined;
    // A finished pass waits `every`; mid-pass the caller's pacing is the only wait.
    if (!more && now.getTime() - last < every) return undefined;
    last = now.getTime();
    const result = pruneDeploys(db, now, DEPLOY_PULL_SCAN, after, keepDays());
    more = result.more;
    after = result.next;
    return result;
  };
}
