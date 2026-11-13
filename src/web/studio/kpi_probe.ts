/**
 * Every home number against its source: what the tile shows now (the cached
 * figures, up to `HOME_TTL_MS` old, the same words the row renders), one
 * sentence of what it counts (`KPI_COUNTS`), and its raw inputs read again past
 * the home cache. `agrees` compares the tile with that recomputation, so a
 * false one right after a change is the cache's age; a false one that stays is
 * a claim to look at. Admin only: the figures add up private repositories.
 *
 * Where a figure is a query, the probe asks its own: nearest-rank as OFFSET in
 * SQL rather than `p75`, each day's visitors counted one day at a time. Shipped,
 * spend, backup and bugs read their one reader fresh, since a second copy of
 * those rules would only drift. Traffic compares the minute ledger with a scan
 * of the samples: a route past `MAX_SAMPLES` is thinned, which makes the scan
 * read low (the ledger stays exact), and the sample's route must be recorded.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../../app.ts";
import { spentTodayEverywhere } from "../../crew/autonomy.ts";
import { idleReason } from "../../crew/idle_reason.ts";
import { countBugs } from "../../flow/bugs.ts";
import { forgeCeiling } from "../../flow/ceiling.ts";
import {
  firstLandings,
  readBackup,
  readBuilders,
  type Kpis,
} from "../../flow/kpis.ts";
import {
  KPI_COUNTS,
  backupValue,
  buildersValue,
  checkTime,
  shippedValue,
  speedWords,
  spendValue,
  trafficValue,
  usersValue,
  visitorsValue,
} from "../../flow/kpi_words.ts";
import { HOURS, median } from "../../flow/throughput.ts";
import { perfRecord } from "../../perf/live.ts";
import { scanTraffic, type PerfRecord } from "../../perf/record.ts";
import { TRAFFIC_CLASSES } from "../../perf/traffic.ts";
import { HOME_TTL_MS, cachedKpis } from "./home_cache.ts";
import { liveNow } from "./kpi_row.ts";

const DAY_MS = 86_400_000;

export interface ProbedNumber {
  readonly id: keyof typeof KPI_COUNTS;
  readonly label: string;
  /** What the tile shows. */
  readonly value: string;
  readonly counts: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  /** The tile's figure, from `inputs`. */
  readonly recomputed: string;
  readonly agrees: boolean;
}

export interface KpiProbe {
  readonly as_of: string;
  readonly tile_cache_seconds: number;
  readonly numbers: readonly ProbedNumber[];
}

