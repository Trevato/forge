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
import { BUDGET_PREFIX } from "../kernel/budgets.ts";
import { id } from "../kernel/id.ts";

export type RunKind = "deploy" | "agent" | "check";

/**
 * The one summary a run cancelled by the forge's own restart carries — never
 * the commit's fault, so callers that count failures (`previewLatency`) or
 * word one (`runWord` in `web/studio/words.ts`) can tell it apart from a
 * person's own Cancel or a real failure by this one string.
 */
export const STOPPED_SUMMARY = "the forge stopped";

/** The kinds that pass judgement on a commit: a preview's deploy, or a repository's own check. */
export const CHECK_KINDS: readonly RunKind[] = ["deploy", "check"];
export const RUN_KINDS: readonly RunKind[] = ["deploy", "agent", "check"];
/** Every state a run can be in — the type is read off this list, so a new state is named here once. */
export const RUN_STATES = ["queued", "running", "ok", "failed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_TERMINAL: readonly RunState[] = ["ok", "failed", "cancelled"];
export const isTerminal = (state: RunState): boolean =>
  RUN_TERMINAL.includes(state);

/**
 * What a failed check's own output said, recognised once as the run
 * finishes (`checks/bun-test.ts`) and never re-parsed: the pass/fail
 * counts, and the first few failing names — already bounded, so a run with
 * forty failures still fits on one line wherever this is shown.
 */
export interface CheckDetail {
  readonly passed: number;
  readonly failed: number;
  readonly names: readonly string[];
  /** The test files the failures printed under, when a verification after landing failed (#7786). */
  readonly files?: readonly string[];
  /** The failing tests under those files, at most forty, for the report that files them (#7780). */
  readonly failures?: readonly { readonly file: string; readonly name: string }[];
  /** The check machine's free disk share (0..1) when a red finished (#5453). */
  readonly diskFree?: number;
  /** `temp_full`: a shard ran out of temp space, the environment's fault, not the change's (#8679). */
  readonly environment?: "temp_full";
}

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
  /** For an agent run: whether its shell was held to the sandbox; null when unrecorded. */
  readonly sandboxEnforced: boolean | null;
  /** Why it was not, when it was not. */
  readonly sandboxNote: string;
  /** Where a check ran: `process`, `job`, or empty when unrecorded. */
  readonly placement: string;
  /** The node a `job` check's pod ran on; empty otherwise. */
  readonly node: string;
  /** A failed check's own detail, when its output was recognised; null otherwise. */
  readonly checkDetail: CheckDetail | null;
  /** The base tip a pull's check merged the head with; empty when it merged nothing. */
  readonly baseOid: string;
  /** The variant group this run belongs to; null for an ordinary run. */
  readonly variantGroup: string | null;
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
  sandbox_enforced: number | null;
  sandbox_note: string;
  check_detail: string;
  base_oid: string;
  placement: string;
  node: string;
  variant_group: string | null;
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
  sandboxEnforced:
    r.sandbox_enforced === null ? null : r.sandbox_enforced !== 0,
  sandboxNote: r.sandbox_note,
  placement: r.placement,
  node: r.node,
  checkDetail: r.check_detail ? (JSON.parse(r.check_detail) as CheckDetail) : null,
  baseOid: r.base_oid,
  variantGroup: r.variant_group,
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
  /** The variant group the run belongs to, when it is one of several tries. */
  variantGroup?: string | undefined;
}

export function createRun(db: Database, input: CreateRunInput): Run {
  const runId = id();
  db.query(
    `INSERT INTO run (id, repo_id, kind, issue_id, env, commit_oid, branch, actor_id, reason,
                      not_before, attempt, summary, variant_group)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
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
    input.variantGroup ?? null,
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
 * Several runs by id, in one query — for a caller that already has a batch
 * of run ids from elsewhere (an environment's `runId`, a `failedDeploy`'s)
 * and wants the rows without asking once per id.
 */
export function getRunsByIds(
  db: Database,
  runIds: readonly string[],
): Map<string, Run> {
  const out = new Map<string, Run>();
  const unique = [...new Set(runIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<RunRow, string[]>(
        `SELECT * FROM run WHERE id IN (${batch.map((_, n) => `?${n + 1}`).join(",")})`,
      )
      .all(...batch);
    for (const row of rows) out.set(row.id, toRun(row));
  }
  return out;
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
 *
 * A deploy's `summary` ends with `TESTS_PASSED_TAIL` or `NO_TESTS_TAIL`
 * (`apps/runtime.ts`); `testsClause` (`web/studio/words.ts`) reads it back by
 * suffix. That is a contract kept in free text, chosen over a new column to
 * avoid a migration; both sides use the exported constants, never literals,
 * and a run without either tail (older runs) simply says nothing.
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
    /** A failed check's own detail, when its output was recognised. */
    checkDetail?: CheckDetail | undefined;
    /** For an agent run: the head it left the branch at, when that is worth keeping. */
    commitOid?: string | undefined;
  },
): Run | undefined {
  const changes = db
    .query(
      `UPDATE run SET state = ?2, summary = ?3,
         commit_oid = COALESCE(?8, commit_oid),
         session_id = COALESCE(?4, session_id), cost_usd = COALESCE(?5, cost_usd),
         turns = COALESCE(?6, turns), check_detail = ?7,
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
      outcome.checkDetail ? JSON.stringify(outcome.checkDetail) : "",
      outcome.commitOid ?? null,
    ).changes;
  return changes > 0 ? getRun(db, runId) : undefined;
}

