/**
 * A pull a person holds with changes requested by a reviewer is stuck: a
 * person's name on it stops the crew (`agentFor`), and a person who has not
 * answered will not move it. After a day of the person's silence it goes back
 * to its builder, as the ask's "Give to the crew" would. The sweep reads the
 * database each tick and keeps no memory, so it also covers the pulls that
 * were already stranded when it first ran; once given back, a pull no longer
 * matches.
 */

import type { App } from "../app.ts";
import { crewHandFor, handBack } from "../actions/give_back.ts";
import { getHold } from "../core/holds.ts";
import { getIssueById } from "../core/issues.ts";
import { reviewSummariesFor } from "../core/reviews.ts";
import { lastPersonAction, WAIT_LIMIT_MS } from "../core/pull_wait.ts";
import { getRepoById } from "../core/repos.ts";
import { getUserById } from "../core/users.ts";
import { createLog } from "../kernel/log.ts";

const log = createLog("stranded");

/** Pulls given back in one tick: paced, since each starts a run. */
export const PER_TICK = 3;

/** The line a pull given back this way carries. */
export const STRANDED_LINE =
  "Given back to the crew: a reviewer asked for changes and no one answered for a day, so the builder takes it again.";

interface Row {
  id: string;
  at: string;
  head: string;
}

/** Open pulls held by a person whose newest verdict by a crew reviewer asks for changes, with that verdict's time. */
function strandedRows(app: App): Row[] {
  return app.db
    .query<Row, []>(
      `SELECT i.id AS id, r.created_at AS at, p.head_oid AS head
         FROM issue i
         JOIN pull p ON p.issue_id = i.id
         JOIN user a ON a.id = i.assignee_id AND a.kind = 'user' AND a.is_agent = 0
         JOIN review r ON r.issue_id = i.id
         JOIN repo_crew c ON c.user_id = r.author_id AND c.repo_id = i.repo_id AND c.role = 'reviewer'
        WHERE i.kind = 'pull' AND i.state = 'open'
          AND r.state = 'changes_requested'
          AND r.created_at = (SELECT MAX(r2.created_at) FROM review r2
                               JOIN repo_crew c2 ON c2.user_id = r2.author_id AND c2.repo_id = i.repo_id AND c2.role = 'reviewer'
                              WHERE r2.issue_id = i.id)
        GROUP BY i.id
        ORDER BY r.created_at
        LIMIT 200`,
    )
    .all();
}

/**
 * When the pull was last assigned: the newest `pull.assigned` event. The
 * `+ 0` and `INDEXED BY` keep it on the event expression index, as the
 * dispatcher's assigner read does, never a scan of `event`.
 */
function assignedAt(app: App, repoId: string, number: number): string | undefined {
  return (
    app.db
      .query<{ at: string }, [string, number]>(
        `SELECT e.created_at AS at FROM event e INDEXED BY event_repo_kind_number_at
          WHERE e.repo_id = ?1 AND e.kind = 'pull.assigned'
            AND json_extract(e.payload, '$.number') = ?2 + 0
          ORDER BY e.created_at DESC LIMIT 1`,
      )
      .get(repoId, number)?.at ?? undefined
  );
}

/** Give back every stranded pull whose person has been silent a day; returns the pull numbers moved. */
export function sweepStranded(app: App, now = new Date()): number[] {
  const moved: number[] = [];
  const rows = strandedRows(app);
  const pulls = rows.flatMap((r) => {
    const p = getIssueById(app.db, r.id);
    return p === undefined ? [] : [p];
  });
  const acted = lastPersonAction(app.db, pulls);
  const asked = new Map(rows.map((r) => [r.id, r.at]));
  // The verdict counts only on the head it judged: a change asked of an older push strands nothing.
  const verdicts = reviewSummariesFor(app.db, rows.map((r) => ({ id: r.id, headOid: r.head })));
  for (const pull of pulls) {
    if (moved.length >= PER_TICK) break;
    if ((verdicts.get(pull.id)?.changesRequested ?? 0) === 0) continue;
    // The day starts no earlier than the person was handed it.
    const handed = assignedAt(app, pull.repoId, pull.number);
    const quietSince = [asked.get(pull.id)!, acted.get(pull.id)!, handed ?? ""].reduce((a, b) => (a > b ? a : b));
    if (now.getTime() - Date.parse(quietSince) < WAIT_LIMIT_MS) continue;
    if (getHold(app.db, pull.id) !== undefined) continue;
    const repo = getRepoById(app.db, pull.repoId);
    if (repo === undefined || repo.archivedAt !== null) continue;
    // The sweep is no person: the assignment is recorded under the person who
    // switched the repository's autonomy on (as the stale-red sweep does), else
    // under the holder, whose write the reassignment needs. Either way the
    // comment says the forge did it, not them.
    const holder = pull.assigneeId === null ? undefined : getUserById(app.db, pull.assigneeId);
    const actor = (repo.autonomyBy === null ? undefined : getUserById(app.db, repo.autonomyBy)) ?? holder;
    const builder = crewHandFor(app.db, repo, pull);
    if (actor === undefined || builder === undefined) continue;
    const done = handBack(app, actor, repo, pull, builder, STRANDED_LINE);
    if (done.ok) moved.push(pull.number);
    else log.warn("a stranded pull could not go back", { repo: `${repo.ownerName}/${repo.name}`, pull: pull.number, why: done.error.message });
  }
  return moved;
}
