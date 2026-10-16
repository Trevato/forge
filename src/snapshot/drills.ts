/**
 * The drills, kept: every run of `runDrill` is a row, so the Backups page
 * can say when the forge last proved a snapshot restores, and what failed
 * when it did not. Plain data in, plain data out.
 */

import type { Database } from "bun:sqlite";
import type { DrillResult, DrillStep } from "./drill.ts";

interface Row {
  at: string;
  snapshot_id: string | null;
  ms: number;
  repositories: number;
  issues: number;
  users: number;
  pulls: number;
  apps: number;
  verdict: "green" | "red";
  failed_step: DrillStep | null;
  reason: string | null;
}

export function recordDrill(db: Database, result: DrillResult): void {
  db.query(
    `INSERT INTO drill (at, snapshot_id, ms, repositories, issues, users, pulls, apps, verdict, failed_step, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    result.at,
    result.snapshotId,
    result.ms,
    result.counts.repositories,
    result.counts.issues,
    result.counts.users,
    result.counts.pulls,
    result.counts.apps,
    result.verdict,
    result.failedStep,
    result.reason,
  );
}

/** The newest drill, or undefined when none has run. */
export function lastDrill(db: Database): DrillResult | undefined {
  const row = db
    .query<Row, []>("SELECT * FROM drill ORDER BY id DESC LIMIT 1")
    .get();
  return row === null
    ? undefined
    : {
        at: row.at,
        snapshotId: row.snapshot_id,
        ms: row.ms,
        counts: {
          repositories: row.repositories,
          issues: row.issues,
          users: row.users,
          pulls: row.pulls,
          apps: row.apps,
        },
        // Not stored: green means health read ok; a red one failed at it or never got there.
        health:
          row.verdict === "green" ? "ok" : row.failed_step === "health" ? "failed" : "unreached",
        verdict: row.verdict,
        failedStep: row.failed_step,
        reason: row.reason,
      };
}
