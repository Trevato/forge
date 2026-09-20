/**
 * Runs — the durable record of work the forge did on a commit. A `deploy`
 * run is an environment being brought up at one commit, and its outcome is
 * the check a pull shows; an `agent` run is a crew member working an issue
 * or a pull. Rows move `queued` → `running` by compare-and-swap and end
 * `ok`, `failed` or `cancelled`. The log is a file (`runs/log.ts`); the
 * row carries the one-line summary and the numbers. Pure data: no authz,
 * no events.
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";

export type RunKind = "deploy" | "agent" | "check";
/** The kinds that pass judgement on a commit: a preview's deploy, or a repository's own check. */
export const CHECK_KINDS: readonly RunKind[] = ["deploy", "check"];
export const RUN_KINDS: readonly RunKind[] = ["deploy", "agent", "check"];
export type RunState = "queued" | "running" | "ok" | "failed" | "cancelled";

export const RUN_TERMINAL: readonly RunState[] = ["ok", "failed", "cancelled"];
export const isTerminal = (state: RunState): boolean =>
  RUN_TERMINAL.includes(state);

export interface Run {
  readonly id: string;
  readonly repoId: string;
  readonly kind: RunKind;
  /** The issue or pull this run is about, if any. */
  readonly issueId: string | null;
  /** For a deploy: `production` or `pull-<n>`. Empty for an agent run. */
  readonly env: string;
  readonly commitOid: string;
  /** For an agent run: the branch it works on. */
  readonly branch: string;
  readonly state: RunState;
  /** One line: what happened, in words a person reads on a card. */
  readonly summary: string;
  /** The agent for an agent run; whoever triggered a deploy otherwise. */
  readonly actorId: string | null;
  /** Why this run exists: `assigned`, `feedback`, `check_failed`, `push`, `boot`, … */
  readonly reason: string;
  /** The agent session to resume for a follow-up, when there is one. */
  readonly sessionId: string;
  readonly costUsd: number;
  /** A queued run that must not start before this instant: paused on a limit. */
  readonly notBefore: string | null;
  /** How many times this task has been paused and queued again. */
  readonly attempt: number;
  /** When the process working this run last said it still was. */
  readonly heartbeatAt: string | null;
  /** For an agent run: how many turns the model took. */
  readonly turns: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  /** When this deploy's environment started serving — set once, at the swap-in. */
  readonly servingAt: string | null;
  readonly finishedAt: string | null;
}

interface RunRow {
  id: string;
  repo_id: string;
  kind: RunKind;
  issue_id: string | null;
  env: string;
  commit_oid: string;
  branch: string;
  state: RunState;
  summary: string;
  actor_id: string | null;
  reason: string;
  session_id: string;
  cost_usd: number;
  not_before: string | null;
  attempt: number;
  heartbeat_at: string | null;
  turns: number;
  created_at: string;
  started_at: string | null;
  serving_at: string | null;
  finished_at: string | null;
}

const toRun = (r: RunRow): Run => ({
  id: r.id,
  repoId: r.repo_id,
  kind: r.kind,
  issueId: r.issue_id,
  env: r.env,
  commitOid: r.commit_oid,
  branch: r.branch,
  state: r.state,
  summary: r.summary,
  actorId: r.actor_id,
  reason: r.reason,
  sessionId: r.session_id,
  costUsd: r.cost_usd,
  notBefore: r.not_before,
  attempt: r.attempt,
  heartbeatAt: r.heartbeat_at,
  turns: r.turns,
  createdAt: r.created_at,
  startedAt: r.started_at,
  servingAt: r.serving_at,
  finishedAt: r.finished_at,
});

export interface CreateRunInput {
  repoId: string;
  kind: RunKind;
  issueId?: string | undefined;
  env?: string | undefined;
  commitOid?: string | undefined;
  branch?: string | undefined;
  actorId?: string | undefined;
  reason?: string | undefined;
  /** For a run queued again after a pause: when it may start, and the count. */
  notBefore?: string | undefined;
  attempt?: number | undefined;
  /** What the card says while it waits. */
  summary?: string | undefined;
}

