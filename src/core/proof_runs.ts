/**
 * Proof runs (#7706). A proof (`checks/proof.ts`) writes one row here and
 * moves it `queued` (no check slot spare) → `running` → `ok`, `failed` or
 * `cancelled` (cut off at the deadline or by a restart). Read as a `Run` of
 * kind `proof`, so the runs list, the pull and MCP `runs` show it. Pure
 * data: no authz, no events.
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";
import type { Run, RunState } from "./runs.ts";

interface Row {
  id: string;
  repo_id: string;
  issue_id: string;
  head: string;
  base: string;
  state: RunState;
  summary: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const toRun = (r: Row): Run => ({
  id: r.id,
  repoId: r.repo_id,
  kind: "proof",
  issueId: r.issue_id,
  env: "",
  commitOid: r.head,
  branch: "",
  state: r.state,
  summary: r.summary,
  actorId: null,
  reason: "proof",
  sessionId: "",
  costUsd: 0,
  notBefore: null,
  attempt: 0,
  heartbeatAt: null,
  turns: 0,
  sandboxEnforced: null,
  sandboxNote: "",
  placement: "",
  node: "",
  checkDetail: null,
  baseOid: r.base,
  variantGroup: null,
  createdAt: r.created_at,
  startedAt: r.started_at,
  servingAt: null,
  finishedAt: r.finished_at,
});

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** A proof of `head` on `base`, waiting (`queued`) with the reason, or already `running`. */
export function openProofRun(
  db: Database,
  input: { repoId: string; pullId: string; head: string; base: string; state: "queued" | "running"; summary: string },
): Run {
  const runId = id();
  // A push makes the old head's proof moot: it waited or ran for a head no one will land.
  db.query(
    `UPDATE proof_run SET state = 'cancelled', summary = 'superseded by a push', finished_at = ${NOW}
     WHERE issue_id = ?1 AND head <> ?2 AND state IN ('queued','running')`,
  ).run(input.pullId, input.head);
  db.query(
    `INSERT INTO proof_run (id, repo_id, issue_id, head, base, state, summary, started_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ${input.state === "running" ? NOW : "NULL"})`,
  ).run(runId, input.repoId, input.pullId, input.head, input.base, input.state, input.summary.slice(0, 500));
  return getProofRun(db, runId)!;
}

/** A pull left `open` (landed or closed): its waiting or running proofs end, for no one will land them. */
export function endProofRunsForPull(db: Database, pullId: string, summary: "pull landed" | "pull closed"): void {
  db.query(
    `UPDATE proof_run SET state = 'cancelled', summary = ?2, finished_at = ${NOW}
     WHERE issue_id = ?1 AND state IN ('queued','running')`,
  ).run(pullId, summary);
}

export function getProofRun(db: Database, runId: string): Run | undefined {
  const row = db.query<Row, [string]>("SELECT * FROM proof_run WHERE id = ?1").get(runId);
  return row ? toRun(row) : undefined;
}

/** The newest proof run of a pull, any head. */
export function latestProofRun(db: Database, pullId: string): Run | undefined {
  const row = db
    .query<Row, [string]>("SELECT * FROM proof_run WHERE issue_id = ?1 ORDER BY id DESC LIMIT 1")
    .get(pullId);
  return row ? toRun(row) : undefined;
}

/** Whether a proof of `head` was already cut off for this reason, apart from run `except`. */
export function cutOffBefore(db: Database, pullId: string, head: string, reason: string, except: string): boolean {
  return endedBefore(db, pullId, head, "cancelled", cutSummary(reason), except);
}

/** Whether a proof run of `head` other than `except` ended (or waits) as `state` with `summary`. */
export function endedBefore(
  db: Database,
  pullId: string,
  head: string,
  state: RunState,
  summary: string,
  except = "",
): boolean {
  return (
    db
      .query(
        "SELECT 1 FROM proof_run WHERE issue_id = ?1 AND head = ?2 AND id <> ?3 AND state = ?4 AND summary = ?5 LIMIT 1",
      )
      .get(pullId, head, except, state, summary) !== null
  );
}

/** The summary of a proof cut off for `reason`. */
export const cutSummary = (reason: string): string => `cut off: ${reason}`;

/** A waiting proof starts. */
export function startProofRun(db: Database, runId: string, base: string): void {
  db.query(
    `UPDATE proof_run SET state = 'running', base = ?2, summary = '', started_at = ${NOW}
     WHERE id = ?1 AND state = 'queued'`,
  ).run(runId, base);
}

/** A waiting or running proof ends; one already ended stays as it ended. */
export function endProofRun(
  db: Database,
  runId: string,
  state: "ok" | "failed" | "cancelled",
  summary: string,
): void {
  db.query(
    `UPDATE proof_run SET state = ?2, summary = ?3, finished_at = ${NOW}
     WHERE id = ?1 AND state IN ('queued','running')`,
  ).run(runId, state, summary.slice(0, 500));
}

/** A repository's proof runs, newest first, after `cursor`. */
export function listProofRuns(
  db: Database,
  repoId: string,
  options: { state?: RunState | undefined; issueId?: string | undefined; cursor?: string | undefined; limit: number },
): Run[] {
  return db
    .query<Row, [string, string | null, string | null, string | null, number]>(
      `SELECT * FROM proof_run
       WHERE repo_id = ?1 AND (?2 IS NULL OR state = ?2) AND (?3 IS NULL OR issue_id = ?3)
         AND (?4 IS NULL OR id < ?4)
       ORDER BY id DESC LIMIT ?5`,
    )
    .all(repoId, options.state ?? null, options.issueId ?? null, options.cursor ?? null, options.limit)
    .map(toRun);
}