/** Nearest rank at 75% of a `page_vital` column since `fromDay`, in SQL. */
function rankInSql(
  db: Database,
  column: "load" | "inp",
  fromDay: string,
): { rows: number; p75: number | null } {
  const rows =
    db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(${column}) AS n FROM page_vital WHERE day >= ?1`)
      .get(fromDay)?.n ?? 0;
  if (rows === 0) return { rows, p75: null };
  const at = db
    .query<
      { v: number },
      [string, number]
    >(`SELECT ${column} AS v FROM page_vital WHERE day >= ?1 AND ${column} IS NOT NULL ORDER BY ${column} LIMIT 1 OFFSET ?2`)
    .get(fromDay, Math.ceil(rows * 0.75) - 1);
  return { rows, p75: at?.v ?? null };
}

export function probeKpis(
  db: Database,
  now: Date,
  shown: {
    readonly kpis: Kpis;
    readonly live: { readonly sha: string; readonly at: string } | null;
  },
  forge: { readonly ceilingUsd: number | null; readonly dataDir?: string },
  record: PerfRecord,
): KpiProbe {
  const k = shown.kpis;
  const end = now.getTime();
  const to = now.toISOString();
  const today = to.slice(0, 10);
  const since = new Date(end - HOURS * 3_600_000).toISOString();
  const weekFrom = new Date(end - 6 * DAY_MS).toISOString().slice(0, 10);

  const landings = firstLandings(db, since, to).length;
  const deploy = db
    .query<{ sha: string; at: string }, [string]>(
      `SELECT commit_oid AS sha, serving_at AS at FROM run INDEXED BY run_live
        WHERE kind = 'deploy' AND env = 'production' AND serving_at IS NOT NULL AND serving_at <= ?1
        ORDER BY serving_at DESC LIMIT 1`,
    )
    .get(to);
  const checks = db
    .query<{ ms: number; state: string }, [string, string]>(
      `SELECT (julianday(finished_at) - julianday(started_at)) * 86400000.0 AS ms, state FROM run
        WHERE kind = 'check' AND state IN ('ok','failed') AND started_at IS NOT NULL
          AND finished_at >= ?1 AND finished_at <= ?2`,
    )
    .all(since, to);
  const medianMs = median(checks.map((c) => Math.round(c.ms)));
  const builders = readBuilders(db);
  const spentUsd = spentTodayEverywhere(db, now);
  const backup = readBackup(db, forge.dataDir, end);
  const bugs = countBugs(db, now);

  const perDay = db
    .query<
      { day: string; browsers: number; reports: number },
      [string, string]
    >("SELECT day, COUNT(DISTINCT visitor) AS browsers, COUNT(*) AS reports FROM page_vital WHERE day >= ?1 AND day <= ?2 GROUP BY day ORDER BY day")
    .all(weekFrom, today);
  const browsersToday = perDay.find((d) => d.day === today)?.browsers ?? 0;
  const seenToday =
    db
      .query<
        { n: number },
        [string]
      >("SELECT COUNT(DISTINCT user_id) AS n FROM session WHERE last_seen_at >= ?1")
      .get(`${today}T00:00:00Z`)?.n ?? 0;
  const accountRows =
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM user").get()?.n ?? 0;
  const load = rankInSql(db, "load", weekFrom);
  const inp = rankInSql(db, "inp", weekFrom);

  const ledger = record.ledger.totals(end);
  const samples = scanTraffic(record, ledger.since, end);
  const scanned = {
    requests: TRAFFIC_CLASSES.reduce((n, c) => n + samples[c].requests, 0),
    ms: TRAFFIC_CLASSES.reduce((n, c) => n + samples[c].ms, 0),
    classes: samples,
  };
  const rounded = (
    c: Record<string, { requests: number; ms: number; refused: number }>,
  ) =>
    Object.fromEntries(
      Object.entries(c).map(([name, v]) => [
        name,
        { requests: v.requests, ms: Math.round(v.ms), refused: v.refused },
      ]),
    );

  const number = (
    id: ProbedNumber["id"],
    label: string,
    value: string,
    recomputed: string,
    inputs: ProbedNumber["inputs"],
  ): ProbedNumber => ({
    id,
    label,
    value,
    counts: KPI_COUNTS[id],
    inputs,
    recomputed,
    agrees: value === recomputed,
  });

  return {
    as_of: to,
    tile_cache_seconds: HOME_TTL_MS / 1000,
    numbers: [
      number(
        "shipped",
        "Shipped per hour",
        shippedValue(k.landed, k.landedHours.length),
        shippedValue(landings, HOURS),
        { changes_in_24h: landings, hours: HOURS },
      ),
      number(
        "live",
        "Live version",
        shown.live?.sha ?? "—",
        shown.live?.sha ?? "—",
        {
          running_commit: shown.live?.sha ?? null,
          booted_at: shown.live?.at ?? null,
          newest_production_deploy: deploy ?? null,
        },
      ),
      number(
        "checks",
        "Median check time",
        checkTime(k.medianCheckMs),
        checkTime(medianMs),
        {
          checks_finished_in_24h: checks.length,
          failed: checks.filter((c) => c.state === "failed").length,
          median_ms: medianMs,
        },
      ),
      number(
        "builders",
        "Builders running",
        buildersValue(k.builders),
        buildersValue(builders),
        { agent_runs_running: builders.running, slots: builders.slots },
      ),
      number(
        "spend",
        "Crew spend today",
        spendValue(k.spend),
        spendValue({ todayUsd: spentUsd, ceilingUsd: forge.ceilingUsd }),
        { spent_today_usd: spentUsd, ceiling_usd: forge.ceilingUsd },
      ),
      number(
        "backup",
        "Last off-box backup",
        backupValue(k, now),
        backupValue(backup, now),
        {
          newest_off_box_at: backup.backupAt,
          verdict: backup.backup?.state ?? null,
        },
      ),
      number(
        "bugs",
        "Open bugs",
        String(k.bugs?.open ?? 0),
        String(bugs.open),
        { open: bugs.open, overdue: bugs.overdue },
      ),
      number(
        "traffic",
        "Traffic, 15 min",
        trafficValue(ledger),
        trafficValue(scanned),
        {
          window_from: new Date(ledger.since).toISOString(),
          ledger: rounded(
            ledger.classes as Record<
              string,
              { requests: number; ms: number; refused: number }
            >,
          ),
          samples: rounded(samples),
          addresses_estimated: ledger.addresses,
          addresses_note:
            "Estimated from a salted sketch: no address is kept, so this one can't be recomputed.",
        },
      ),
      number(
        "visitors",
        "Reporting browsers",
        visitorsValue(k.reach),
        visitorsValue({ ...k.reach, visitorsToday: browsersToday }),
        {
          day: today,
          browsers_today: browsersToday,
          by_day: perDay,
          browsers_summed_7d: perDay.reduce((n, d) => n + d.browsers, 0),
        },
      ),
      number(
        "accounts",
        "Accounts",
        usersValue(k.reach),
        usersValue({
          ...k.reach,
          usersToday: seenToday,
          usersTotal: accountRows,
        }),
        { sessions_seen_today: seenToday, user_rows: accountRows },
      ),
      number(
        "speed",
        "Reported page speed",
        speedWords(k.reach.loadP75),
        speedWords(load.p75),
        {
          views_with_load_7d: load.rows,
          load_p75_ms: load.p75,
          views_with_inp_7d: inp.rows,
          inp_p75_ms: inp.p75,
          tile_inp_p75_ms: k.reach.inpP75,
          from_day: weekFrom,
        },
      ),
    ],
  };
}

/** The probe of this forge, against what home is showing now. */
export function kpiProbe(app: App, now: Date = new Date()): KpiProbe {
  const ceilingUsd = forgeCeiling(app.config);
  const forge = {
    ceilingUsd,
    dataDir: app.config.dataDir,
    idle: () => idleReason(app, now),
  };
  return probeKpis(
    app.db,
    now,
    { kpis: cachedKpis(app.db, now, forge), live: liveNow() },
    forge,
    perfRecord,
  );
}