export function createRun(db: Database, input: CreateRunInput): Run {
  const runId = id();
  db.query(
    `INSERT INTO run (id, repo_id, kind, issue_id, env, commit_oid, branch, actor_id, reason,
                      not_before, attempt, summary)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  ).run(
    runId,
    input.repoId,
    input.kind,
    input.issueId ?? null,
    input.env ?? "",
    input.commitOid ?? "",
    input.branch ?? "",
    input.actorId ?? null,
    input.reason ?? "",
    input.notBefore ?? null,
    input.attempt ?? 0,
    input.summary ?? "",
  );
  return getRun(db, runId)!;
}

export function getRun(db: Database, runId: string): Run | undefined {
  const row = db
    .query<RunRow, [string]>("SELECT * FROM run WHERE id = ?1")
    .get(runId);
  return row ? toRun(row) : undefined;
}

/**
 * Take a queued run. The UPDATE's WHERE is the claim: a second worker's
 * changes count is zero and it moves on. Returns the run as running, or
 * undefined when someone else has it (or it was cancelled meanwhile).
 */
export function claimRun(db: Database, runId: string): Run | undefined {
  const changes = db
    .query(
      `UPDATE run SET state = 'running', started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?1 AND state = 'queued'`,
    )
    .run(runId).changes;
  return changes > 0 ? getRun(db, runId) : undefined;
}

/**
 * Record the instant a deploy's environment started serving — the swap-in,
 * not the tests finishing beside it. Set once: a second call, on a run
 * already stamped, changes nothing.
 */
export function markServing(db: Database, runId: string): Run | undefined {
  const changes = db
    .query(
      `UPDATE run SET serving_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?1 AND state = 'running' AND serving_at IS NULL`,
    )
    .run(runId).changes;
  return changes > 0 ? getRun(db, runId) : undefined;
}

/**
 * Finish a run. Only a running run finishes; a cancelled one stays
 * cancelled however late its worker reports in. Returns the final row, or
 * undefined when nothing changed.
 */
export function finishRun(
  db: Database,
  runId: string,
  outcome: {
    state: "ok" | "failed";
    summary: string;
    sessionId?: string | undefined;
    costUsd?: number | undefined;
    turns?: number | undefined;
  },
): Run | undefined {
  const changes = db
    .query(
      `UPDATE run SET state = ?2, summary = ?3,
         session_id = COALESCE(?4, session_id), cost_usd = COALESCE(?5, cost_usd),
         turns = COALESCE(?6, turns),
         finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?1 AND state = 'running'`,
    )
    .run(
      runId,
      outcome.state,
      outcome.summary.slice(0, 500),
      outcome.sessionId ?? null,
      outcome.costUsd ?? null,
      outcome.turns ?? null,
    ).changes;
  return changes > 0 ? getRun(db, runId) : undefined;
}

/** Cancel a run that has not finished. Returns the row, or undefined if it had. */
export function cancelRun(
  db: Database,
  runId: string,
  summary = "cancelled",
): Run | undefined {
  const changes = db
    .query(
      `UPDATE run SET state = 'cancelled', summary = ?2,
         finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?1 AND state IN ('queued','running')`,
    )
    .run(runId, summary).changes;
  return changes > 0 ? getRun(db, runId) : undefined;
}

/** Record spend and the session as a run goes, so a cut-off run still reports it. */
export function noteRunProgress(
  db: Database,
  runId: string,
  progress: {
    sessionId?: string | undefined;
    costUsd?: number | undefined;
    branch?: string | undefined;
  },
): void {
  db.query(
    `UPDATE run SET session_id = COALESCE(?2, session_id), cost_usd = COALESCE(?3, cost_usd),
       branch = COALESCE(?4, branch)
     WHERE id = ?1`,
  ).run(
    runId,
    progress.sessionId ?? null,
    progress.costUsd ?? null,
    progress.branch ?? null,
  );
}

/**
 * The most recent finished agent run about an issue by one agent — the
 * session to resume and the moment after which conversation is news.
 */
export function lastAgentRun(
  db: Database,
  issueId: string,
  agentId: string,
): Run | undefined {
  const row = db
    .query<RunRow, [string, string]>(
      `SELECT * FROM run WHERE kind = 'agent' AND issue_id = ?1 AND actor_id = ?2
       AND state IN ('ok','failed','cancelled') ORDER BY id DESC LIMIT 1`,
    )
    .get(issueId, agentId);
  return row ? toRun(row) : undefined;
}

/** The process working these runs says it still is. */
export function heartbeatRuns(db: Database, runIds: readonly string[]): void {
  if (runIds.length === 0) return;
  db.query(
    `UPDATE run SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE state = 'running' AND id IN (${runIds.map((_, n) => `?${n + 1}`).join(",")})`,
  ).run(...runIds);
}

/**
 * Running runs nobody has renewed for `staleMs` belong to a process that
 * no longer exists — a forge that died with them. Fail them honestly rather
 * than leave a spinner. A run a live process is still working, an old
 * forge finishing beside a new one, is left alone: its lease says so.
 * `kinds` narrows it: a forge with a crew leaves agent runs to the crew,
 * which queues them again rather than failing them.
 */
export function failAbandonedRuns(
  db: Database,
  staleMs: number,
  kinds: readonly RunKind[] = RUN_KINDS,
): number {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  return db
    .query(
      `UPDATE run SET state = 'failed', summary = 'the forge that was running this went away',
         finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE state = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?1)
         AND kind IN (SELECT value FROM json_each(?2))`,
    )
    .run(cutoff, JSON.stringify(kinds)).changes;
}

/** Whether a running run's lease has lapsed. */
export function leaseLapsed(
  run: Run,
  staleMs: number,
  now = Date.now(),
): boolean {
  if (run.heartbeatAt === null) return true;
  return new Date(run.heartbeatAt).getTime() < now - staleMs;
}

export interface ListRunsOptions {
  kind?: RunKind | undefined;
  /** Only runs about this issue or pull. */
  issueId?: string | undefined;
  /** Only runs for this environment. */
  env?: string | undefined;
  /** @default 50 */
  limit?: number | undefined;
  /** Resume after this run id (exclusive) — lists run newest first. */
  cursor?: string | undefined;
}

export function listRuns(
  db: Database,
  repoId: string,
  options: ListRunsOptions = {},
): Run[] {
  const params: (string | number)[] = [repoId];
  let where = "repo_id = ?1";
  if (options.kind !== undefined) {
    params.push(options.kind);
    where += ` AND kind = ?${params.length}`;
  }
  if (options.issueId !== undefined) {
    params.push(options.issueId);
    where += ` AND issue_id = ?${params.length}`;
  }
  if (options.env !== undefined) {
    params.push(options.env);
    where += ` AND env = ?${params.length}`;
  }
  if (options.cursor !== undefined) {
    params.push(options.cursor);
    where += ` AND id < ?${params.length}`;
  }
  params.push(Math.min(Math.max(options.limit ?? 50, 1), 200));
  return db
    .query<RunRow, (string | number)[]>(
      `SELECT * FROM run WHERE ${where} ORDER BY id DESC LIMIT ?${params.length}`,
    )
    .all(...params)
    .map(toRun);
}

/** Queued runs of one kind, oldest first — what a worker takes from. */
/** Queued runs that may start now: a paused one waits for its moment. */
export function listQueued(db: Database, kind: RunKind, limit = 10): Run[] {
  return db
    .query<RunRow, [RunKind, string, number]>(
      `SELECT * FROM run WHERE state = 'queued' AND kind = ?1
         AND (not_before IS NULL OR not_before <= ?2)
       ORDER BY id LIMIT ?3`,
    )
    .all(kind, new Date().toISOString(), limit)
    .map(toRun);
}

/** Runs of one kind not yet finished, for concurrency and "is one on it?". */
export function listActive(db: Database, kind: RunKind): Run[] {
  return db
    .query<
      RunRow,
      [RunKind]
    >("SELECT * FROM run WHERE state IN ('queued','running') AND kind = ?1 ORDER BY id")
    .all(kind)
    .map(toRun);
}

/** The unfinished run about one issue, if any: the reason a second is not queued. */
export function activeRunFor(
  db: Database,
  kind: RunKind,
  issueId: string,
): Run | undefined {
  const row = db
    .query<
      RunRow,
      [RunKind, string]
    >("SELECT * FROM run WHERE state IN ('queued','running') AND kind = ?1 AND issue_id = ?2 ORDER BY id LIMIT 1")
    .get(kind, issueId);
  return row ? toRun(row) : undefined;
}

/** Whether a run of this kind already waits its turn for the issue. */
export function hasQueuedRun(
  db: Database,
  kind: RunKind,
  issueId: string,
): boolean {
  return (
    db
      .query<
        { n: number },
        [RunKind, string]
      >("SELECT COUNT(*) AS n FROM run WHERE state = 'queued' AND kind = ?1 AND issue_id = ?2")
      .get(kind, issueId)!.n > 0
  );
}

/**
 * The checks on a pull: the deploy runs at its current head, newest first.
 * Older heads are history — a push makes new runs — so a caller that wants
 * "does this head pass" reads the first row's state.
 */
export function checksForHead(
  db: Database,
  issueId: string,
  headOid: string,
): Run[] {
  return db
    .query<
      RunRow,
      [string, string]
    >("SELECT * FROM run WHERE kind IN ('deploy','check') AND issue_id = ?1 AND commit_oid = ?2 ORDER BY id DESC")
    .all(issueId, headOid)
    .map(toRun);
}

export interface CheckSummary {
  /** `ok` when the latest deploy of this head succeeded; `none` when there is none. */
  readonly state: RunState | "none";
  readonly run: Run | null;
}

export function checkSummary(
  db: Database,
  issueId: string,
  headOid: string,
): CheckSummary {
  const latest = checksForHead(db, issueId, headOid)[0];
  return latest
    ? { state: latest.state, run: latest }
    : { state: "none", run: null };
}

/**
 * The latest run per issue for a set of issues — one query, for a list that
 * shows a check mark beside every pull without asking per row.
 */
export function latestRunsForIssues(
  db: Database,
  issueIds: readonly string[],
  kinds: readonly RunKind[] = CHECK_KINDS,
): Map<string, Run> {
  const out = new Map<string, Run>();
  const unique = [...new Set(issueIds)];
  const CHUNK = 400;
  const kindList = kinds.map((k) => `'${k}'`).join(",");
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<RunRow, string[]>(
        `SELECT run.* FROM run
         JOIN (SELECT issue_id, MAX(id) AS id FROM run
               WHERE kind IN (${kindList}) AND issue_id IN (${batch.map((_, n) => `?${n + 1}`).join(",")})
               GROUP BY issue_id) latest ON latest.id = run.id`,
      )
      .all(...batch);
    for (const row of rows) if (row.issue_id) out.set(row.issue_id, toRun(row));
  }
  return out;
}

/**
 * How many automatic follow-ups an agent has had on a pull since a person
 * last spoke: the bound behind rule 7 in docs/APPS.md. `since` is the
 * moment of the last human comment or review, or the pull's creation.
 */
export function automaticRunsSince(
  db: Database,
  issueId: string,
  since: string,
): number {
  const row = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM run
       WHERE kind = 'agent' AND issue_id = ?1 AND created_at > ?2
         AND reason IN ('check_failed','conflict')`,
    )
    .get(issueId, since);
  return row?.n ?? 0;
}

