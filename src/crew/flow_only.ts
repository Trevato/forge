/**
 * FLOW ONLY at the dispatcher: while a repository's switch is on, a builder
 * starts only issues labelled `flow`. A planner, a reviewer and the
 * direction issue are not builds, and a pull is never one: rebase, re-check,
 * red-fix and review runs go as ever. An assignment on a held issue is
 * recorded and waits; switching off sweeps it out (`sweepAssigned`).
 */

import type { Database } from "bun:sqlite";
import { labelsFor, type Issue } from "../core/issues.ts";
import type { Repo } from "../core/repos.ts";

export const FLOW_LABEL = "flow";

/** Whether the switch keeps a builder off `issue` now. */
export function flowOnlyHolds(db: Database, repo: Repo, issue: Issue): boolean {
  if (!repo.flowOnly || issue.kind !== "issue") return false;
  if (issue.id === repo.directionIssueId) return false;
  return !labelsFor(db, issue.id).some((l) => l.name.toLowerCase() === FLOW_LABEL);
}

/** The line an assigned issue wears while the switch holds its run; null when nothing is held. */
export function flowOnlyQueued(db: Database, repo: Repo, issue: Issue): string | null {
  if (issue.state !== "open" || !issue.assigneeIsAgent) return null;
  if (!flowOnlyHolds(db, repo, issue)) return null;
  return hadAgentRun(db, issue.id) ? null : "queued: flow only";
}

/** Whether any agent run was ever started on the issue. */
export function hadAgentRun(db: Database, issueId: string): boolean {
  const ran = db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM run WHERE issue_id = ?1 AND kind = 'agent'",
    )
    .get(issueId);
  return ran !== null && ran.n > 0;
}
