/**
 * Retention for `deploy_pull` (#12009, part of #11973): the table is an
 * index over git (`core/carried.ts`), so it keeps only what pages read
 * often — the pulls of deploys from the last `DEPLOY_PULL_KEEP_DAYS` days,
 * and of the deploy each app is running now (live, or sleeping and woken
 * on it: the newest successful production deploy of its repository). An
 * older deploy's list is rebuilt from git when it is asked for
 * (`carriedFor`).
 *
 * The rule runs in capped batches, one per crew tick while rows remain:
 * the candidates are read first (a read holds no write lock under WAL),
 * then deleted by rowid in one short transaction, so no batch holds the
 * write lock for long. Rows of a deleted run are not swept here: finding
 * them is a scan of the whole table.
 */

import type { Database } from "bun:sqlite";
import { transact } from "../kernel/db.ts";

/** Deploys this recent keep their rows. Above `PILLAR_DAYS` (7), the window ask-to-live reads. */
export const DEPLOY_PULL_KEEP_DAYS = 14;
/** The least time between two slices of one pass. */
const DEPLOY_PULL_PACE_MS = 5_000;

export interface Pruned {
  readonly deleted: number;
  /** A full batch went: another may follow on the next tick. */
  readonly more: boolean;
}

/** Rows one batch reads at most; what it deletes is those of them past the rule. */
const DEPLOY_PULL_SCAN = 500;

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
): Pruned & { readonly next: number } {
  const cap = Math.max(0, Math.floor(rowCap));
  if (cap === 0) return { deleted: 0, more: false, next: after };
  const slice = db
    .query<{ rid: number; run_id: string }, [number, number]>(
      "SELECT rowid AS rid, run_id FROM deploy_pull WHERE rowid > ?1 ORDER BY rowid LIMIT ?2",
    )
    .all(after, cap);
  if (slice.length === 0) return { deleted: 0, more: false, next: 0 };
  const cutoff = new Date(now.getTime() - DEPLOY_PULL_KEEP_DAYS * 86_400_000).toISOString();
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
  const rowids = slice.filter((row) => old.has(row.run_id)).map((row) => row.rid);
  const remove = db.query("DELETE FROM deploy_pull WHERE rowid = ?1");
  const deleted =
    rowids.length === 0
      ? 0
      : transact(db, () => {
          let n = 0;
          for (const rid of rowids) n += remove.run(rid).changes;
          return n;
        });
  const whole = slice.length === cap;
  return { deleted, more: whole, next: whole ? slice[slice.length - 1]!.rid : 0 };
}

/**
 * The crew tick's view of the rule: a batch on each tick while the last one
 * was full, and otherwise one an hour. Returns the batch's result, or
 * undefined when this tick runs none.
 */
export function deployRetention(
  db: Database,
  every: number = 60 * 60_000,
): (now?: Date) => Pruned | undefined {
  let more = true;
  let last = 0;
  let after = 0;
  return (now = new Date()) => {
    // Mid-pass, one slice at most every `DEPLOY_PULL_PACE_MS`; a finished pass waits `every`.
    if (now.getTime() - last < (more ? DEPLOY_PULL_PACE_MS : every)) return undefined;
    last = now.getTime();
    const result = pruneDeploys(db, now, DEPLOY_PULL_SCAN, after);
    more = result.more;
    after = result.next;
    return result;
  };
}
