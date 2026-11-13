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
/** Rows one batch deletes at most. */
export const DEPLOY_PULL_BATCH = 5_000;

export interface Pruned {
  readonly deleted: number;
  /** A full batch went: another may follow on the next tick. */
  readonly more: boolean;
}

/** Delete one batch of at most `rowCap` rows of deploys past the rule. */
export function pruneDeploys(
  db: Database,
  now: Date = new Date(),
  rowCap: number = DEPLOY_PULL_BATCH,
): Pruned {
  const cap = Math.max(0, Math.floor(rowCap));
  if (cap === 0) return { deleted: 0, more: false };
  const cutoff = new Date(now.getTime() - DEPLOY_PULL_KEEP_DAYS * 86_400_000).toISOString();
  const rowids = db
    .query<{ rid: number }, [string, number]>(
      `WITH running AS (
         SELECT (SELECT r.id FROM run r
                  WHERE r.repo_id = app.repo_id AND r.kind = 'deploy'
                    AND r.env = 'production' AND r.state = 'ok'
                  ORDER BY COALESCE(r.serving_at, r.finished_at) DESC, r.id DESC
                  LIMIT 1) AS id
           FROM app
       )
       SELECT dp.rowid AS rid
         FROM run r JOIN deploy_pull dp ON dp.run_id = r.id
        WHERE r.kind = 'deploy'
          AND COALESCE(r.serving_at, r.finished_at, r.created_at) < ?1
          AND r.id NOT IN (SELECT id FROM running WHERE id IS NOT NULL)
        LIMIT ?2`,
    )
    .all(cutoff, cap)
    .map((row) => row.rid);
  if (rowids.length === 0) return { deleted: 0, more: false };
  const remove = db.query("DELETE FROM deploy_pull WHERE rowid = ?1");
  const deleted = transact(db, () => {
    let n = 0;
    for (const rid of rowids) n += remove.run(rid).changes;
    return n;
  });
  return { deleted, more: rowids.length === cap };
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
  return (now = new Date()) => {
    if (!more && now.getTime() - last < every) return undefined;
    last = now.getTime();
    const result = pruneDeploys(db, now);
    more = result.more;
    return result;
  };
}
