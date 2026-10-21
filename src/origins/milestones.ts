/**
 * Milestones from an origin, carried once.
 *
 * A milestone here is an issue that waits for others (`core/milestones.ts`),
 * so a GitHub milestone arrives as an issue: its title, its description as
 * the body, closed when the milestone is. The due date has no column on an
 * issue; it is kept in `milestone_origin` beside the origin's own number,
 * which is also how a second carry finds the milestone it made the first
 * time and leaves it alone — what a person has changed since is theirs.
 *
 * Which issues belong to which milestone is not carried here.
 */

import type { Database } from "bun:sqlite";
import { createIssue, MAX_BODY, MAX_TITLE, setIssueState } from "../core/issues.ts";
import type { RemoteMilestone } from "./types.ts";

/** Control bytes out, length capped: an origin does not get to write a novel. */
const clean = (text: string, limit: number): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").slice(0, limit);

export interface CarriedMilestone {
  readonly issueId: string;
  readonly created: boolean;
}

/** The milestone's due date as kept, or null when it has none. */
export function dueOf(db: Database, repoId: string, originNumber: number): string | null {
  return (
    db
      .query<{ due_on: string | null }, [string, number]>(
        "SELECT due_on FROM milestone_origin WHERE repo_id = ?1 AND origin_number = ?2",
      )
      .get(repoId, originNumber)?.due_on ?? null
  );
}

/** Make the milestone here, unless it already is. Nothing is thrown at an origin's odd data: it is clamped. */
export function carryMilestone(
  db: Database,
  repoId: string,
  actorId: string,
  remote: RemoteMilestone,
): CarriedMilestone | undefined {
  if (!Number.isInteger(remote.number) || remote.number < 1) return undefined;
  const known = db
    .query<{ issue_id: string }, [string, number]>(
      "SELECT issue_id FROM milestone_origin WHERE repo_id = ?1 AND origin_number = ?2",
    )
    .get(repoId, remote.number);
  if (known !== null) return { issueId: known.issue_id, created: false };

  const title = clean(remote.title.replace(/[\r\n\t]+/g, " "), MAX_TITLE).trim();
  const made = createIssue(db, {
    repoId,
    authorId: actorId,
    title: title === "" ? `Milestone ${remote.number}` : title,
    body: clean(remote.description, MAX_BODY),
  });
  if (!made.ok) return undefined;
  if (remote.state === "closed") setIssueState(db, made.value.id, "closed", "done");
  db.query(
    `INSERT INTO milestone_origin (repo_id, origin_number, issue_id, due_on)
     VALUES (?1, ?2, ?3, ?4)`,
  ).run(repoId, remote.number, made.value.id, remote.dueOn);
  return { issueId: made.value.id, created: true };
}
