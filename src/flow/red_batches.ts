/**
 * The red-batch rate (#6427, a flow vital of #5930): of the merge-queue
 * batches judged in the last 6 h, how many went red. A rising rate is the
 * first sign of a CI lockup.
 *
 * A batch is one candidate the queue judged (`checks/queue.ts` `onBatch`):
 * a red batch's bisection prefixes and its head gated alone are its search,
 * not batches of their own, and a pull check is never one. Forge-wide for
 * the owner, public repositories alone for an agent — the rule `readVitals`
 * keeps. Nothing reads it yet.
 */

import type { Database } from "bun:sqlite";

const HOUR_MS = 3_600_000;

/** The window the rate is read over. */
export const RED_BATCH_WINDOW_MS = 6 * HOUR_MS;

/** How long a verdict is kept: a week, well past the window. */
const KEEP_MS = 7 * 24 * HOUR_MS;

export interface RedBatches {
  readonly finished: number;
  readonly red: number;
  /** red / finished; null when nothing finished. */
  readonly rate: number | null;
}

/** Keep one batch's verdict, and let verdicts past a week go. */
export function keepBatch(db: Database, repoId: string, red: boolean, now = new Date()): void {
  db.query(`INSERT INTO queue_batch (repo_id, red, finished_at) VALUES (?1, ?2, ?3)`).run(
    repoId,
    red ? 1 : 0,
    now.toISOString(),
  );
  db.query(`DELETE FROM queue_batch WHERE finished_at < ?1`).run(
    new Date(now.getTime() - KEEP_MS).toISOString(),
  );
}

/** `publicOnly` counts public repositories alone, for a reader who must not learn what private ones hold. */
export function readRedBatches(db: Database, now = new Date(), publicOnly = false): RedBatches {
  const row = db
    .query<{ finished: number; red: number | null }, [string, string, number]>(
      `SELECT COUNT(*) AS finished, SUM(b.red) AS red
         FROM queue_batch b JOIN repo r ON r.id = b.repo_id
        WHERE (?3 = 0 OR r.visibility = 'public') AND b.finished_at >= ?1 AND b.finished_at <= ?2`,
    )
    .get(new Date(now.getTime() - RED_BATCH_WINDOW_MS).toISOString(), now.toISOString(), publicOnly ? 1 : 0);
  const finished = row?.finished ?? 0;
  const red = row?.red ?? 0;
  return { finished, red, rate: finished === 0 ? null : red / finished };
}