/** The summaries a run is cancelled with when its pull closes or lands under it. */
export const PULL_STOPPED = ["the pull closed", "the pull landed"] as const;

/**
 * A run its pull closed under it, which had in fact reached its own answer
 * (already done on main): that answer replaces the pull's
 * summary, so the park or the note says what the builder said and not
 * "the pull closed". Only such a cancelled run is touched: one its pull
 * landed under keeps "the pull landed", which is no stall (#8481).
 */
export function answerCancelled(
  db: Database,
  runId: string,
  outcome: { state: "ok" | "failed"; summary: string },
): Run | undefined {
  const changes = db
    .query(
      `UPDATE run SET state = ?2, summary = ?3
       WHERE id = ?1 AND state = 'cancelled' AND summary = ?4`,
    )
    .run(runId, outcome.state, outcome.summary.slice(0, 500), PULL_STOPPED[0])
    .changes;
  return changes > 0 ? getRun(db, runId) : undefined;
}

/** Record the base tip a pull's check merged with. */
export function setRunBase(db: Database, runId: string, baseOid: string): void {
  db.query(`UPDATE run SET base_oid = ?2 WHERE id = ?1`).run(runId, baseOid);
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

/**
 * Every queued or running check, and every queued deploy, of one pull,
 * cancelled with the same summary: a pull that landed or closed has nothing
 * left to check, and a queued run would hold the lane for nobody. A running
 * deploy is left alone: nothing here stops the build in the runtime, and a
 * row marked cancelled under a build that goes live would lie. Answers the
 * runs it stopped.
 */
export function cancelRunsForPull(
  db: Database,
  issueId: string,
  summary: string,
): Run[] {
  const ids = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM run WHERE issue_id = ?1 AND 
         ((kind = 'check' AND state IN ('queued','running'))
          OR (kind = 'deploy' AND state = 'queued')) ORDER BY id`,
    )
    .all(issueId);
  const out: Run[] = [];
  for (const { id } of ids) {
    const cancelled = cancelRun(db, id, summary);
    if (cancelled) out.push(cancelled);
  }
  return out;
}

/** Record spend and the session as a run goes, so a cut-off run still reports it. */
export function noteRunProgress(
  db: Database,
  runId: string,
  progress: {
    sessionId?: string | undefined;
    costUsd?: number | undefined;
    branch?: string | undefined;
    /** The subscription the run works on, once picked. */
    subscriptionId?: string | undefined;
    /** Whether the shell is held to the sandbox, and why not when it is not. */
    sandbox?: { enforced: boolean; note: string } | undefined;
    /** Where a check ran, and the node when a cluster Job did. */
    placement?: string | undefined;
    node?: string | undefined;
    /** The model an agent run ran on (empty: the runner's default), and its prompt version. */
    model?: string | undefined;
    /** Why that model: the agent's own, or what escalated the run to Opus. */
    modelReason?: string | undefined;
    promptVersion?: string | undefined;
  },
): void {
  db.query(
    `UPDATE run SET session_id = COALESCE(?2, session_id), cost_usd = COALESCE(?3, cost_usd),
       branch = COALESCE(?4, branch), subscription_id = COALESCE(?5, subscription_id),
       sandbox_enforced = COALESCE(?6, sandbox_enforced),
       sandbox_note = COALESCE(?7, sandbox_note),
       placement = COALESCE(?8, placement),
       node = COALESCE(?9, node),
       model = COALESCE(?10, model),
       prompt_version = COALESCE(?11, prompt_version),
       model_reason = COALESCE(?12, model_reason)
     WHERE id = ?1`,
  ).run(
    runId,
    progress.sessionId ?? null,
    progress.costUsd ?? null,
    progress.branch ?? null,
    progress.subscriptionId ?? null,
    progress.sandbox === undefined ? null : progress.sandbox.enforced ? 1 : 0,
    progress.sandbox?.note.slice(0, 300) ?? null,
    progress.placement?.slice(0, 20) ?? null,
    progress.node?.slice(0, 253) ?? null,
    progress.model?.slice(0, 100) ?? null,
    progress.promptVersion?.slice(0, 40) ?? null,
    progress.modelReason?.slice(0, 60) ?? null,
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

/** What a check the forge's own restart cut off says as it is queued again. */
export const REQUEUED_SUMMARY = "interrupted by a restart; queued again";

/** What a check whose cluster Job vanished says as it is queued again. */
export const VANISHED_SUMMARY = "interrupted: its cluster job vanished; queued again";

/** What a check whose install the machine failed twice says as it is queued again (#5093). */
export const INFRA_SUMMARY = "failed: infrastructure — the install failed twice on a transient error; queued again";

/**
 * How many times one check may be cut off by its forge going away and be
 * queued again. Past it the check fails once, saying so: a check that kills
 * its forge must not loop forever.
 */
export const CHECK_RESTART_LIMIT = 3;

/**
 * Cancel a check the forge's own going-away cut off and queue the same
 * check again, `attempt + 1` — the one way a check is retried, from a
 * graceful stop or a lapsed lease alike. Only a run still `running` is
 * moved, and `lapsedBefore`, when given, must still be true of its lease:
 * the UPDATE's WHERE is what decides between two forges, so only one of
 * them ever queues the retry. Returns the cancelled run and its retry, or
 * undefined when another worker got there first.
 */
export function requeueCheck(
  db: Database,
  runId: string,
  lapsedBefore?: string,
  summary: string = REQUEUED_SUMMARY,
): { cancelled: Run; again: Run } | undefined {
  return db.transaction(() => {
    const changes = db
      .query(
        `UPDATE run SET state = 'cancelled', summary = ?2,
           finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?1 AND kind = 'check' AND state = 'running'
           AND (?3 IS NULL OR heartbeat_at IS NULL OR heartbeat_at < ?3)`,
      )
      .run(runId, summary, lapsedBefore ?? null).changes;
    if (changes === 0) return undefined;
    const cancelled = getRun(db, runId)!;
    const again = createRun(db, {
      repoId: cancelled.repoId,
      kind: "check",
      env: cancelled.env,
      commitOid: cancelled.commitOid,
      reason: cancelled.reason,
      attempt: cancelled.attempt + 1,
      ...(cancelled.issueId === null ? {} : { issueId: cancelled.issueId }),
      ...(cancelled.actorId === null ? {} : { actorId: cancelled.actorId }),
    });
    return { cancelled, again };
  })();
}

/**
 * Whether the run before this one in its chain (the attempt just below, same
 * kind, repository, reason and issue) was killed for its budget: the second
 * overrun is a failure, not a second retry. The branch and commit are not
 * compared: a run notes its branch as it works, its queued retry starts bare.
 */
export function overranBefore(db: Database, run: Run): boolean {
  return cutOffBefore(db, run, BUDGET_PREFIX);
}

/** Whether the attempt just before this one lost its cluster Job: it is queued again once. */
export function vanishedBefore(db: Database, run: Run): boolean {
  return cutOffBefore(db, run, VANISHED_SUMMARY);
}

/** Whether the attempt just before this one failed on infrastructure: it is queued again once. */
export function infraBefore(db: Database, run: Run): boolean {
  return cutOffBefore(db, run, INFRA_SUMMARY);
}

function cutOffBefore(db: Database, run: Run, prefix: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM run WHERE kind = ?1 AND repo_id = ?2 AND reason = ?3
            AND COALESCE(issue_id, '') = ?4 AND attempt = ?5 AND id <> ?6
            AND state = 'cancelled' AND summary LIKE ?7 || '%' LIMIT 1`,
      )
      .get(
        run.kind,
        run.repoId,
        run.reason,
        run.issueId ?? "",
        run.attempt - 1,
        run.id,
        prefix,
      ) !== null
  );
}

