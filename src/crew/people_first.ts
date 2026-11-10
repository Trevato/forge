/**
 * A person's word starts first (#10365, sandbox-game#18). A queued run that
 * carries a person's ask — a person's comment (a `feedback` run whose actor
 * is not an agent), an issue a person assigned, or a note sent from an app
 * (`from-app`) — goes ahead of the crew's own picks, reruns and reviews, each
 * side keeping its order. The pace's lane for reviews and assigned work
 * (`week_hold.ts`) still decides whether a slot is open; this is only the
 * order of the queue in front of it. Pure but for two reads of the database.
 */

import type { Database } from "bun:sqlite";
import { fromAppIssues } from "../core/from_app.ts";
import type { Run } from "../core/runs.ts";

/** The actors among `ids` who are people, not agents. */
function people(db: Database, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const marks = ids.map(() => "?").join(",");
  return new Set(
    db
      .query<{ id: string }, string[]>(
        `SELECT id FROM user WHERE id IN (${marks}) AND is_agent = 0`,
      )
      .all(...ids)
      .map((r) => r.id),
  );
}

/**
 * `queued` with the runs that carry a person's ask first, in their order,
 * then the rest in theirs. `assignedByPerson` says whether an `assigned`
 * run's newest assignment was a person's (`dispatch.ts` keeps that read).
 */
export function peopleFirst(
  db: Database,
  queued: readonly Run[],
  assignedByPerson: (run: Run) => boolean,
): Run[] {
  if (queued.length < 2) return [...queued];
  const fromApp = fromAppIssues(
    db,
    queued.flatMap((r) => (r.issueId === null ? [] : [r.issueId])),
  );
  const spoke = people(
    db,
    queued.flatMap((r) =>
      r.reason === "feedback" && r.actorId !== null ? [r.actorId] : [],
    ),
  );
  const personal = (r: Run): boolean =>
    (r.issueId !== null && fromApp.has(r.issueId)) ||
    (r.reason === "feedback" && r.actorId !== null && spoke.has(r.actorId)) ||
    (r.reason === "assigned" && assignedByPerson(r));
  const first = queued.filter(personal);
  if (first.length === 0 || first.length === queued.length) return [...queued];
  return [...first, ...queued.filter((r) => !personal(r))];
}
