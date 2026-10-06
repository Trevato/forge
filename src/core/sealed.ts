/**
 * Sealed issues (#621). A security report on a public repository holds
 * exact detail — which path, which check is missing — and must not be read
 * by everyone while the hole is open. A sealed issue, the pull that fixes
 * it, and the runs, events and decisions about them are seen only by
 * people who can write the repository and by its crew; everyone else is
 * told there is no such thing. A writer unseals it, deliberately, and that
 * is recorded.
 *
 * One rule, asked by every surface: `canSeeSealed` for a repository, and
 * `mayView` for one issue. Lists leave sealed rows out unless their caller
 * says the viewer may see them (`sealed: true`), so a list that forgets
 * leaves them out rather than showing them.
 */

import type { Database } from "bun:sqlite";
import { isCrew } from "./agents.ts";
import type { Issue } from "./issues.ts";
import { canWrite, type Repo } from "./repos.ts";
import type { User } from "./users.ts";

/** Whether `user` may see sealed issues on `repo`: a writer, or one of its crew. */
export function canSeeSealed(
  db: Database,
  repo: Repo,
  user: User | undefined,
): boolean {
  if (user === undefined) return false;
  if (canWrite(db, repo, user)) return true;
  return user.kind === "agent" && isCrew(db, repo.id, user.id);
}

/** Whether `user` may see this issue or pull at all. */
export function mayView(
  db: Database,
  repo: Repo,
  issue: Pick<Issue, "sealed">,
  user: User | undefined,
): boolean {
  return !issue.sealed || canSeeSealed(db, repo, user);
}

/** Whether the issue `issueId` is sealed: one read, for an event or a run that names it by id. */
export function sealedById(db: Database, issueId: string): boolean {
  return (
    db
      .query<{ sealed: number }, [string]>("SELECT sealed FROM issue WHERE id = ?1")
      .get(issueId)?.sealed === 1
  );
}

/** Whether issue `number` in `repoId` is sealed. */
export function sealedByNumber(
  db: Database,
  repoId: string,
  number: number,
): boolean {
  return (
    db
      .query<{ sealed: number }, [string, number]>(
        "SELECT sealed FROM issue WHERE repo_id = ?1 AND number = ?2",
      )
      .get(repoId, number)?.sealed === 1
  );
}

/**
 * What an event is about, when it is about one issue or pull: by id (a
 * run's `issueId`) or by number (`issue.*`, `pull.*`). Undefined when it
 * names none.
 */
export function eventSubject(event: {
  readonly repoId: string | null;
  readonly payload: Record<string, unknown>;
}): { id: string } | { repoId: string; number: number } | undefined {
  if (event.repoId === null) return undefined;
  const issueId = event.payload["issueId"];
  if (typeof issueId === "string") return { id: issueId };
  const number = event.payload["number"];
  if (typeof number === "number") return { repoId: event.repoId, number };
  return undefined;
}

/** Whether an event is about a sealed issue or pull. */
export function eventSealed(
  db: Database,
  event: Parameters<typeof eventSubject>[0],
): boolean {
  const subject = eventSubject(event);
  if (subject === undefined) return false;
  return "id" in subject
    ? sealedById(db, subject.id)
    : sealedByNumber(db, subject.repoId, subject.number);
}

/** Seal or unseal. Returns whether it changed. */
export function setSealed(
  db: Database,
  issueId: string,
  sealed: boolean,
): boolean {
  return (
    db
      .query(
        `UPDATE issue SET sealed = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?1 AND sealed != ?2`,
      )
      .run(issueId, sealed ? 1 : 0).changes > 0
  );
}
