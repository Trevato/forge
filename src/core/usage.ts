/**
 * Usage — the ledger of what each agent run spent: tokens in and out, the
 * provider's reported cost, wall time and outcome, attributed to the
 * subscription it ran on, the app (repository), the agent and the issue.
 * One row per run (`crew/runner.ts`): written as `running` each time the
 * session reports its spend, then replaced by its ending — so the totals
 * move while the run works, and the run is never counted twice. The
 * governor reads it to pace the crew, the board to show efficiency.
 *
 * Units, stated once:
 * - `tokensIn` is every input token the model read: fresh input plus cache
 *   writes plus cache reads, as Claude Code's `result.usage` reports them.
 *   `tokensOut` is output tokens. Both are whole tokens.
 * - `costUsd` is the provider's `total_cost_usd` for the run, in US dollars
 *   (on a subscription it is the list-price equivalent, not money charged).
 * - `wallMs` is milliseconds from claim to end, measured by the forge.
 *
 * Pure data: no authz, no events. A subscription's id is kept as text, not
 * a reference, so removing an account does not erase what it spent.
 */

import type { Database } from "bun:sqlite";

/** How a run ended, as far as spend is concerned. */
export type UsageOutcome = "ok" | "failed" | "paused" | "running";
export const USAGE_OUTCOMES: readonly UsageOutcome[] = [
  "ok",
  "failed",
  "paused",
  "running",
];

/**
 * What a run was for: `build` (an issue or a pull's feedback), `plan` (a
 * planner drawing the map), `review` (a pull read), `check` (a failed
 * check put right).
 */
export type UsageKind = "build" | "plan" | "review" | "check";
export const USAGE_KINDS: readonly UsageKind[] = ["build", "plan", "review", "check"];

export interface UsageEntry {
  readonly runId: string;
  readonly repoId: string;
  readonly issueId: string | null;
  readonly agentId: string | null;
  /** The account the run worked on (`PLATFORM` the forge's own token); null on lines that predate it. */
  readonly subscriptionId: string | null;
  /** What the run was for; `build` when unsaid. */
  readonly kind?: UsageKind | undefined;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly wallMs: number;
  readonly outcome: UsageOutcome;
  /** When the run ended, or last reported while `running` (ISO 8601, UTC). */
  readonly at: string;
}

/** A count that must be a whole, non-negative number; anything else is 0. */
const whole = (n: number): number =>
  Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
const nonNegative = (n: number): number =>
  Number.isFinite(n) && n > 0 ? n : 0;

/**
 * Write a run's line in the ledger. A run is written once: a second write
 * for the same run (a retried finish) replaces the first rather than
 * counting the spend twice.
 */
