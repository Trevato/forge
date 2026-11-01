/**
 * The trace a merge-queue gate leaves (#6426): one `check_gate` row from
 * the moment it takes a check slot to the moment it lets go, whatever its
 * verdict. A gate writes no `run`, so without this the slot minutes it spends
 * are nowhere; `flow/gate_minutes.ts` reads them. A row a crash left open is
 * clipped there at the queue's deadline. Rows older than `KEEP_MS` are pruned
 * as each new one is written.
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";

/** How long a gate's row is kept: longer than any window the flow reads. */
export const KEEP_MS = 7 * 24 * 3_600_000;

/** A gate took its slot: the row's id, for `endGate`. */
export function beginGate(
  db: Database,
  repoId: string,
  issueId: string | undefined,
  commitOid: string,
  now = new Date(),
): string {
  const gateId = id();
  db.query("DELETE FROM check_gate WHERE started_at < ?1").run(
    new Date(now.getTime() - KEEP_MS).toISOString(),
  );
  db.query(
    "INSERT INTO check_gate (id, repo_id, issue_id, commit_oid, started_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).run(gateId, repoId, issueId ?? null, commitOid, now.toISOString());
  return gateId;
}

/** The gate let go of its slot, answered or cut off. */
export function endGate(db: Database, gateId: string, now = new Date()): void {
  db.query("UPDATE check_gate SET finished_at = ?2 WHERE id = ?1 AND finished_at IS NULL").run(
    gateId,
    now.toISOString(),
  );
}

/**
 * Whether a gate on a commit starting with `prefix` (the 12 characters
 * `gateRunId` keeps) still holds its slot: open, and started after `since`.
 * A gate writes no `run`, so this is what keeps the checkout sweep off its
 * directory while it runs; a row a crash left open stops counting at `since`.
 */
export function gateHolding(db: Database, prefix: string, since: Date): boolean {
  return (
    db
      .query(
        "SELECT 1 FROM check_gate WHERE finished_at IS NULL AND substr(commit_oid, 1, ?1) = ?2 AND started_at > ?3 LIMIT 1",
      )
      .get(prefix.length, prefix, since.toISOString()) !== null
  );
}
