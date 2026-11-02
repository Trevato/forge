/**
 * Which queued checks belong to an approved pull (#6396), for `pickNext`.
 *
 * A check is an approved pull's when its own commit carries an approval and
 * no change requested: the rule `crew/finishing.ts` calls `approvedOnHead`,
 * read for the run's commit rather than the pull's current head, so a check
 * for a head since pushed over does not jump the queue.
 */

import type { Database } from "bun:sqlite";
import { reviewSummary } from "../core/reviews.ts";
import type { Run } from "../core/runs.ts";

/** Whether the run's pull has an approval on the run's commit and no change requested there. */
export function approvedForCheck(db: Database, run: Pick<Run, "issueId" | "commitOid">): boolean {
  if (run.issueId === null) return false;
  const seen = reviewSummary(db, run.issueId, run.commitOid);
  return seen.approvals > 0 && seen.changesRequested === 0;
}

/** `approvedForCheck`, asked at most once per run for as long as the predicate lives. */
export function approvedOnce(db: Database): (run: Run) => boolean {
  const known = new Map<string, boolean>();
  return (run) => {
    let yes = known.get(run.id);
    if (yes === undefined) known.set(run.id, (yes = approvedForCheck(db, run)));
    return yes;
  };
}