export function recordUsage(db: Database, entry: UsageEntry): void {
  db.query(
    `INSERT OR REPLACE INTO usage
       (run_id, repo_id, issue_id, agent_id, subscription_id,
        tokens_in, tokens_out, cost_usd, wall_ms, outcome, at, kind)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  ).run(
    entry.runId,
    entry.repoId,
    entry.issueId,
    entry.agentId,
    entry.subscriptionId,
    whole(entry.tokensIn),
    whole(entry.tokensOut),
    nonNegative(entry.costUsd),
    whole(entry.wallMs),
    entry.outcome,
    entry.at,
    USAGE_KINDS.includes(entry.kind ?? "build") ? (entry.kind ?? "build") : "build",
  );
}

interface UsageRow {
  run_id: string;
  repo_id: string;
  issue_id: string | null;
  agent_id: string | null;
  subscription_id: string | null;
  kind: UsageKind;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  wall_ms: number;
  outcome: UsageOutcome;
  at: string;
}

const toEntry = (r: UsageRow): UsageEntry => ({
  runId: r.run_id,
  repoId: r.repo_id,
  issueId: r.issue_id,
  agentId: r.agent_id,
  subscriptionId: r.subscription_id,
  kind: r.kind,
  tokensIn: r.tokens_in,
  tokensOut: r.tokens_out,
  costUsd: r.cost_usd,
  wallMs: r.wall_ms,
  outcome: r.outcome,
  at: r.at,
});

export function getUsage(db: Database, runId: string): UsageEntry | undefined {
  const row = db
    .query<UsageRow, [string]>("SELECT * FROM usage WHERE run_id = ?1")
    .get(runId);
  return row ? toEntry(row) : undefined;
}

/**
 * Everything the runs on one issue or pull spent, over all time, or
 * `undefined` when none has landed in the ledger. One aggregate over the
 * table: the ledger is a row per run, small beside the run table itself.
 */
export function issueUsage(
  db: Database,
  issueId: string,
): { runs: number; tokensIn: number; tokensOut: number; costUsd: number } | undefined {
  const row = db
    .query<
      { runs: number; tokens_in: number; tokens_out: number; cost_usd: number },
      [string]
    >(
      `SELECT COUNT(*) AS runs, SUM(tokens_in) AS tokens_in,
              SUM(tokens_out) AS tokens_out, SUM(cost_usd) AS cost_usd
         FROM usage WHERE issue_id = ?1`,
    )
    .get(issueId);
  if (!row || row.runs === 0) return undefined;
  return {
    runs: row.runs,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
  };
}

/** What the ledger can be summed by. Each maps to one fixed column. */
export type UsageBy = "subscription" | "repo" | "agent" | "issue" | "kind";
export const USAGE_BY: readonly UsageBy[] = [
  "subscription",
  "repo",
  "agent",
  "issue",
  "kind",
];
const COLUMN: Readonly<Record<UsageBy, string>> = {
  subscription: "subscription_id",
  repo: "repo_id",
  agent: "agent_id",
  issue: "issue_id",
  kind: "kind",
};

export interface UsageTotals {
  /** The id summed by; null for the forge's own token, or no issue/agent. */
  readonly key: string | null;
  readonly runs: number;
  readonly ok: number;
  readonly failed: number;
  readonly paused: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly wallMs: number;
}

export interface UsageFilter {
  /** Rows at or after this instant (ISO 8601). */
  readonly since: string;
  /** Only this repository's runs, when given. */
  readonly repoId?: string | undefined;
  /** Rows at or before this instant (ISO 8601), when given. */
  readonly until?: string | undefined;
}

/**
 * The ledger summed by one attribution since an instant, in one query,
 * most spent first. `SUM` over no rows is `NULL`; no rows is no groups, so
 * a quiet window is an empty list rather than a row of zeros.
 */
export function usageTotals(
  db: Database,
  by: UsageBy,
  filter: UsageFilter,
): UsageTotals[] {
  const column = COLUMN[by];
  const rows = db
    .query<
      {
        key: string | null;
        runs: number;
        ok: number;
        failed: number;
        paused: number;
        tokens_in: number;
        tokens_out: number;
        cost_usd: number;
        wall_ms: number;
      },
      [string, string | null, string | null]
    >(
      `SELECT ${column} AS key,
              COUNT(*) AS runs,
              SUM(outcome = 'ok') AS ok,
              SUM(outcome = 'failed') AS failed,
              SUM(outcome = 'paused') AS paused,
              SUM(tokens_in) AS tokens_in,
              SUM(tokens_out) AS tokens_out,
              SUM(cost_usd) AS cost_usd,
              SUM(wall_ms) AS wall_ms
         FROM usage
        WHERE at >= ?1 AND (?2 IS NULL OR repo_id = ?2) AND (?3 IS NULL OR at <= ?3)
        GROUP BY ${column}
        ORDER BY cost_usd DESC, runs DESC, key`,
    )
    .all(filter.since, filter.repoId ?? null, filter.until ?? null);
  return rows.map((r) => ({
    key: r.key,
    runs: r.runs,
    ok: r.ok,
    failed: r.failed,
    paused: r.paused,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    costUsd: r.cost_usd,
    wallMs: r.wall_ms,
  }));
}

/** The newest ledger lines, newest first, bounded. */
export function recentUsage(
  db: Database,
  filter: UsageFilter,
  limit: number,
): UsageEntry[] {
  return db
    .query<UsageRow, [string, string | null, number]>(
      `SELECT * FROM usage
        WHERE at >= ?1 AND (?2 IS NULL OR repo_id = ?2)
        ORDER BY at DESC, run_id DESC LIMIT ?3`,
    )
    .all(filter.since, filter.repoId ?? null, Math.min(Math.max(limit, 1), 200))
    .map(toEntry);
}

/** The width of one bucket in `usageBuckets`: a UTC hour or a UTC day. */
export type UsageUnit = "hour" | "day";

/**
 * How many leading characters of an ISO 8601 UTC instant name its bucket:
 * `2026-10-02T14` is the hour 14:00–14:59 UTC, `2026-10-02` the day. Every
 * `at` is written by `toISOString()`, so the prefix is exact — no float
 * arithmetic on julian days deciding which side of a boundary a run lands.
 */
const PREFIX: Readonly<Record<UsageUnit, number>> = { hour: 13, day: 10 };

export interface UsageBucket {
  readonly repoId: string;
  /** The bucket's ISO prefix: `YYYY-MM-DDTHH` for an hour, `YYYY-MM-DD` for a day. */
  readonly bucket: string;
  readonly runs: number;
  readonly failed: number;
  readonly costUsd: number;
}

/**
 * The ledger summed per repository per UTC hour or day since an instant, for
 * these repositories only — the fleet graph's one read (`actions/fleet-graph.ts`).
 * Runs are counted when they end, because that is when a run's line is
 * written. An empty list of repositories reads nothing.
 */
export function usageBuckets(
  db: Database,
  repoIds: readonly string[],
  since: string,
  unit: UsageUnit,
): UsageBucket[] {
  const unique = [...new Set(repoIds)];
  const out: UsageBucket[] = [];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<
        {
          repo_id: string;
          bucket: string;
          runs: number;
          failed: number;
          cost_usd: number;
        },
        [string, number, ...string[]]
      >(
        `SELECT repo_id, substr(at, 1, ?2) AS bucket,
                COUNT(*) AS runs,
                SUM(outcome = 'failed') AS failed,
                SUM(cost_usd) AS cost_usd
           FROM usage
          WHERE at >= ?1
            AND repo_id IN (${batch.map((_, n) => `?${n + 3}`).join(",")})
          GROUP BY repo_id, bucket
          ORDER BY bucket, repo_id`,
      )
      .all(since, PREFIX[unit], ...batch);
    for (const r of rows)
      out.push({
        repoId: r.repo_id,
        bucket: r.bucket,
        runs: r.runs,
        failed: r.failed,
        costUsd: r.cost_usd,
      });
  }
  return out;
}

/** One repository's crew spend on one UTC day. */
export interface UsageDay {
  readonly repoId: string | null;
  /** `YYYY-MM-DD`, UTC. */
  readonly day: string;
  readonly costUsd: number;
}

/**
 * The ledger summed per repository per UTC day in [since, until] — the
 * board's thirty-day money line (#510), every repository in one read
 * walking `usage_at`. The day is the instant's ISO
 * prefix, as `usageBuckets` names it.
 */
export function usageDays(db: Database, since: string, until: string): UsageDay[] {
  return db
    .query<{ repo_id: string | null; day: string; cost_usd: number }, [string, string]>(
      `SELECT repo_id, substr(at, 1, 10) AS day, SUM(cost_usd) AS cost_usd
         FROM usage
        WHERE at >= ?1 AND at <= ?2
        GROUP BY repo_id, day`,
    )
    .all(since, until)
    .map((r) => ({ repoId: r.repo_id, day: r.day, costUsd: r.cost_usd }));
}

/** Every repository with a line in the ledger since an instant, by id. */
export function reposWithUsage(db: Database, since: string): string[] {
  return db
    .query<{ repo_id: string }, [string]>(
      "SELECT DISTINCT repo_id FROM usage WHERE at >= ?1",
    )
    .all(since)
    .map((r) => r.repo_id);
}

/** The costliest ledger lines since an instant, most spent first, bounded. */
export function topUsage(
  db: Database,
  filter: UsageFilter,
  limit: number,
): UsageEntry[] {
  return db
    .query<UsageRow, [string, string | null, number, string | null]>(
      `SELECT * FROM usage
        WHERE at >= ?1 AND (?2 IS NULL OR repo_id = ?2) AND (?4 IS NULL OR at <= ?4)
        ORDER BY cost_usd DESC, tokens_in + tokens_out DESC, run_id LIMIT ?3`,
    )
    .all(
      filter.since,
      filter.repoId ?? null,
      Math.min(Math.max(limit, 1), 200),
      filter.until ?? null,
    )
    .map(toEntry);
}