/** Failed runs the budget killed since `since`: each is a card in the vitals. */
export function budgetFailures(db: Database, since: string): Run[] {
  return db
    .query<RunRow, [string, string]>(
      `SELECT * FROM run WHERE state = 'failed' AND summary LIKE ?2 || '%'
          AND finished_at >= ?1 ORDER BY finished_at DESC LIMIT 20`,
    )
    .all(since, BUDGET_PREFIX)
    .map(toRun);
}

/** What a sweep of abandoned checks did, run by run. */
export interface AbandonedChecks {
  /** Cancelled and queued again: the cancelled run and its retry. */
  readonly requeued: readonly { cancelled: Run; again: Run }[];
  /** Past `CHECK_RESTART_LIMIT`: failed once, saying the forge kept dying. */
  readonly failed: readonly Run[];
  /** No longer any open pull's head: cancelled, not retried. */
  readonly cancelled: readonly Run[];
}

/**
 * Checks whose lease lapsed — their forge died under them, which is never
 * the commit's fault. One whose commit is still the head of an open pull is
 * queued again (`requeueCheck`) until `CHECK_RESTART_LIMIT`, then failed
 * once with a summary that says why; one whose commit no longer heads any
 * open pull is cancelled and says so. Every move is a compare-and-swap on
 * the lapsed lease, so two forges sweeping at once move each run once.
 */
