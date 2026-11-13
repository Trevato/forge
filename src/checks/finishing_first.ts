/**
 * Land before you build, in the check lane (#6140).
 *
 * A pull brought up to date (a `conflict` run: main moved, the crew merged
 * it in and pushed) is nearly done work; its check is the last thing
 * between it and landing. When a landing conflicts dozens of approved
 * pulls at once, new builds' checks kept the lane full, and the rebases
 * drained one at a time behind them. So a rebase's check goes before any
 * other in the lane, and the conflict room (`crew/conflict_room.ts`)
 * counts only these checks as standing in front of the next rebase.
 *
 * A check is a rebase's when the last builder's run on its pull — any
 * agent run but a review, which comes after the push — was a `conflict`
 * run. Read from the runs alone, so every forge sharing the database
 * agrees on the order.
 */

import type { Database } from "bun:sqlite";

/** The pulls (issue ids), among `issueIds`, whose last builder's run was a bring-up-to-date run. */
export function rebasedPulls(db: Database, issueIds: readonly string[]): Set<string> {
  const ids = [...new Set(issueIds)];
  if (ids.length === 0) return new Set();
  const marks = ids.map((_, i) => `?${i + 1}`).join(",");
  const rows = db
    .query<{ issue_id: string }, string[]>(
      `SELECT a.issue_id FROM run a INDEXED BY run_conflict
        WHERE a.kind = 'agent' AND a.reason = 'conflict' AND a.issue_id IN (${marks})
          AND NOT EXISTS (
            SELECT 1 FROM run b
             WHERE b.issue_id = a.issue_id AND b.kind = 'agent' AND b.reason != 'review'
               AND (b.created_at > a.created_at OR (b.created_at = a.created_at AND b.id > a.id)))`,
    )
    .all(...ids);
  return new Set(rows.map((r) => r.issue_id));
}

/** The runs that are rebases' checks, and the rest: each keeps its order. */
export function rebasesFirst<R extends { readonly issueId: string | null }>(
  db: Database,
  queued: readonly R[],
): { readonly rebases: R[]; readonly rest: R[] } {
  const rebased = rebasedPulls(
    db,
    queued.flatMap((r) => (r.issueId === null ? [] : [r.issueId])),
  );
  const rebases: R[] = [];
  const rest: R[] = [];
  for (const run of queued)
    (run.issueId !== null && rebased.has(run.issueId) ? rebases : rest).push(run);
  return { rebases, rest };
}
