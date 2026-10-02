/**
 * Usage — the ledger of what each agent run spent: tokens in and out, the
 * provider's reported cost, wall time and outcome, attributed to the
 * subscription it ran on, the app (repository), the agent and the issue.
 * One row per run, written once as the run ends (`crew/runner.ts`); the
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
export type UsageOutcome = "ok" | "failed" | "paused";
export const USAGE_OUTCOMES: readonly UsageOutcome[] = ["ok", "failed", "paused"];

export interface UsageEntry {
  readonly runId: string;
  readonly repoId: string;
  readonly issueId: string | null;
  readonly agentId: string | null;
  /** The account the run worked on; null is the forge's own token. */
  readonly subscriptionId: string | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly wallMs: number;
  readonly outcome: UsageOutcome;
  /** When the run ended (ISO 8601, UTC). */
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
        tokens_in, tokens_out, cost_usd, wall_ms, outcome, at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
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
  );
}

interface UsageRow {
  run_id: string;
  repo_id: string;
  issue_id: string | null;
  agent_id: string | null;
  subscription_id: string | null;
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

/** What the ledger can be summed by. Each maps to one fixed column. */
export type UsageBy = "subscription" | "repo" | "agent" | "issue";
export const USAGE_BY: readonly UsageBy[] = [
  "subscription",
  "repo",
  "agent",
  "issue",
];
const COLUMN: Readonly<Record<UsageBy, string>> = {
  subscription: "subscription_id",
  repo: "repo_id",
  agent: "agent_id",
  issue: "issue_id",
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
      [string, string | null]
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
        WHERE at >= ?1 AND (?2 IS NULL OR repo_id = ?2)
        GROUP BY ${column}
        ORDER BY cost_usd DESC, runs DESC, key`,
    )
    .all(filter.since, filter.repoId ?? null);
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