/** What an agent has done, in totals: the number a person weighs a crew by. */
export interface AgentTotals {
  readonly runs: number;
  readonly ok: number;
  readonly failed: number;
  readonly spentUsd: number;
  /** Mean wall-clock of finished runs, in seconds; null before the first. */
  readonly meanSeconds: number | null;
  /** Mean cost of a finished run, and mean turns, over runs that reported them. */
  readonly meanCostUsd: number | null;
  readonly meanTurns: number | null;
  /** Pulls this agent opened that a person merged. */
  readonly merged: number;
}

/** Totals of agent runs, keyed by the agent's user id. */
export function agentTotals(db: Database): Map<string, AgentTotals> {
  const rows = db
    .query<
      {
        actor_id: string;
        runs: number;
        ok: number;
        failed: number;
        spent: number;
        mean_seconds: number | null;
        mean_cost: number | null;
        mean_turns: number | null;
        merged: number;
      },
      []
    >(
      `SELECT actor_id,
              COUNT(*) AS runs,
              SUM(state = 'ok') AS ok,
              SUM(state = 'failed') AS failed,
              SUM(cost_usd) AS spent,
              AVG(CASE WHEN started_at IS NOT NULL AND finished_at IS NOT NULL
                       THEN (julianday(finished_at) - julianday(started_at)) * 86400 END)
                AS mean_seconds,
              AVG(CASE WHEN state IN ('ok','failed') AND cost_usd > 0 THEN cost_usd END)
                AS mean_cost,
              AVG(CASE WHEN turns > 0 THEN turns END) AS mean_turns,
              (SELECT COUNT(*) FROM pull JOIN issue ON issue.id = pull.issue_id
                WHERE issue.author_id = run.actor_id AND pull.merged_at IS NOT NULL)
                AS merged
         FROM run
        WHERE kind = 'agent' AND actor_id IS NOT NULL
        GROUP BY actor_id`,
    )
    .all();
  return new Map(
    rows.map((r) => [
      r.actor_id,
      {
        runs: r.runs,
        ok: r.ok,
        failed: r.failed,
        spentUsd: r.spent,
        meanSeconds: r.mean_seconds,
        meanCostUsd: r.mean_cost,
        meanTurns: r.mean_turns,
        merged: r.merged,
      },
    ]),
  );
}

