/**
 * The forge's own families for `GET /metrics` (#3975, #3752, #3751): request
 * duration as a histogram per route pattern, the apps, up or not, with each
 * cell's CPU and memory as the watch last read them, and the checks and the
 * crew. The duration is read from the totals `route_timing` keeps in memory
 * since the process started, not from the hourly table, so every value only
 * grows (#4013): Prometheus reads a drop as a counter reset, and a restart
 * resets them, which it expects. The check histogram folds newly finished
 * checks into in-memory totals; the queue and the crew's runs and spend are
 * small queries, as are the delivery series (#4057), read from `pull`, `release`
 * (successful rows only) and the default branch's `run` rows. Nothing is started
 * or shelled out to read a figure. The text
 * comes from `openmetrics.ts`.
 */
import type { Database } from "bun:sqlite";
import type { CellCounter } from "../apps/contain.ts";
import type { EnvState } from "../apps/runtime.ts";
import { EDGES_MS, readTotals } from "../core/route_timing.ts";
import { closesFromBody } from "../core/pulls.ts";
import { telemetryReadsFamily } from "../system/telemetry_reads.ts";
import { loopWatch } from "../perf/live.ts";
import { stallFamilies } from "./stalls.ts";
import { openMetrics, type Family, type HistogramSample, type Sample } from "./openmetrics.ts";

export const DURATION_FAMILY = "forge_http_request_duration_seconds";

/** The duration histogram since the process started: cumulative buckets, in seconds. */
export function durationFamily(db: Database): Family {
  const samples: HistogramSample[] = [];
  for (const [pattern, t] of [...readTotals(db)].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let running = 0;
    const buckets = EDGES_MS.map((ms, i) => {
      running += t.counts[i] ?? 0;
      return { le: ms / 1000, count: running };
    });
    const count = running + (t.counts[EDGES_MS.length] ?? 0);
    samples.push({ labels: { pattern }, buckets, count, sum: t.sumUs / 1e6 });
  }
  return {
    type: "histogram",
    name: DURATION_FAMILY,
    help: "Seconds the forge took to answer a request, by route pattern, since the process started.",
    samples,
  };
}

/** Upper bounds, in seconds, of the check duration histogram. */
export const CHECK_EDGES_S: readonly number[] = [5, 15, 30, 60, 120, 300, 600, 1800];

/** What the check histogram has counted so far, per database: only ever added to. */
interface CheckTotals {
  mark: string;
  seen: Set<string>;
  counts: number[];
  count: number;
  sum: number;
}
const STARTED = new Date().toISOString();
const checkTotals = new WeakMap<Database, CheckTotals>();

/**
 * Check duration since the process started, started to finished, cumulative.
 * Each scrape folds in the checks finished since the last one, once each
 * (`mark` is the newest `finished_at` folded, `seen` its run ids), so nothing
 * ages out and the series only grows (#4013).
 */
export function checkDurationFamily(db: Database): Family {
  let t = checkTotals.get(db);
  if (!t) checkTotals.set(db, (t = { mark: STARTED, seen: new Set(), counts: CHECK_EDGES_S.map(() => 0), count: 0, sum: 0 }));
  const rows = db
    .query<{ id: string; at: string; s: number }, [string]>(
      `SELECT id, finished_at AS at, (julianday(finished_at) - julianday(started_at)) * 86400.0 AS s
         FROM run
        WHERE kind = 'check' AND state IN ('ok','failed')
          AND started_at IS NOT NULL AND finished_at >= ?1
        ORDER BY finished_at, id`,
    )
    .all(t.mark);
  for (const r of rows) {
    if (r.at > t.mark) {
      t.mark = r.at;
      t.seen.clear();
    }
    if (t.seen.has(r.id)) continue;
    t.seen.add(r.id);
    const secs = Math.max(0, r.s);
    t.sum += secs;
    t.count++;
    CHECK_EDGES_S.forEach((le, i) => {
      if (secs <= le) t!.counts[i]!++;
    });
  }
  return {
    type: "histogram",
    name: "forge_check_duration_seconds",
    help: "Seconds a repository check took from start to finish, since the process started.",
    samples: [{ buckets: CHECK_EDGES_S.map((le, i) => ({ le, count: t!.counts[i]! })), count: t.count, sum: t.sum }],
  };
}

