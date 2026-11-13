/**
 * An interrupted run is not a park. A builder's run the provider ended —
 * a usage window full, the API unreachable — or the forge stopped by its
 * own restart says nothing about the work: nobody attempted it. Such a run
 * is recorded as `interrupted: <cause>, resumes <when>`, writes no park
 * note and is no strike against the issue; the clock picks it up again.
 */

import type { Database } from "bun:sqlite";
import { whenText } from "./limits.ts";
import { NETWORK as NETWORK_ERROR } from "./network.ts";

export type Interruption = "provider limit" | "network error" | "restart" | "clone";

/** What every interrupted run's summary starts with. */
export const INTERRUPTED = "interrupted: ";

const PROVIDER =
  /rate[ _-]?limit|session limit|usage limit|weekly limit|hit your \w+ limit|overloaded|too many requests|\b(?:429|529)\b|\(api_error\)|may use is resting|resting —/i;
// A summary also says it in words an outcome never carries.
const NETWORK = new RegExp(`${NETWORK_ERROR.source}|could not reach|unreachable`, "i");
const RESTART =
  /^cancelled$|interrupted by a restart|stopped for a restart|the forge stopped/i;
// The runner's own words when the forge could not clone, fetch or check
// out: the run never reached the agent (#6263).
const CLONE = /^(?:clone|checkout|fetch(?: from the fork)?) failed:/i;

/**
 * Why a run that ended without a pull was cut short, read from its summary
 * — one written by `interruptedSummary`, or an older one that names a
 * provider limit, a network error or a restart — or undefined when the run
 * really ended on the work. A decline is the agent's own word, never this.
 */
export function interruptionOf(summary: string): Interruption | undefined {
  const s = summary.trim();
  if (s.startsWith(INTERRUPTED)) {
    const cause = s.slice(INTERRUPTED.length);
    if (cause.startsWith("provider limit")) return "provider limit";
    if (cause.startsWith("network error")) return "network error";
    if (cause.startsWith("clone")) return "clone";
    return "restart";
  }
  if (/^declined\b/i.test(s)) return undefined;
  if (CLONE.test(s)) return "clone";
  if (RESTART.test(s)) return "restart";
  if (NETWORK.test(s)) return "network error";
  if (PROVIDER.test(s)) return "provider limit";
  return undefined;
}

/**
 * The summary a failed run is recorded with: `interrupted: provider limit,
 * resumes 02:00 UTC — <what happened>` when it was cut short, the summary
 * as it was otherwise.
 */
export function interruptedSummary(
  summary: string,
  resumesAt?: Date,
): string {
  if (summary.startsWith(INTERRUPTED)) return summary;
  const cause = interruptionOf(summary);
  if (cause === undefined) return summary;
  const when =
    resumesAt === undefined ? "resumes on the next pass" : `resumes ${whenText(resumesAt)}`;
  return `${INTERRUPTED}${cause}, ${when} — ${summary}`;
}

/** The agent runs on an issue that were interrupted, newest first, for its page. */
export function interruptionsOn(
  db: Database,
  issueId: string,
): { summary: string; at: string }[] {
  return db
    .query<{ summary: string; at: string }, [string]>(
      `SELECT summary, COALESCE(finished_at, created_at) AS at FROM run
       WHERE issue_id = ?1 AND kind = 'agent' AND summary LIKE 'interrupted: %'
       ORDER BY created_at DESC LIMIT 20`,
    )
    .all(issueId);
}

/** What a run reads as once its pull has landed: done, never failed, interrupted or in progress. */
export const landedSummary = (number: number): string => `Landed: pull #${number} is live`;

/**
 * The number of the merged pull this run worked on — by its issue, else its
 * branch — or undefined while none has landed.
 */
export function landedPullOf(
  db: Database,
  run: { repoId: string; issueId: string | null; branch: string | null; createdAt: string },
): number | undefined {
  const row = db
    .query<{ number: number }, [string, string | null, string | null, string]>(
      `SELECT issue.number AS number FROM pull JOIN issue ON issue.id = pull.issue_id
       WHERE pull.merged_at IS NOT NULL AND issue.repo_id = ?1
         AND pull.merged_at >= ?4
         AND (pull.issue_id = ?2 OR (?3 IS NOT NULL AND pull.head_branch = ?3))
       ORDER BY pull.merged_at DESC LIMIT 1`,
    )
    .get(run.repoId, run.issueId, run.branch, run.createdAt);
  return row?.number;
}

/**
 * Record a run whose pull landed as done: `ok`, "Landed: pull #N is live".
 * Only a run not finished, or one the landing or a restart ended as cancelled
 * or interrupted, is touched; a run that really failed keeps its words.
 * Returns whether a row changed.
 */
export function settleLanded(db: Database, runId: string, number: number): boolean {
  return (
    db
      .query(
        `UPDATE run SET state = 'ok', summary = ?2,
           finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         WHERE id = ?1 AND (state IN ('queued','running','cancelled')
           OR (state = 'failed' AND summary LIKE 'interrupted: %'))`,
      )
      .run(runId, landedSummary(number)).changes > 0
  );
}

/**
 * A pull just landed: every agent run still queued or running on its issue
 * or its branch reads as done at once, not "In progress" until it ends.
 * Answers the runs it settled.
 */
export function settleLandedRuns(
  db: Database,
  pull: { issueId: string; headBranch: string; number: number; repoId: string },
): string[] {
  const ids = db
    .query<{ id: string }, [string, string, string]>(
      `SELECT id FROM run WHERE repo_id = ?1 AND kind = 'agent'
         AND state IN ('queued','running')
         AND (issue_id = ?2 OR branch = ?3)`,
    )
    .all(pull.repoId, pull.issueId, pull.headBranch);
  return ids.filter(({ id }) => settleLanded(db, id, pull.number)).map(({ id }) => id);
}
