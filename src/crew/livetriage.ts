/**
 * Live triage (#3242), first slice: an issue the crew found already done on
 * the base branch stops waiting for a person to close it. Rules only, no
 * run, no spend. Only the crew's own note (`ALREADY_NOTE`, read through
 * `alreadyDone`) with every commit it names reachable from the default
 * branch closes anything; one commit that is not there leaves the issue
 * open. A second pass over the same state changes nothing, because a closed
 * issue is no longer a candidate.
 *
 * The close is `setIssueState`, whose state change is committed before the
 * event is published; the counters here move only after it returns, so a
 * change that rolled back is neither counted nor announced.
 */

import type { App } from "../app.ts";
import { setIssueState } from "../actions/issues.ts";
import { alreadyDone, CLOSED_NOTE, DONE_LIKE } from "../core/done_on_main.ts";
import { getIssueById } from "../core/issues.ts";
import type { Repo } from "../core/repos.ts";
import { getUserById } from "../core/users.ts";
import { repoDir } from "../git/repos.ts";
import { isMirror } from "../origins/write-through.ts";
import { createLog } from "../kernel/log.ts";
import { onBase } from "./already.ts";

const log = createLog("livetriage");

/** The most changes one repository gets in one tick. */
export const MOST_CHANGES = 25;

/** What a pass did. */
export interface Triaged {
  closed: number;
}

export const none = (): Triaged => ({ closed: 0 });

/**
 * Open issues that carry an already-done note, oldest first. One that
 * already has a close note was closed once and reopened by a person: that
 * reopen stands, so it is not closed again.
 */
function candidates(app: App, repo: Repo): string[] {
  return app.db
    .query<{ id: string }, [string]>(
      `SELECT i.id AS id FROM issue i
        WHERE i.repo_id = ?1 AND i.kind = 'issue' AND i.state = 'open'
          AND EXISTS (SELECT 1 FROM comment n WHERE n.issue_id = i.id
                       AND n.body LIKE '${DONE_LIKE}')
          AND NOT EXISTS (SELECT 1 FROM comment c WHERE c.issue_id = i.id
                           AND c.body LIKE '${CLOSED_NOTE}%')
        ORDER BY i.number`,
    )
    .all(repo.id)
    .map((r) => r.id);
}

/** One repository's pass. */
export async function liveTriage(app: App, repo: Repo): Promise<Triaged> {
  const did = none();
  if (repo.archivedAt !== null || repo.autonomyBy === null) return did;
  if (isMirror(app, repo)) return did;
  const by = getUserById(app.db, repo.autonomyBy);
  if (!by) return did;
  const ids = candidates(app, repo);
  const noted = alreadyDone(app.db, ids);
  if (noted.size === 0) return did;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  for (const id of ids) {
    const oids = noted.get(id);
    if (oids === undefined) continue;
    if (did.closed >= MOST_CHANGES) break;
    const issue = getIssueById(app.db, id);
    if (!issue || issue.state !== "open") continue;
    const there = await onBase(dir, repo.defaultBranch, oids);
    if (there.length !== oids.length) continue;
    try {
      const closed = setIssueState(app, by, repo, issue, "closed", {
        reason: "done",
        triage: true,
      });
      if (closed.ok && closed.value.state === "closed") did.closed++;
    } catch (error) {
      // A rolled-back change: nothing was written and nothing announced.
      log.error("close failed", {
        repo: `${repo.ownerName}/${repo.name}`,
        issue: issue.number,
        error: String(error),
      });
    }
  }
  return did;
}
