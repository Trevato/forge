/**
 * The owner's answer to a setting the sentinel found away from its default
 * (#2029): Keep it, or Put it back. Both close the finding as a person, so
 * the close is a person's on the record. Putting back goes through
 * `changeCapacity`, the capacity page's own door: the same validation, the
 * same record and event, the same reversal.
 */

import type { App } from "../app.ts";
import { isCapacityKey, storedCapacity } from "../core/capacity.ts";
import { getIssueById } from "../core/issues.ts";
import { canWrite, getRepoById } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { recordKept } from "../crew/sentinel.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { changeCapacity } from "./capacity.ts";
import { setIssueState } from "./issues.ts";

export type SettingAnswer = "keep" | "put";

/** The open findings for `setting:<key>` in repositories this person writes. */
export function openFindings(app: App, actor: User, key: string): string[] {
  return app.db
    .query<{ issue_id: string }, [string]>(
      `SELECT t.issue_id FROM sentinel_finding t JOIN issue i ON i.id = t.issue_id
        WHERE t.key = ?1 AND i.state = 'open' ORDER BY i.created_at`,
    )
    .all(`setting:${key}`)
    .map((r) => r.issue_id)
    .filter((id) => {
      const issue = getIssueById(app.db, id);
      const repo = issue && getRepoById(app.db, issue.repoId);
      return issue !== undefined && repo !== undefined && canWrite(app.db, repo, actor);
    });
}

export function answerSetting(
  app: App,
  actor: User | undefined,
  key: unknown,
  answer: unknown,
  now = new Date(),
): Result<{ key: string; answer: SettingAnswer }, "unauthorized" | "not_found" | "forbidden" | "invalid"> {
  if (!actor || actor.kind === "agent") return err("unauthorized");
  if (!actor.isAdmin) return err("not_found");
  if (typeof key !== "string" || !isCapacityKey(key)) return err("not_found");
  if (answer !== "keep" && answer !== "put") return err("invalid");
  const findings = openFindings(app, actor, key);
  if (findings.length === 0) return err("not_found");
  if (answer === "put") {
    const put = changeCapacity(app, actor, key, null);
    if (!put.ok) return err(put.error === "not_found" ? "forbidden" : "invalid");
  }
  const stored = storedCapacity(app.db, key);
  const row = app.db
    .query<{ updated_at: string }, [string]>("SELECT updated_at FROM forge_setting WHERE key = ?1")
    .get(key);
  let closed = 0;
  for (const id of findings) {
    const issue = getIssueById(app.db, id);
    const repo = issue && getRepoById(app.db, issue.repoId);
    if (issue === undefined || repo === undefined) continue;
    const done = setIssueState(app, actor, repo, issue, "closed", { reason: answer === "keep" ? "dropped" : "done" });
    if (done.ok) closed++;
  }
  // A kept value is recorded only when a close went through; otherwise the finding is still open.
  if (closed === 0) return err("forbidden");
  if (answer === "keep" && stored !== undefined && row !== null)
    recordKept(app.db, `setting:${key}`, stored, row.updated_at, now.toISOString());
  return ok({ key, answer });
}
