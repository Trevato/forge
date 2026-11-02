/**
 * An open issue a merged pull says it closes (#8482). A landing closes what
 * it names only when every box is ticked (`mergePull`); otherwise the issue
 * stays open with a note saying which pull landed and what is left. Handing
 * it to a builder then sends them to redo shipped work, so the picker holds
 * it (`held.ts`, `landed`) until a person answers: comments, edits the body
 * — ticking is an edit — or reopens it. Closing it takes it off the map.
 *
 * Only an issue with a box still unticked is read: one with none left that a
 * merge did not close was reopened since, or is the plan's own (umbrellas,
 * the Later gate), which no landing closes whatever its boxes say.
 */

import type { Database } from "bun:sqlite";
import { LANDED_LEAD, unticked } from "../core/done_on_main.ts";
import type { Issue } from "../core/issues.ts";
import { mergedPullClosing, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { getUserById } from "../core/users.ts";
import { mayDirectCrew } from "./direct.ts";

/** The landing's own note on the issue, which is not an answer to it. */
const NOT_THE_NOTE = `NOT (e.kind = 'issue.commented'
  AND json_extract(e.payload, '$.body') LIKE '${LANDED_LEAD.replace(/[%_']/g, "")}%')`;

/**
 * The merged pull that shipped `issue` while it stays open with boxes
 * unticked, when no person who may direct the crew has commented on it,
 * edited it or reopened it since that pull landed. Undefined otherwise.
 * Walks `event_repo_kind_number_at`.
 */
export function landedUnanswered(db: Database, repo: Repo, issue: Issue): Pull | undefined {
  if (issue.kind !== "issue" || issue.state !== "open") return undefined;
  if (unticked(issue.body).length === 0) return undefined;
  const pull = mergedPullClosing(db, repo.id, issue.number);
  if (pull === undefined || pull.mergedAt === null) return undefined;
  const actors = db
    .query<{ actor: string }, [string, number, string]>(
      `SELECT DISTINCT e.actor_id AS actor FROM event e
        WHERE e.repo_id = ?1 AND e.kind IN ('issue.commented', 'issue.edited', 'issue.reopened')
          AND json_extract(e.payload, '$.number') = ?2 AND e.created_at >= ?3
          AND e.actor_id IS NOT NULL AND ${NOT_THE_NOTE}`,
    )
    .all(repo.id, issue.number, pull.mergedAt);
  const answered = actors.some((r) => {
    const who = getUserById(db, r.actor);
    return who !== undefined && who.kind !== "agent" && mayDirectCrew(db, repo, who);
  });
  return answered ? undefined : pull;
}