/** Checks waiting to start: the `queued` runs of kind check. */
export function checkQueueFamily(db: Database): Family {
  const row = db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM run WHERE kind = 'check' AND state = 'queued'`)
    .get();
  return {
    type: "gauge",
    name: "forge_check_queue_depth",
    help: "Checks queued and not yet started.",
    samples: [{ value: row?.n ?? 0 }],
  };
}

/** Finished crew runs by member (the agent's username) and outcome. */
export function crewRunsFamily(db: Database): Family {
  const rows = db
    .query<{ member: string; outcome: string; n: number }, []>(
      `SELECT u.username AS member, r.state AS outcome, COUNT(*) AS n
         FROM run r JOIN user u ON u.id = r.actor_id
        WHERE r.kind = 'agent' AND r.state IN ('ok','failed','cancelled')
        GROUP BY u.username, r.state ORDER BY u.username, r.state`,
    )
    .all();
  return {
    type: "counter",
    name: "forge_crew_runs_total",
    help: "Crew runs that ended, by member and outcome.",
    samples: rows.map((r) => ({ labels: { member: r.member, outcome: r.outcome }, value: r.n })),
  };
}

/** What each crew member's runs have cost, in US dollars, from the usage ledger. */
export function crewSpendFamily(db: Database): Family {
  const rows = db
    .query<{ member: string; usd: number }, []>(
      `SELECT u.username AS member, SUM(g.cost_usd) AS usd
         FROM usage g JOIN user u ON u.id = g.agent_id
        GROUP BY u.username ORDER BY u.username`,
    )
    .all();
  return {
    type: "counter",
    name: "forge_crew_spend_usd_total",
    help: "US dollars the crew's runs spent, by member, from the usage ledger.",
    samples: rows.map((r) => ({ labels: { member: r.member }, value: r.usd })),
  };
}

export const PULLS_FAMILY = "forge_pulls_merged_total";
export const RELEASES_FAMILY = "forge_releases_total";
export const ASK_FAMILY = "forge_ask_to_live_seconds";
export const RED_FAMILY = "forge_main_red_seconds_total";

/** Ask-to-live bucket edges in seconds: a minute to a week. */
export const ASK_EDGES_S = [60, 300, 900, 3600, 14_400, 43_200, 86_400, 259_200, 604_800];

/** A repository's label: `owner/name` when public, its id alone when private. */
const REPO_LABEL = `CASE WHEN repo.visibility = 'public' THEN user.username || '/' || repo.name ELSE repo.id END`;

const seconds = (from: string, to: string): number => Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);

const bySeries = (a: Sample, b: Sample): number =>
  (a.labels?.repo ?? "") < (b.labels?.repo ?? "") ? -1 : 1;

/** Pulls merged, per repository: one grouped read of `pull` by its issue's repository. */
export function pullsMergedFamily(db: Database): Family {
  const rows = db
    .query<{ repo: string; n: number }, []>(
      `SELECT ${REPO_LABEL} AS repo, COUNT(*) AS n
         FROM pull JOIN issue ON issue.id = pull.issue_id
         JOIN repo ON repo.id = issue.repo_id JOIN user ON user.id = repo.owner_id
        WHERE pull.merged_at IS NOT NULL GROUP BY repo.id`,
    )
    .all();
  return {
    type: "counter",
    name: PULLS_FAMILY,
    help: "Pulls merged, by repository.",
    samples: rows.map((r) => ({ labels: { repo: r.repo }, value: r.n })).sort(bySeries),
  };
}

/** Releases cut: one count of the `release` rows that went live (`ok = 1`). */
export function releasesFamily(db: Database): Family {
  const row = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM release WHERE ok = 1").get();
  return { type: "counter", name: RELEASES_FAMILY, help: "Releases cut.", samples: [{ value: row?.n ?? 0 }] };
}

/**
 * Seconds from an ask opening to the release of the pull that closes it. Each
 * release names its pull; the pull's body names the issues it closes; the
 * first successful release of a pull counts once, against the oldest issue it closes.
 */
export function askToLiveFamily(db: Database): Family {
  const releases = db
    .query<{ at: string; body: string; repo_id: string }, []>(
      `SELECT MIN(release.created_at) AS at, issue.body, issue.repo_id
         FROM release JOIN issue ON issue.repo_id = release.repo_id
          AND issue.number = release.pull_number AND issue.kind = 'pull'
        WHERE release.pull_number IS NOT NULL AND release.ok = 1 GROUP BY issue.id`,
    )
    .all();
  const opened = db.query<{ created_at: string }, [string, number]>(
    "SELECT created_at FROM issue WHERE repo_id = ?1 AND number = ?2 AND kind = 'issue'",
  );
  const counts = new Array<number>(ASK_EDGES_S.length).fill(0);
  let count = 0;
  let sum = 0;
  for (const r of releases) {
    let from: string | undefined;
    for (const n of closesFromBody(r.body)) {
      const at = opened.get(r.repo_id, n)?.created_at;
      if (at !== undefined && (from === undefined || at < from)) from = at;
    }
    if (from === undefined) continue;
    const s = seconds(from, r.at);
    count++;
    sum += s;
    const i = ASK_EDGES_S.findIndex((edge) => s <= edge);
    if (i >= 0) counts[i]!++;
  }
  let running = 0;
  const buckets = ASK_EDGES_S.map((le, i) => ({ le, count: (running += counts[i]!) }));
  return {
    type: "histogram",
    name: ASK_FAMILY,
    help: "Seconds from an issue opening to the release of the pull that closed it.",
    samples: [{ buckets, count, sum }],
  };
}

/**
 * Seconds the default branch's check spent failing, per repository: from a
 * failed check's finish to the finish of the next green one (or `now` while
 * it is still red). One read of the branch's finished checks in run order.
 */
export function mainRedFamily(db: Database, now: number = Date.now()): Family {
  const rows = db
    .query<{ repo: string; repo_id: string; state: string; finished_at: string | null }, []>(
      `SELECT ${REPO_LABEL} AS repo, run.repo_id, run.state, run.finished_at
         FROM run JOIN repo ON repo.id = run.repo_id JOIN user ON user.id = repo.owner_id
        WHERE run.kind = 'check' AND run.issue_id IS NULL AND run.env = repo.default_branch
          AND run.state IN ('ok','failed') AND run.finished_at IS NOT NULL
        ORDER BY run.repo_id, run.id`,
    )
    .all();
  const red = new Map<string, number>();
  const since = new Map<string, string>();
  const nowIso = new Date(now).toISOString();
  const seen = new Set<string>();
  const close = (id: string, at: string): void => {
    const from = since.get(id);
    if (from === undefined) return;
    red.set(id, (red.get(id) ?? 0) + seconds(from, at));
    since.delete(id);
  };
  const labels = new Map<string, string>();
  for (const r of rows) {
    labels.set(r.repo_id, r.repo);
    seen.add(r.repo_id);
    if (r.state === "failed") {
      if (!since.has(r.repo_id)) since.set(r.repo_id, r.finished_at!);
    } else close(r.repo_id, r.finished_at!);
  }
  for (const id of [...since.keys()]) close(id, nowIso);
  const samples = [...seen].map((id) => ({ labels: { repo: labels.get(id)! }, value: red.get(id) ?? 0 }));
  return {
    type: "counter",
    name: RED_FAMILY,
    help: "Seconds the default branch's check spent failing, by repository.",
    samples: samples.sort(bySeries),
  };
}

export const UP_FAMILY = "forge_app_up";
export const CELL_CPU_FAMILY = "forge_cell_cpu_seconds_total";
export const CELL_MEMORY_FAMILY = "forge_cell_memory_bytes";

/** One app as the runtime holds it: who it is, whether it is private, and each environment's state. */
export interface AppReading {
  readonly id: string;
  readonly slug: string;
  readonly private: boolean;
  readonly envs: readonly { readonly env: string; readonly state: EnvState }[];
}

/** What the app families read: the runtime's recorded states and the watch's counters. */
export interface AppSources {
  readonly apps: readonly AppReading[];
  readonly cells: readonly CellCounter[];
}

/** A private app is named by its id alone, never its slug. */
const nameOf = (a: AppReading): string => (a.private ? a.id : a.slug);

/** `forge_app_up` per app and environment, and each running cell's CPU and memory. */
export function appFamilies({ apps, cells }: AppSources): Family[] {
  const sorted = [...apps].sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : 1));
  const up: Sample[] = [];
  const cpu: Sample[] = [];
  const mem: Sample[] = [];
  // The watch labels a cell `app:<slug>/<env>`, and during a deploy the old
  // and new cells share a label: their figures add up to the environment's.
  const byCell = new Map<string, { cpuUsec: number; memoryBytes: number }>();
  for (const c of cells) {
    if (!c.label.startsWith("app:")) continue;
    const key = c.label.slice(4);
    const held = byCell.get(key) ?? { cpuUsec: 0, memoryBytes: 0 };
    held.cpuUsec += c.cpuUsec;
    held.memoryBytes += c.memoryBytes;
    byCell.set(key, held);
  }
  for (const a of sorted) {
    const app = nameOf(a);
    for (const e of a.envs)
      up.push({ labels: { app, env: e.env }, value: e.state === "running" ? 1 : 0 });
    for (const e of a.envs) {
      const c = byCell.get(`${a.slug}/${e.env}`);
      if (c === undefined) continue;
      const labels = { app, env: e.env };
      cpu.push({ labels, value: c.cpuUsec / 1e6 });
      mem.push({ labels, value: c.memoryBytes });
    }
  }
  return [
    { type: "gauge", name: UP_FAMILY, help: "1 when the app environment is serving, 0 when it is asleep, stopped, deploying or failed.", samples: up },
    { type: "counter", name: CELL_CPU_FAMILY, help: "CPU seconds, user plus system, used by the processes of an app cell since it started.", samples: cpu },
    { type: "gauge", name: CELL_MEMORY_FAMILY, help: "Resident memory in bytes of the processes of an app cell.", samples: mem },
  ];
}

/** The forge's families as Prometheus text (no `# EOF`: the body is `text/plain; version=0.0.4`). */
export function forgeMetrics(
  db: Database,
  sources: AppSources = { apps: [], cells: [] },
  now: number = Date.now(),
): string {
  return openMetrics([
    durationFamily(db),
    checkDurationFamily(db),
    checkQueueFamily(db),
    crewRunsFamily(db),
    crewSpendFamily(db),
    ...appFamilies(sources),
    pullsMergedFamily(db),
    releasesFamily(db),
    askToLiveFamily(db),
    mainRedFamily(db, now),
    telemetryReadsFamily(),
    ...stallFamilies(loopWatch.tally(performance.now())),
  ]).replace(/# EOF\n$/, "");
}
