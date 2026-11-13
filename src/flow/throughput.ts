/**
 * What moves through the pipeline (#1779): per stage, the items that left it
 * in each of the last 24 hours, read from what the forge already keeps (runs,
 * pulls, reviews' runs, releases, issues) — no table of its own.
 *
 * Beside `pipeline.ts`, which counts what each stage holds now, this counts
 * what each stage let out: a ready issue leaves when a builder starts on it,
 * a building one when its pull opens, the check queue when a check starts,
 * checking when it finishes (passed or failed), review when a review run
 * returns, approved when the pull lands, landed when the release is
 * preflighted, live when a production deploy serves.
 *
 * Hours are counted back from `now`: hour 0 is the last hour, hour 23 the
 * one that ended 23 hours ago. Plus one number for the headline: the median
 * time from the ask (the issue a landed pull closes, or the pull itself when
 * it closes none) to the production deploy that served it, over the merges
 * that went live in the last 24 hours.
 *
 * Pure data, forge-wide, no authorization: `/flow` is a forge admin's. A
 * sealed issue is counted but its title is not repeated.
 */

import type { Database } from "bun:sqlite";
import { closesFromBody } from "../core/pulls.ts";
import type { PipelineKey } from "./pipeline.ts";

export const HOURS = 24;
const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * HOURS * HOUR_MS;

/** What leaving each stage is called, as the `out` a link names. */
export const OUTFLOW = {
  ready: { out: "started", label: "issues started" },
  building: { out: "opened", label: "pulls opened" },
  "check-queue": { out: "check-started", label: "checks started" },
  checking: { out: "checked", label: "checks finished" },
  review: { out: "reviewed", label: "reviews returned" },
  approved: { out: "landed", label: "landed" },
  landed: { out: "released", label: "released" },
  live: { out: "live", label: "live" },
} as const satisfies Record<PipelineKey, { out: string; label: string }>;

export type OutKey = (typeof OUTFLOW)[PipelineKey]["out"];

/** The stage an `out` names, or undefined when it names none: the boundary check for `?out=`. */
export function stageOf(out: string): PipelineKey | undefined {
  for (const [key, o] of Object.entries(OUTFLOW)) if (o.out === out) return key as PipelineKey;
  return undefined;
}

/** One item that left a stage. */
export interface Moved {
  /** When it left (ISO). */
  readonly at: string;
  /** How a person names it: "shop #12 Add a cart". */
  readonly label: string;
  /** Where it lives on the forge. */
  readonly href: string;
  /** Checks only: how it finished. */
  readonly outcome: "passed" | "failed" | null;
}

export interface StageThroughput {
  readonly key: PipelineKey;
  /** Items out per hour, hour 0 the last one. */
  readonly hours: readonly number[];
  /** Every item out in the last 24 hours, newest first. */
  readonly items: readonly Moved[];
}

export interface Throughput {
  readonly stages: readonly StageThroughput[];
  /** Median ask→live in milliseconds, over what went live in the last 24 hours; null when nothing did. */
  readonly medianAskToLiveMs: number | null;
}

/** The columns every query below returns; the page builds the label and link from them. */
interface Row {
  at: string;
  owner: string;
  repo: string;
  number: number | null;
  title: string | null;
  sealed: number | null;
  run_id: string | null;
  sha: string | null;
  state: string | null;
}

const ITEM = `u.username AS owner, r.name AS repo`;

