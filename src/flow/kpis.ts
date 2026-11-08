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

import { backupVerdict, isWatched, type BackupVerdict } from "../snapshot/bucket.ts";
import { lastDrill } from "../snapshot/drills.ts";
import type { Database } from "bun:sqlite";
import { spentTodayEverywhere } from "../crew/autonomy.ts";
import { ceilingHitAt, ceilingReached } from "./ceiling.ts";
import type { IdleReason } from "../crew/idle_reason.ts";
import { lastOffBox } from "../snapshot/off_box.ts";
import { readReach, type Reach } from "./reach.ts";
import { countBugs, type BugCount } from "./bugs.ts";
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
  readonly builders: {
    readonly running: number;
    readonly slots: number;
    /** Why none is starting anything now (`idleReason`); null while every slot is busy or no reason is known. */
    readonly idle: IdleReason | null;
  };
  /** What the crew's runs cost since UTC midnight, and the forge's daily ceiling (null: none set). */
  readonly spend: { readonly todayUsd: number; readonly ceilingUsd: number | null; /** When the run that crossed the cap was created (ISO); null while under it. */ readonly hitAt?: string | null };
  /** When a snapshot was last known off the machine (a bucket destination or the mirror, `off_box.ts`); null when never. */
  readonly backupAt: string | null;
  /** Open bugs, and those past their clock (`bugs.ts`). */
  readonly bugs?: BugCount;
  /** The verdict on what is in the bucket, read by this process (`snapshot/bucket.ts`); null when the forge is not watching one. */
  readonly backup?: BackupVerdict | null;
  /** Accounts, visitors and page speed (`reach.ts`). */
  readonly reach: Reach;
}

/** The parts `readKpis` names to its `time` callback, in the order it runs them. */
export const KPI_PARTS = ["kpis.landed", "kpis.live", "kpis.checks", "kpis.builders", "kpis.spend", "kpis.reach", "kpis.backup", "kpis.bugs"] as const;
export type KpiPart = (typeof KPI_PARTS)[number];
export type KpiTimer = <T>(name: KpiPart, fn: () => T) => T;

const untimed: KpiTimer = (_name, fn) => fn();

/** Every slot is taken: no reason to name. One rule, for the fresh read and home's cached one. */
export function slotsBusy(b: { readonly running: number; readonly slots: number }): boolean {
  return b.slots > 0 && b.running >= b.slots;
}

/** Crew builders running now, of the autonomous repositories' slots: one cheap query, so home reads the counts fresh (#7624). `idle` is the reason the caller already has. */
export function readBuilders(db: Database, idle: IdleReason | null = null): Kpis["builders"] {
  const counts =
    db
      .query<{ running: number; slots: number }, []>(
        `SELECT (SELECT COUNT(*) FROM run WHERE kind = 'agent' AND state = 'running') AS running,
                (SELECT COALESCE(SUM(autonomy_slots), 0) FROM repo WHERE autonomy != 'off') AS slots`,
      )
      .get() ?? { running: 0, slots: 0 };
  return { ...counts, idle };
}

/**
 * When each landing in [since, to] put something new on main. A pull counts
 * when it merged onto its repository's default branch with a commit other
 * than its base, and no pull of that repository merged the same commit
 * earlier (by `merged_at`, then `issue_id`) — at any time, not only today.
 *
 * One pass (#7627): every merged pull whose commit some landing in the window
 * carries, read once, and the first per (repo, commit) kept here. A per-row
 * `NOT EXISTS` over every pull cost seconds on a production-size forge.
 */
export function firstLandings(db: Database, since: string, to: string): string[] {
  const rows = db
    .query<{ repo: string; oid: string; at: string; issue: string; landing: number }, [string, string]>(
      `SELECT i.repo_id AS repo, q.merged_oid AS oid, q.merged_at AS at, q.issue_id AS issue,
              (q.base_branch = r.default_branch AND q.merged_at >= ?1
                AND q.carried = 0 AND q.merged_oid != q.base_oid) AS landing
         FROM pull q JOIN issue i ON i.id = q.issue_id JOIN repo r ON r.id = i.repo_id
        WHERE q.merged_at IS NOT NULL AND q.merged_at <= ?2
          AND q.merged_oid IN (
            SELECT merged_oid FROM pull
             WHERE merged_at >= ?1 AND merged_at <= ?2 AND merged_oid IS NOT NULL AND merged_oid != '')`,
    )
    .all(since, to);
  const first = new Map<string, { at: string; issue: string }>();
  for (const row of rows) {
    const key = `${row.repo}\0${row.oid}`;
    const seen = first.get(key);
    if (!seen || row.at < seen.at || (row.at === seen.at && row.issue < seen.issue)) first.set(key, row);
  }
  const out: string[] = [];
  for (const row of rows) {
    if (!row.landing) continue;
    const seen = first.get(`${row.repo}\0${row.oid}`)!;
    if (row.at === seen.at && row.issue === seen.issue) out.push(row.at);
  }
  return out;
}

/** The bucket's verdict where one is watched; a job's own report only where nothing watches. */
export function readBackup(db: Database, dataDir: string | undefined, end: number): { backup: BackupVerdict | null; backupAt: string | null } {
  const backup = dataDir !== undefined && isWatched(dataDir) ? backupVerdict(dataDir, lastDrill(db), end) : null;
  return { backup, backupAt: backup !== null ? backup.newestAt : dataDir === undefined ? null : lastOffBox(dataDir) };
}

export function readKpis(
  db: Database,
  now: Date,
  forge: {
    readonly ceilingUsd: number | null;
    readonly dataDir?: string;
    /** Why builders are idle, asked inside the builders part; left out, no reason is named. */
    readonly idle?: () => IdleReason | null;
  } = { ceilingUsd: null },
  time: KpiTimer = untimed,
): Kpis {
  const end = now.getTime();
  const to = now.toISOString();
  const since = new Date(end - HOURS * HOUR_MS).toISOString();

  const landedHours = new Array<number>(HOURS).fill(0);
  const landings = time("kpis.landed", () => firstLandings(db, since, to));
  for (const at of landings) {
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

  const builders = time("kpis.builders", () => {
    const counts = readBuilders(db);
    return slotsBusy(counts) ? counts : { ...counts, idle: forge.idle?.() ?? null };
  });

  const spend = time("kpis.spend", () => {
    const todayUsd = spentTodayEverywhere(db, now);
    return { todayUsd, ceilingUsd: forge.ceilingUsd, hitAt: ceilingReached(todayUsd, forge.ceilingUsd) ? ceilingHitAt(db, now, forge.ceilingUsd) : null };
  });

  const reach = time("kpis.reach", () => readReach(db, now));

  // Read from the bucket when it is watched; a job's own report only where nothing watches.
  const { backup, backupAt } = time("kpis.backup", () => readBackup(db, forge.dataDir, end));

  const bugs = time("kpis.bugs", () => countBugs(db, now));

  return {
    bugs,
    backupAt,
    backup,
    builders,
    reach,
    spend,
    landedHours,
    landed: landedHours.reduce((a, b) => a + b, 0),
    live: live ?? null,
    medianCheckMs: median(spans),
  };
}