export function sweepAbandonedChecks(
  db: Database,
  staleMs: number,
): AbandonedChecks {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const rows = db
    .query<RunRow & { live: number }, [string]>(
      `SELECT run.*, EXISTS (
           SELECT 1 FROM pull JOIN issue ON issue.id = pull.issue_id
            WHERE pull.issue_id = run.issue_id AND issue.state = 'open'
              AND pull.merged_at IS NULL AND pull.head_oid = run.commit_oid
         ) AS live
         FROM run
        WHERE kind = 'check' AND state = 'running'
          AND (heartbeat_at IS NULL OR heartbeat_at < ?1)`,
    )
    .all(cutoff);
  const out = {
    requeued: [] as { cancelled: Run; again: Run }[],
    failed: [] as Run[],
    cancelled: [] as Run[],
  };
  const settle = (runId: string, state: string, summary: string) =>
    db
      .query(
        `UPDATE run SET state = ?2, summary = ?3,
           finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?1 AND state = 'running'
           AND (heartbeat_at IS NULL OR heartbeat_at < ?4)`,
      )
      .run(runId, state, summary, cutoff).changes > 0
      ? getRun(db, runId)
      : undefined;
  for (const row of rows) {
    if (row.live === 0) {
      const done = settle(
        row.id,
        "cancelled",
        "the forge went away, and this commit no longer heads an open pull",
      );
      if (done) out.cancelled.push(done);
    } else if (row.attempt >= CHECK_RESTART_LIMIT) {
      const done = settle(
        row.id,
        "failed",
        `the forge kept going away under this check (${row.attempt + 1} times); not trying again`,
      );
      if (done) out.failed.push(done);
    } else {
      const moved = requeueCheck(db, row.id, cutoff);
      if (moved) out.requeued.push(moved);
    }
  }
  return out;
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
  /** Only runs in this state. */
  state?: RunState | undefined;
  /** @default 50 */
  limit?: number | undefined;
  /** Resume after this run id (exclusive) — lists run newest first. */
  cursor?: string | undefined;
}

function runsWhere(repoId: string, options: ListRunsOptions): { where: string; params: (string | number)[]; limit: number } {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
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
  if (options.state !== undefined) {
    params.push(options.state);
    where += ` AND state = ?${params.length}`;
  }
  if (options.cursor !== undefined) {
    params.push(options.cursor);
    where += ` AND id < ?${params.length}`;
  }
  return { where, params, limit };
}

export function listRuns(
  db: Database,
  repoId: string,
  options: ListRunsOptions = {},
): Run[] {
  const { where, params, limit } = runsWhere(repoId, options);
  params.push(limit);
  return db
    .query<RunRow, (string | number)[]>(
      `SELECT * FROM run WHERE ${where} ORDER BY id DESC LIMIT ?${params.length}`,
    )
    .all(...params)
    .map(toRun);
}

/**
 * A cheap marker over the page `listRuns` would give: each row's id and every
 * field a client sees move (state, timestamps, turns, cost, summary, error,
 * attempt), plus the title of the pull or issue it is about. The same page
 * gives the same marker; a run that starts, moves, finishes or spends more
 * changes it. One indexed read, no rows built.
 */