const QUERIES: Record<PipelineKey, string> = {
  // The first start on each issue in the window: a retry is not a second issue.
  ready: `
    SELECT MIN(x.started_at) AS at, ${ITEM}, i.number, i.title, i.sealed,
           NULL AS run_id, NULL AS sha, NULL AS state
      FROM run x JOIN issue i ON i.id = x.issue_id
      JOIN repo r ON r.id = x.repo_id JOIN user u ON u.id = r.owner_id
     WHERE x.kind = 'agent' AND x.reason != 'review' AND i.kind = 'issue'
       AND x.started_at >= ?1 AND x.started_at <= ?2
     GROUP BY i.id`,
  building: `
    SELECT i.created_at AS at, ${ITEM}, i.number, i.title, i.sealed,
           NULL AS run_id, NULL AS sha, NULL AS state
      FROM issue i JOIN pull p ON p.issue_id = i.id
      JOIN repo r ON r.id = i.repo_id JOIN user u ON u.id = r.owner_id
     WHERE i.created_at >= ?1 AND i.created_at <= ?2`,
  "check-queue": `
    SELECT x.started_at AS at, ${ITEM}, i.number, i.title, i.sealed,
           x.id AS run_id, NULL AS sha, NULL AS state
      FROM run x JOIN repo r ON r.id = x.repo_id JOIN user u ON u.id = r.owner_id
      LEFT JOIN issue i ON i.id = x.issue_id
     WHERE x.kind = 'check' AND x.started_at >= ?1 AND x.started_at <= ?2`,
  checking: `
    SELECT x.finished_at AS at, ${ITEM}, i.number, i.title, i.sealed,
           x.id AS run_id, NULL AS sha, x.state
      FROM run x JOIN repo r ON r.id = x.repo_id JOIN user u ON u.id = r.owner_id
      LEFT JOIN issue i ON i.id = x.issue_id
     WHERE x.kind = 'check' AND x.state IN ('ok','failed')
       AND x.finished_at >= ?1 AND x.finished_at <= ?2`,
  review: `
    SELECT x.finished_at AS at, ${ITEM}, i.number, i.title, i.sealed,
           x.id AS run_id, NULL AS sha, NULL AS state
      FROM run x JOIN repo r ON r.id = x.repo_id JOIN user u ON u.id = r.owner_id
      LEFT JOIN issue i ON i.id = x.issue_id
     WHERE x.kind = 'agent' AND x.reason = 'review' AND x.state = 'ok'
       AND x.finished_at >= ?1 AND x.finished_at <= ?2`,
  approved: `
    SELECT p.merged_at AS at, ${ITEM}, i.number, i.title, i.sealed,
           NULL AS run_id, NULL AS sha, NULL AS state
      FROM pull p JOIN issue i ON i.id = p.issue_id
      JOIN repo r ON r.id = i.repo_id JOIN user u ON u.id = r.owner_id
     WHERE p.base_branch = r.default_branch
       AND p.merged_at >= ?1 AND p.merged_at <= ?2`,
  landed: `
    SELECT e.created_at AS at, ${ITEM}, e.pull_number AS number, i.title, i.sealed,
           NULL AS run_id, e.sha, NULL AS state
      FROM release e JOIN repo r ON r.id = e.repo_id JOIN user u ON u.id = r.owner_id
      LEFT JOIN issue i ON i.repo_id = e.repo_id AND i.number = e.pull_number
     WHERE e.ok = 1 AND e.created_at >= ?1 AND e.created_at <= ?2`,
  live: `
    SELECT x.serving_at AS at, ${ITEM}, NULL AS number, NULL AS title, NULL AS sealed,
           x.id AS run_id, x.commit_oid AS sha, NULL AS state
      FROM run x INDEXED BY run_live JOIN repo r ON r.id = x.repo_id JOIN user u ON u.id = r.owner_id
     WHERE x.kind = 'deploy' AND x.env = 'production'
       AND x.serving_at >= ?1 AND x.serving_at <= ?2`,
};

/** How a row reads and where it links: the run when there is one, else the pull or issue, else the commit. */
function moved(key: PipelineKey, row: Row): Moved {
  const base = `/${row.owner}/${row.repo}`;
  const what = key === "ready" ? "issues" : "pulls";
  const named =
    row.number === null
      ? row.sha === null || row.sha === ""
        ? row.repo
        : `${row.repo} ${row.sha.slice(0, 7)}`
      : `${row.repo} #${row.number}${row.sealed === 1 ? " (sealed)" : row.title === null ? "" : ` ${row.title}`}`;
  const href =
    row.run_id !== null
      ? `${base}/runs/${row.run_id}`
      : row.number !== null
        ? `${base}/${what}/${row.number}`
        : row.sha !== null && row.sha !== ""
          ? `${base}/commit/${row.sha}`
          : base;
  const outcome = key !== "checking" ? null : row.state === "ok" ? "passed" : "failed";
  return { at: row.at, label: named, href, outcome };
}

/** Which hour back from `now` a time falls in: 0 for the last hour. */
const hourOf = (at: string, now: number): number => Math.floor((now - Date.parse(at)) / HOUR_MS);

