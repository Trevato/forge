/**
 * A crew pull that stays conflicted is only a longer rebase (#5940). One
 * that has been conflicted for 72 hours, with no push in that time, is
 * closed with one line, and the issue it closed goes back to ready,
 * unassigned, to be built fresh from main.
 *
 * `sweepConflicts` (`autonomy.ts`) already reads every open crew pull per
 * pair of tips and keeps since when each has conflicted at its present
 * head; it calls `closeStale` for one past `STALE_MS`. It leaves a held
 * pull and one approved on its head alone before it gets here, so those
 * are never closed. A pull that names no issue to build again is not
 * closed either.
 */

import type { App } from "../app.ts";
import { assignIssue, addComment, setIssueState } from "../actions/issues.ts";
import { getIssue, getIssueById } from "../core/issues.ts";
import { closesFromBody, type Pull } from "../core/pulls.ts";
import { type Repo } from "../core/repos.ts";
import { getUserById } from "../core/users.ts";
import { createLog } from "../kernel/log.ts";

const log = createLog("stale-pulls");

/** How long a pull may stay conflicted, unpushed, before it is closed. */
export const STALE_MS = 72 * 3_600_000;

/** The one line the pull is closed with. */
export const closedLine = (issueNumber: number): string =>
  `Closed after 3 days in conflict; #${issueNumber} is ready again and will be built fresh from main.`;

/**
 * Close one pull that has conflicted since `since` and free its issue. False
 * when it has not been 72 hours, or there is nothing to build again.
 */
export function closeStale(app: App, repo: Repo, pull: Pull, since: string, now: Date): boolean {
  if (now.getTime() - Date.parse(since) < STALE_MS) return false;
  const by = repo.autonomyBy ? getUserById(app.db, repo.autonomyBy) : undefined;
  const issue = getIssueById(app.db, pull.id);
  if (!by || !issue || issue.state !== "open") return false;
  const about = closesFromBody(pull.body)
    .map((n) => getIssue(app.db, repo.id, n))
    .find((i) => i !== undefined && i.kind === "issue" && i.state === "open");
  if (about === undefined) return false;
  addComment(app, by, repo, issue, closedLine(about.number));
  const closed = setIssueState(app, by, repo, issue, "closed", { reason: "parked", stale: true });
  if (!closed.ok) return false;
  if (about.assigneeId !== null) assignIssue(app, by, repo, about, null);
  log.info("stale pull closed", { repo: `${repo.ownerName}/${repo.name}`, pull: pull.number });
  return true;
}

/** How many stale pulls the crew closed in this repository today (UTC), for the tick line. */
export function closedToday(app: App, repoId: string, now: Date = new Date()): number {
  const from = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  // Counted in SQL: no rows built or parsed, and the index finds the day (#8103).
  const row = app.db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM event
       WHERE repo_id = ?1 AND kind = 'pull.closed' AND created_at >= ?2
         AND json_extract(payload, '$.stale') = 1`,
    )
    .get(repoId, from);
  return row?.n ?? 0;
}
