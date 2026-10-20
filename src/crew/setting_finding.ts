/**
 * A setting the sentinel found away from its default is the owner's ask
 * (#2029), never a crew run. The finding is filed by a crew member, so the
 * autonomy clock would otherwise count it ready and hand it to a builder.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { addComment, setIssueState } from "../actions/issues.ts";
import { getIssueById } from "../core/issues.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { createLog } from "../kernel/log.ts";

const log = createLog("sentinel");

/** Whether this issue is the open finding of a `setting:<key>` the sentinel reported. */
export function isSettingFinding(db: Database, issueId: string): boolean {
  return (
    db
      .query<{ n: number }, [string]>(
        "SELECT 1 AS n FROM sentinel_finding WHERE issue_id = ?1 AND key LIKE 'setting:%'",
      )
      .get(issueId) !== null
  );
}

/**
 * A setting away from its default is a line on the capacity page, not an
 * issue (#3269). Findings filed before that are closed, with a pointer.
 */
export function closeSettingFindings(app: App, repo: Repo, actor: User): void {
  const open = app.db
    .query<{ issue_id: string }, []>(
      `SELECT DISTINCT t.issue_id FROM sentinel_finding t JOIN issue i ON i.id = t.issue_id
        WHERE i.state = 'open' AND t.key LIKE 'setting:%'`,
    )
    .all();
  for (const t of open) {
    try {
      const issue = getIssueById(app.db, t.issue_id);
      if (issue === undefined || issue.repoId !== repo.id) continue;
      const said = addComment(
        app,
        actor,
        repo,
        issue,
        "A setting away from its default is now one line beside it on the capacity page (/settings/capacity), with Put back; the sentinel files no issue for it. Closing.",
      );
      if (!said.ok) continue;
      setIssueState(app, actor, repo, issue, "closed", { reason: "done" });
    } catch (error) {
      log.error("sentinel could not close a setting finding", { issue: t.issue_id, error: String(error) });
    }
  }
}