function stageThroughput(db: Database, key: PipelineKey, now: Date): StageThroughput {
  const since = new Date(now.getTime() - HOURS * HOUR_MS).toISOString();
  const rows = db.query<Row, [string, string]>(QUERIES[key]).all(since, now.toISOString());
  const items = rows.map((r) => moved(key, r)).sort((a, b) => (a.at < b.at ? 1 : -1));
  const hours = new Array<number>(HOURS).fill(0);
  for (const item of items) {
    const h = hourOf(item.at, now.getTime());
    if (h >= 0 && h < HOURS) hours[h]! += 1;
  }
  return { key, hours, items };
}

/** The middle of the values, or the mean of the middle two; null for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Ask→live for every merge into a default branch that a production deploy
 * served in the last 24 hours. The deploy that served it is the first one
 * created after the merge; the ask is the oldest issue the pull closes in its
 * repository, or the pull itself.
 */
function askToLive(db: Database, now: Date): number[] {
  const since = new Date(now.getTime() - HOURS * HOUR_MS).toISOString();
  const rows = db
    .query<{ repo_id: string; body: string; created_at: string; live_at: string | null }, [string, string]>(
      `SELECT i.repo_id, i.body, i.created_at,
              (SELECT d.serving_at FROM run d
                WHERE d.repo_id = i.repo_id AND d.kind = 'deploy' AND d.env = 'production'
                  AND d.created_at >= p.merged_at AND d.serving_at IS NOT NULL
                ORDER BY d.created_at, d.id LIMIT 1) AS live_at
         FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
        WHERE p.base_branch = r.default_branch AND p.merged_at >= ?1 AND p.merged_at <= ?2`,
    )
    .all(new Date(now.getTime() - WEEK_MS).toISOString(), now.toISOString());
  const asked = db.query<{ created_at: string }, [string, number]>(
    "SELECT created_at FROM issue WHERE repo_id = ?1 AND number = ?2 AND kind = 'issue'",
  );
  const out: number[] = [];
  for (const row of rows) {
    if (row.live_at === null || row.live_at < since || row.live_at > now.toISOString()) continue;
    let ask: string | null = null;
    for (const n of closesFromBody(row.body)) {
      const issue = asked.get(row.repo_id, n);
      if (issue !== null && (ask === null || issue.created_at < ask)) ask = issue.created_at;
    }
    ask ??= row.created_at;
    out.push(Date.parse(row.live_at) - Date.parse(ask));
  }
  return out;
}

/** Every stage's outflow over the last 24 hours, left to right, and the median ask→live. */
export function readThroughput(db: Database, keys: readonly PipelineKey[], now = new Date()): Throughput {
  return {
    stages: keys.map((key) => stageThroughput(db, key, now)),
    medianAskToLiveMs: median(askToLive(db, now)),
  };
}

/** The items of one hour back (0 the last), or of all 24 when `hour` is null. */
export function itemsIn(t: StageThroughput, hour: number | null, now: number): Moved[] {
  return hour === null ? [...t.items] : t.items.filter((i) => hourOf(i.at, now) === hour);
}

/** "3.5 h": a span of milliseconds in hours, one decimal. */
export const hoursSpan = (ms: number): string => `${(ms / HOUR_MS).toFixed(1)} h`;

/** One stage's outflow as counts: what the MCP `flow` tool and the terminal's Flow command read. */
export interface StageOut {
  readonly key: PipelineKey;
  readonly out: OutKey;
  readonly label: string;
  readonly lastHour: number;
  readonly day: number;
  /** Items out per hour, hour 0 the last one. */
  readonly hours: readonly number[];
}

export const stageOut = (t: StageThroughput): StageOut => ({
  key: t.key,
  out: OUTFLOW[t.key].out,
  label: OUTFLOW[t.key].label,
  lastHour: t.hours[0] ?? 0,
  day: t.items.length,
  hours: t.hours,
});

/** The headline, one sentence: "landed 2 in the last hour · 6 in 24 h · median ask→live 3.5 h (24 h)". */
export function throughputSays(t: Throughput): string {
  const landed = t.stages.find((s) => s.key === "approved");
  const median = t.medianAskToLiveMs === null ? "—" : hoursSpan(t.medianAskToLiveMs);
  return `landed ${landed?.hours[0] ?? 0} in the last hour · ${landed?.items.length ?? 0} in 24 h · median ask→live ${median} (24 h)`;
}