export function runsMarker(db: Database, repoId: string, options: ListRunsOptions = {}): string {
  const { where, params, limit } = runsWhere(repoId, options);
  params.push(limit);
  const rows = db
    .query<{ m: string }, (string | number)[]>(
      `SELECT r.id || '|' || COALESCE(r.state, '') || '|' || COALESCE(r.started_at, '') || '|' || COALESCE(r.finished_at, '')
          || '|' || COALESCE(r.serving_at, '') || '|' || COALESCE(r.turns, '') || '|' || COALESCE(r.cost_usd, '') || '|' || COALESCE(r.attempt, '')
          || '|' || COALESCE(r.not_before, '') || '|' || COALESCE(r.summary, '') || '|' || COALESCE(r.error_line, '') || '|' || COALESCE(r.error_at, '')
          || '|' || COALESCE(r.check_detail, '') || '|' || COALESCE(i.title, '') AS m
         FROM (SELECT * FROM run WHERE ${where} ORDER BY id DESC LIMIT ?${params.length}) r
         LEFT JOIN issue i ON i.id = r.issue_id
        ORDER BY r.id DESC`,
    )
    .all(...params);
  return `${rows.length}\n${rows.map((r) => r.m).join("\n")}`;
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

/** The agent runs working now on a repository, or on one of its issues, newest first. */
export function workingAgentRuns(
  db: Database,
  repoId: string,
  issueId?: string,
): Run[] {
  return db
    .query<
      RunRow,
      [string, string | null]
    >("SELECT * FROM run WHERE state = 'running' AND kind = 'agent' AND repo_id = ?1 AND (?2 IS NULL OR issue_id = ?2) ORDER BY id DESC")
    .all(repoId, issueId ?? null)
    .map(toRun);
}

/** The unfinished run about one issue, if any: the reason a second is not queued. */
export function activeRunFor(
  db: Database,
  kind: RunKind,
  issueId: string,
  actorId?: string,
): Run | undefined {
  const row = db
    .query<
      RunRow,
      [RunKind, string, string | null]
    >("SELECT * FROM run WHERE state IN ('queued','running') AND kind = ?1 AND issue_id = ?2 AND (?3 IS NULL OR actor_id = ?3) ORDER BY id LIMIT 1")
    .get(kind, issueId, actorId ?? null);
  return row ? toRun(row) : undefined;
}

/**
 * `listRuns(…, { kind, issueId, limit: 1 })` for many issues at once: each
 * issue's newest run of `kind`, one query per chunk. Issues with none are absent.
 */
export function latestRunsOfKind(
  db: Database,
  kind: RunKind,
  issueIds: readonly string[],
): Map<string, Run> {
  const out = new Map<string, Run>();
  const unique = [...new Set(issueIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<RunRow, string[]>(
        `SELECT * FROM run WHERE kind = ?1
           AND issue_id IN (${batch.map((_, n) => `?${n + 2}`).join(",")})
         ORDER BY id DESC`,
      )
      .all(kind, ...batch);
    for (const row of rows)
      if (row.issue_id && !out.has(row.issue_id)) out.set(row.issue_id, toRun(row));
  }
  return out;
}

/**
 * `checksForHead` for many pulls at once: each pull's runs at its own head,
 * newest first, one query per chunk. Pulls with none are absent.
 */
export function checksForHeads(
  db: Database,
  heads: ReadonlyMap<string, string>,
): Map<string, Run[]> {
  const out = new Map<string, Run[]>();
  const ids = [...heads.keys()];
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const rows = db
      .query<RunRow, string[]>(
        `SELECT * FROM run WHERE kind IN ('deploy','check')
           AND issue_id IN (${batch.map((_, n) => `?${n + 1}`).join(",")})
         ORDER BY id DESC`,
      )
      .all(...batch);
    for (const row of rows) {
      if (!row.issue_id || row.commit_oid !== heads.get(row.issue_id)) continue;
      const list = out.get(row.issue_id) ?? [];
      list.push(toRun(row));
      out.set(row.issue_id, list);
    }
  }
  return out;
}

/**
 * `activeRunFor` for many issues at once: each issue's earliest queued or
 * running run of `kind`, one query per chunk. Issues with none are absent.
 */
export function activeRunsFor(
  db: Database,
  kind: RunKind,
  issueIds: readonly string[],
): Map<string, Run> {
  const out = new Map<string, Run>();
  const unique = [...new Set(issueIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<RunRow, string[]>(
        `SELECT * FROM run WHERE state IN ('queued','running') AND kind = ?1
           AND issue_id IN (${batch.map((_, n) => `?${n + 2}`).join(",")})
         ORDER BY id`,
      )
      .all(kind, ...batch);
    for (const row of rows)
      if (row.issue_id && !out.has(row.issue_id)) out.set(row.issue_id, toRun(row));
  }
  return out;
}

/** The variant group an issue's earlier runs were started in, if any. */
export function variantGroupOf(db: Database, issueId: string): string | undefined {
  const row = db
    .query<
      { variant_group: string },
      [string]
    >("SELECT variant_group FROM run WHERE issue_id = ?1 AND variant_group IS NOT NULL ORDER BY id LIMIT 1")
    .get(issueId);
  return row?.variant_group;
}

/** Whether a run of this kind already waits its turn for the issue (for `actorId`'s agent, when given). */
export function hasQueuedRun(
  db: Database,
  kind: RunKind,
  issueId: string,
  actorId?: string,
): boolean {
  return (
    db
      .query<
        { n: number },
        [RunKind, string, string | null]
      >("SELECT COUNT(*) AS n FROM run WHERE state = 'queued' AND kind = ?1 AND issue_id = ?2 AND (?3 IS NULL OR actor_id = ?3)")
      .get(kind, issueId, actorId ?? null)!.n > 0
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
  limit = -1,
): Run[] {
  return db
    .query<
      RunRow,
      [string, string, number]
    >("SELECT * FROM run WHERE kind IN ('deploy','check') AND issue_id = ?1 AND commit_oid = ?2 ORDER BY id DESC LIMIT ?3")
    .all(issueId, headOid, limit)
    .map(toRun);
}

/**
 * What this head says now: the newest run of each kind (and environment)
 * at it. A re-run on the same commit supersedes the red it was run for, so
 * "does this head pass" is whether every row here is `ok`.
 */
export function verdictForHead(
  db: Database,
  issueId: string,
  headOid: string,
): Run[] {
  const newest = new Map<string, Run>();
  for (const run of checksForHead(db, issueId, headOid)) {
    const key = `${run.kind}:${run.env}`;
    if (!newest.has(key)) newest.set(key, run);
  }
  return [...newest.values()];
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
  const row = db
    .query<
      RunRow,
      [string, string]
    >("SELECT * FROM run WHERE kind IN ('deploy','check') AND issue_id = ?1 AND commit_oid = ?2 ORDER BY id DESC LIMIT 1")
    .get(issueId, headOid);
  const latest = row ? toRun(row) : undefined;
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
 * How many automatic follow-ups for a failed check an agent has had on a
 * pull since a person last spoke: the bound behind rule 7 in docs/APPS.md.
 * A bring-up-to-date run (`conflict`) is no try: main moving is not the
 * change's failing, and those runs are bounded where they are queued. `since` is the
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
         AND reason = 'check_failed'`,
    )
    .get(issueId, since);
  return row?.n ?? 0;
}

/**
 * `automaticRunsSince` for many pulls at once, each from its own moment,
 * by pull: one query per chunk. A pull with none is absent.
 */
export function automaticRunsSinceFor(
  db: Database,
  since: ReadonlyMap<string, string>,
): Map<string, number> {
  const out = new Map<string, number>();
  const pairs = [...since];
  const CHUNK = 400;
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const batch = pairs.slice(i, i + CHUNK);
    const rows = db
      .query<{ issue_id: string; n: number }, string[]>(
        `WITH since (issue_id, at) AS (VALUES ${batch.map((_, n) => `(?${2 * n + 1}, ?${2 * n + 2})`).join(",")})
         SELECT run.issue_id, COUNT(*) AS n FROM run JOIN since ON since.issue_id = run.issue_id
         WHERE run.kind = 'agent' AND run.created_at > since.at
           AND run.reason = 'check_failed'
         GROUP BY run.issue_id`,
      )
      .all(...batch.flat());
    for (const row of rows) out.set(row.issue_id, row.n);
  }
  return out;
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
  /** Runs spent going again: a failed check, or main moved under the pull. */
  readonly retries: number;
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
        retries: number;
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
                AS merged,
              SUM(reason IN ('check_failed','conflict')) AS retries
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
        retries: r.retries,
      },
    ]),
  );
}

/** Agent runs of one model or one prompt version, in the scorecard's terms. */
export interface SplitTotals {
  /** The model or the prompt version; empty for runs from before it was recorded. */
  readonly key: string;
  readonly runs: number;
  readonly ok: number;
  readonly failed: number;
  readonly spentUsd: number;
}

/** Agent runs grouped by what they ran on: `model` or `prompt_version`. */
export function agentSplits(
  db: Database,
  by: "model" | "prompt_version",
): SplitTotals[] {
  // `by` is one of two literals, never user text.
  return db
    .query<
      { key: string; runs: number; ok: number; failed: number; spent: number },
      []
    >(
      `SELECT ${by} AS key, COUNT(*) AS runs, SUM(state = 'ok') AS ok,
              SUM(state = 'failed') AS failed, COALESCE(SUM(cost_usd), 0) AS spent
         FROM run WHERE kind = 'agent' AND actor_id IS NOT NULL
        GROUP BY ${by} ORDER BY runs DESC, key`,
    )
    .all()
    .map((r) => ({
      key: r.key,
      runs: r.runs,
      ok: r.ok,
      failed: r.failed,
      spentUsd: r.spent,
    }));
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

/**
 * The one statement behind `latestAgentRunsForRepos`, exported so its test
 * explains this exact text and fails when it stops seeking `run_agent_latest`.
 * `?1` is a JSON array of repository ids.
 */
export const LATEST_AGENT_RUNS_SQL = `SELECT run.* FROM run WHERE run.id IN (
  SELECT (SELECT r.id FROM run r
           WHERE r.repo_id = ids.value AND r.kind = 'agent'
           ORDER BY r.created_at DESC, r.id DESC LIMIT 1)
    FROM json_each(?1) AS ids)`;

/**
 * The newest agent run of each repository, in one query: per repository one
 * seek into `run_agent_latest`, never a window over every agent run (#8379).
 * Ties on `created_at` break by the larger id, as they always have.
 */
export function latestAgentRunsForRepos(
  db: Database,
  repoIds: readonly string[],
): Map<string, Run> {
  const out = new Map<string, Run>();
  const unique = [...new Set(repoIds)];
  if (unique.length === 0) return out;
  const rows = db
    .query<RunRow, [string]>(LATEST_AGENT_RUNS_SQL)
    .all(JSON.stringify(unique));
  for (const row of rows) out.set(row.repo_id, toRun(row));
  return out;
}

/**
 * How fast this app's deploys have reached their preview: the total median
 * and the count it is drawn from, plus the same walk split at `started_at`
 * — the wait to be picked up, and the boot once it was. The split is its
 * own two medians, not half of the total's; they will not sum to it.
 * Beside them, how many of this window's deploys finished without ever
 * serving — counted, never folded into the median a dead deploy says
 * nothing about.
 */
export interface PreviewLatency {
  /** Undefined only when nothing served in the window — `n` is then 0. */
  readonly medianSeconds: number | undefined;
  readonly n: number;
  /** Undefined when no served deploy in the window also has a `started_at`. */
  readonly queueMedianSeconds: number | undefined;
  readonly bootMedianSeconds: number | undefined;
  /** How many of `n` carried a `started_at` and so fed the split. */
  readonly splitN: number;
  /** Deploys in the window that finished (`ok`, `failed` or `cancelled`) without ever serving. A deploy still queued or running is neither served nor counted here. */
  readonly failedN: number;
}

const median = (xs: readonly number[]): number => {
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1]! + xs[mid]!) / 2 : xs[mid]!;
};

/**
 * The median seconds from push (`created_at`) to serving (`serving_at`)
 * over this repo's deploys since `since` — the same reference instant
 * `servedPhrase` (`web/ui.ts`) words a single deploy from. A deploy that
 * never served says nothing about speed and is left out of the median,
 * never a zero; one that served but never records a `started_at` feeds
 * the total but not the split. Beside the median, the same walk counts
 * deploys that finished — `ok`, `failed` or `cancelled` — without ever
 * serving; one still `queued` or `running` is neither, and counts as
 * neither. A deploy the forge's own restart cancelled (`STOPPED_SUMMARY`)
 * is left out entirely, from both the failure count and the total it is
 * "of" — the forge's own interruption, never the commit's. One query,
 * bounded by `limit` and served by the `run_repo` index (it walks
 * newest-first and stops at the cap), never a scan of the table.
 */
export function previewLatency(
  db: Database,
  repoId: string,
  since: string,
  limit = 500,
): PreviewLatency | undefined {
  const rows = db
    .query<
      {
        secs: number | null;
        queueSecs: number | null;
        bootSecs: number | null;
        finished: 0 | 1;
      },
      [string, string, string, number]
    >(
      `SELECT CASE WHEN serving_at IS NOT NULL
                   THEN (julianday(serving_at) - julianday(created_at)) * 86400 END AS secs,
              CASE WHEN serving_at IS NOT NULL AND started_at IS NOT NULL
                   THEN (julianday(started_at) - julianday(created_at)) * 86400 END AS queueSecs,
              CASE WHEN serving_at IS NOT NULL AND started_at IS NOT NULL
                   THEN (julianday(serving_at) - julianday(started_at)) * 86400 END AS bootSecs,
              state IN ('ok','failed','cancelled') AS finished
         FROM run
        WHERE repo_id = ?1 AND kind = 'deploy'
          AND created_at >= ?2
          AND NOT (state = 'cancelled' AND summary = ?3)
        ORDER BY id DESC LIMIT ?4`,
    )
    .all(repoId, since, STOPPED_SUMMARY, limit);
  const served = rows.filter((r) => r.secs !== null);
  const failedN = rows.filter((r) => r.secs === null && r.finished === 1).length;
  if (served.length === 0 && failedN === 0) return undefined;
  const secs = served.map((r) => r.secs!).sort((a, b) => a - b);
  const queueSecs = served
    .map((r) => r.queueSecs)
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
  const bootSecs = served
    .map((r) => r.bootSecs)
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
  return {
    medianSeconds: secs.length === 0 ? undefined : median(secs),
    n: secs.length,
    queueMedianSeconds: queueSecs.length === 0 ? undefined : median(queueSecs),
    bootMedianSeconds: bootSecs.length === 0 ? undefined : median(bootSecs),
    splitN: queueSecs.length,
    failedN,
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

/** Which of these repositories have an agent run queued or running: one grouped read. */
export function reposWithActiveRuns(
  db: Database,
  repoIds: readonly string[],
): Set<string> {
  const unique = [...new Set(repoIds)];
  if (unique.length === 0) return new Set();
  return new Set(
    db
      .query<{ repo_id: string }, string[]>(
        `SELECT DISTINCT repo_id FROM run
          WHERE kind = 'agent' AND state IN ('queued','running')
            AND repo_id IN (${unique.map((_, n) => `?${n + 1}`).join(",")})`,
      )
      .all(...unique)
      .map((r) => r.repo_id),
  );
}

/** What is waiting to start, by kind: one grouped query, however many runs there are. */
export function queueDepth(
  db: Database,
  now = Date.now(),
): { kind: RunKind; queued: number; oldest: string }[] {
  return db
    .query<{ kind: RunKind; queued: number; oldest: string }, [string]>(
      `SELECT kind, COUNT(*) AS queued, MIN(created_at) AS oldest
       FROM run
       WHERE state = 'queued' AND (not_before IS NULL OR not_before <= ?1)
       GROUP BY kind`,
    )
    .all(new Date(now).toISOString());
}

/** Every running run with the repository and issue number it is about, in one query. */
export function listRunning(
  db: Database,
): { run: Run; repo: string; issue: number | null }[] {
  const rows = db
    .query<RunRow & { slug: string; issue_number: number | null }, []>(
      `SELECT run.*, user.username || '/' || repo.name AS slug,
              issue.number AS issue_number
       FROM run
       JOIN repo ON repo.id = run.repo_id
       JOIN user ON user.id = repo.owner_id
       LEFT JOIN issue ON issue.id = run.issue_id
       WHERE run.state = 'running'`,
    )
    .all();
  return rows.map((r) => ({
    run: toRun(r),
    repo: r.slug,
    issue: r.issue_number,
  }));
}

/** Keep a finished run's first error line (see `runs/error_line.ts`) beside it. */
export function setRunErrorLine(db: Database, runId: string, text: string, at: number): void {
  db.query("UPDATE run SET error_line = ?2, error_at = ?3 WHERE id = ?1").run(runId, text, at);
}

/** That line and its number in the log, when one was kept. */
export function getRunErrorLine(db: Database, runId: string): { text: string; at: number } | undefined {
  const row = db
    .query<{ error_line: string; error_at: number }, [string]>(
      "SELECT error_line, error_at FROM run WHERE id = ?1",
    )
    .get(runId);
  return row === null || row === undefined || row.error_line === "" ? undefined : { text: row.error_line, at: row.error_at };
}

/**
 * How many runs of a repository are really going: agent runs and checks in
 * the `running` state, the pipeline's `building`, `review` and `checking`
 * stages added (`flow/pipeline.ts`). Queued, paused and finished runs are
 * not running, and a deploy is no work of the crew's.
 */
export function runningCount(db: Database, repoId: string): number {
  return (
    db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM run
          WHERE state = 'running' AND repo_id = ?1 AND kind IN ('agent','check')`,
      )
      .get(repoId)?.n ?? 0
  );
}