/** One repository's agent runs over a window: what "this week" is made of. */
export interface AgentRunTotals {
  readonly runs: number;
  readonly spentUsd: number;
}

/**
 * How many agent runs a repository has had since an instant, and what they
 * cost — counted by the database, not by listing rows and adding them up in
 * JavaScript. `SUM` over no rows is `NULL`, so a quiet week reads `0`, and
 * the float dollars are summed once here and rounded once where printed.
 */
export function agentRunTotals(
  db: Database,
  repoId: string,
  since: string,
): AgentRunTotals {
  const row = db
    .query<{ runs: number; spent: number | null }, [string, string]>(
      `SELECT COUNT(*) AS runs, SUM(cost_usd) AS spent FROM run
        WHERE repo_id = ?1 AND kind = 'agent' AND created_at >= ?2`,
    )
    .get(repoId, since);
  return { runs: row?.runs ?? 0, spentUsd: row?.spent ?? 0 };
}

/** The newest agent run of each repository, in one query. */
export function latestAgentRunsForRepos(
  db: Database,
  repoIds: readonly string[],
): Map<string, Run> {
  const out = new Map<string, Run>();
  const unique = [...new Set(repoIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<RunRow, string[]>(
        `SELECT * FROM (
           SELECT run.*, ROW_NUMBER() OVER (PARTITION BY repo_id ORDER BY created_at DESC, id DESC) AS rn
           FROM run WHERE kind = 'agent' AND repo_id IN (${batch.map((_, n) => `?${n + 1}`).join(",")})
         ) WHERE rn = 1`,
      )
      .all(...batch);
    for (const row of rows) out.set(row.repo_id, toRun(row));
  }
  return out;
}

/**
 * How fast this app's deploys have reached their preview: the total median
 * and the count it is drawn from, plus the same walk split at `started_at`
 * — the wait to be picked up, and the boot once it was. The split is its
 * own two medians, not half of the total's; they will not sum to it.
 */
export interface PreviewLatency {
  readonly medianSeconds: number;
  readonly n: number;
  /** Undefined when no served deploy in the window also has a `started_at`. */
  readonly queueMedianSeconds: number | undefined;
  readonly bootMedianSeconds: number | undefined;
  /** How many of `n` carried a `started_at` and so fed the split. */
  readonly splitN: number;
}

const median = (xs: readonly number[]): number => {
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1]! + xs[mid]!) / 2 : xs[mid]!;
};

