/**
 * The home page's three figures (#2870), as plain data: what landed on main
 * per hour over the last 24 hours, the version that is live and since when,
 * and the median check time over the same day.
 *
 * Hours are counted back from `now`, as in `throughput.ts`: bucket 0 is the
 * last hour, bucket 23 the one that ended 23 hours ago. Nothing here reads
 * the clock. One query per figure.
 *
 * `time`, when given, wraps each part so a caller can name what it cost
 * (`kpis.landed` … `kpis.backup`, #7626); left out, each part just runs.
 *
 * A landing counts when it put something on main. A pull that closed as
 * carried (its change was already there, #2036) lands no commit: its
 * `merged_oid` is the base it found, or a commit an earlier pull landed.
 * Those are not counted.
 */

import type { Database } from "bun:sqlite";
import { spentTodayEverywhere } from "../crew/autonomy.ts";
import { ceilingHitAt, ceilingReached } from "./ceiling.ts";
import { lastOffBox } from "../snapshot/off_box.ts";
import { readReach, type Reach } from "./reach.ts";
import { HOURS, median } from "./throughput.ts";

const HOUR_MS = 3_600_000;

export interface Kpis {
  /** Non-empty landings on a default branch per hour, bucket 0 the last hour. */
  readonly landedHours: readonly number[];
  /** The sum of `landedHours`. */
  readonly landed: number;
  /** The newest production deploy that serves, or null when none has. */
  readonly live: { readonly sha: string; readonly at: string } | null;
  /** Median check duration in milliseconds over checks that finished in 24 h; null for none. */
  readonly medianCheckMs: number | null;
  /** Crew builders running now, of the slots the autonomous repositories are set to. */
  readonly builders: { readonly running: number; readonly slots: number };
  /** What the crew's runs cost since UTC midnight, and the forge's daily ceiling (null: none set). */
  readonly spend: { readonly todayUsd: number; readonly ceilingUsd: number | null; /** When the run that crossed the cap was created (ISO); null while under it. */ readonly hitAt?: string | null };
  /** When a snapshot was last known off the machine (a bucket destination or the mirror, `off_box.ts`); null when never. */
  readonly backupAt: string | null;
  /** Accounts, visitors and page speed (`reach.ts`). */
  readonly reach: Reach;
}

/** The parts `readKpis` names to its `time` callback, in the order it runs them. */
export const KPI_PARTS = ["kpis.landed", "kpis.live", "kpis.checks", "kpis.builders", "kpis.spend", "kpis.reach", "kpis.backup"] as const;
export type KpiPart = (typeof KPI_PARTS)[number];
export type KpiTimer = <T>(name: KpiPart, fn: () => T) => T;

const untimed: KpiTimer = (_name, fn) => fn();

export function readKpis(
  db: Database,
  now: Date,
  forge: { readonly ceilingUsd: number | null; readonly dataDir?: string } = { ceilingUsd: null },
  time: KpiTimer = untimed,
): Kpis {
  const end = now.getTime();
  const to = now.toISOString();
  const since = new Date(end - HOURS * HOUR_MS).toISOString();

  const landedHours = new Array<number>(HOURS).fill(0);
  const landings = time("kpis.landed", () => db
    .query<{ at: string }, [string, string]>(
      `SELECT p.merged_at AS at
         FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
        WHERE p.base_branch = r.default_branch
          AND p.merged_at >= ?1 AND p.merged_at <= ?2
          AND p.merged_oid IS NOT NULL AND p.merged_oid != '' AND p.merged_oid != p.base_oid
          AND NOT EXISTS (
            SELECT 1 FROM pull q JOIN issue j ON j.id = q.issue_id
             WHERE j.repo_id = i.repo_id AND q.merged_oid = p.merged_oid
               AND (q.merged_at < p.merged_at OR (q.merged_at = p.merged_at AND q.issue_id < p.issue_id)))`,
    )
    .all(since, to));
  for (const { at } of landings) {
    const h = Math.floor((end - Date.parse(at)) / HOUR_MS);
    if (h >= 0 && h < HOURS) landedHours[h]! += 1;
  }

  const live = time("kpis.live", () => db
    .query<{ sha: string; at: string }, [string]>(
      `SELECT commit_oid AS sha, serving_at AS at FROM run
        WHERE kind = 'deploy' AND env = 'production' AND serving_at IS NOT NULL AND serving_at <= ?1
        ORDER BY serving_at DESC LIMIT 1`,
    )
    .get(to));

  const spans = time("kpis.checks", () => db
    .query<{ ms: number }, [string, string]>(
      `SELECT (julianday(finished_at) - julianday(started_at)) * 86400000.0 AS ms FROM run
        WHERE kind = 'check' AND state IN ('ok','failed') AND started_at IS NOT NULL
          AND finished_at >= ?1 AND finished_at <= ?2`,
    )
    .all(since, to)
    .map((r) => Math.round(r.ms)));

  const builders = time("kpis.builders", () => db
    .query<{ running: number; slots: number }, []>(
      `SELECT (SELECT COUNT(*) FROM run WHERE kind = 'agent' AND state = 'running') AS running,
              (SELECT COALESCE(SUM(autonomy_slots), 0) FROM repo WHERE autonomy != 'off') AS slots`,
    )
    .get() ?? { running: 0, slots: 0 });

  const spend = time("kpis.spend", () => {
    const todayUsd = spentTodayEverywhere(db, now);
    return { todayUsd, ceilingUsd: forge.ceilingUsd, hitAt: ceilingReached(todayUsd, forge.ceilingUsd) ? ceilingHitAt(db, now, forge.ceilingUsd) : null };
  });

  const reach = time("kpis.reach", () => readReach(db, now));

  const backupAt = time("kpis.backup", () => (forge.dataDir === undefined ? null : lastOffBox(forge.dataDir)));

  return {
    backupAt,
    builders,
    reach,
    spend,
    landedHours,
    landed: landedHours.reduce((a, b) => a + b, 0),
    live: live ?? null,
    medianCheckMs: median(spans),
  };
}