/**
 * The median seconds from push (`created_at`) to serving (`serving_at`)
 * over this repo's deploys since `since` — the same reference instant
 * `servedPhrase` (`web/ui.ts`) words a single deploy from. A deploy that
 * never served says nothing about speed and is left out, never a zero;
 * one that served but never records a `started_at` feeds the total but
 * not the split. One query, bounded by `limit` and served by the
 * `run_repo` index (it walks newest-first and stops at the cap), never a
 * scan of the table.
 */
export function previewLatency(
  db: Database,
  repoId: string,
  since: string,
  limit = 500,
): PreviewLatency | undefined {
  const rows = db
    .query<
      { secs: number; queueSecs: number | null; bootSecs: number | null },
      [string, string, number]
    >(
      `SELECT (julianday(serving_at) - julianday(created_at)) * 86400 AS secs,
              CASE WHEN started_at IS NOT NULL
                   THEN (julianday(started_at) - julianday(created_at)) * 86400 END AS queueSecs,
              CASE WHEN started_at IS NOT NULL
                   THEN (julianday(serving_at) - julianday(started_at)) * 86400 END AS bootSecs
         FROM run
        WHERE repo_id = ?1 AND kind = 'deploy' AND serving_at IS NOT NULL
          AND created_at >= ?2
        ORDER BY id DESC LIMIT ?3`,
    )
    .all(repoId, since, limit);
  if (rows.length === 0) return undefined;
  const secs = rows.map((r) => r.secs).sort((a, b) => a - b);
  const queueSecs = rows
    .map((r) => r.queueSecs)
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
  const bootSecs = rows
    .map((r) => r.bootSecs)
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
  return {
    medianSeconds: median(secs),
    n: secs.length,
    queueMedianSeconds: queueSecs.length === 0 ? undefined : median(queueSecs),
    bootMedianSeconds: bootSecs.length === 0 ? undefined : median(bootSecs),
    splitN: queueSecs.length,
  };
}

/** Agent runs queued or running across many repositories, newest first. */
export function listActiveRuns(
  db: Database,
  repoIds: readonly string[],
): Run[] {
  const unique = [...new Set(repoIds)];
  if (unique.length === 0) return [];
  return db
    .query<RunRow, string[]>(
      `SELECT * FROM run WHERE kind = 'agent' AND state IN ('queued','running')
         AND repo_id IN (${unique
           .slice(0, 400)
           .map((_, n) => `?${n + 1}`)
           .join(",")})
       ORDER BY created_at DESC LIMIT 50`,
    )
    .all(...unique.slice(0, 400))
    .map(toRun);
}
