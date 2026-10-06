/**
 * Sealed issues (#621). A security report on a public repository holds
 * exact detail — which path, which check is missing — and must not be read
 * by everyone while the hole is open. A sealed issue, the pull that fixes
 * it, and the runs, events and decisions about them are seen only by
 * people who can write the repository and by its crew — and by the person
 * who filed it, for that one issue: a reporter who cannot follow their own
 * report adds no detail, never learns it was handled, and files it again
 * in public. Everyone else is told there is no such thing. A writer
 * unseals it, deliberately, and that is recorded.
 *
 * One rule, asked by every surface: `canSeeSealed` for a repository,
 * `mayView` for one issue, and `sealedScope` for a list. Lists leave
 * sealed rows out unless their caller says whose they may include, so a
 * list that forgets leaves them out rather than showing them.
 */

import type { Database } from "bun:sqlite";
import { isCrew } from "./agents.ts";
import type { Issue } from "./issues.ts";
import { canWrite, type Repo } from "./repos.ts";
import { isActive, type User } from "./users.ts";

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

/** Whether `user` filed this issue and may still follow it: its author, still in good standing. */
function filedBy(authorId: string, user: User | undefined): boolean {
  return user !== undefined && user.id === authorId && isActive(user);
}

/** Whether `user` may see this issue or pull at all. */
export function mayView(
  db: Database,
  repo: Repo,
  issue: Pick<Issue, "sealed" | "authorId">,
  user: User | undefined,
): boolean {
  return (
    !issue.sealed ||
    filedBy(issue.authorId, user) ||
    canSeeSealed(db, repo, user)
  );
}

/**
 * Which sealed rows a list for `user` may include: all of them for a
 * writer or the crew, the user's own for anyone signed in, else none.
 * Spread into `listIssues`, `repoGraph` and the like.
 */
export function sealedScope(
  db: Database,
  repo: Repo,
  user: User | undefined,
): { sealed?: true; sealedBy?: string } {
  if (canSeeSealed(db, repo, user)) return { sealed: true };
  return user !== undefined && isActive(user) ? { sealedBy: user.id } : {};
}

/** What `mayView` reads of an issue named only by id or number. */
export interface SealedRow {
  readonly sealed: boolean;
  readonly authorId: string;
}

/** The issue `issueId` as `mayView` reads it, for an event or a run that names it by id. */
export function sealedRowById(
  db: Database,
  issueId: string,
): SealedRow | undefined {
  const row = db
    .query<{ sealed: number; author_id: string }, [string]>(
      "SELECT sealed, author_id FROM issue WHERE id = ?1",
    )
    .get(issueId);
  return row ? { sealed: row.sealed === 1, authorId: row.author_id } : undefined;
}

/** Whether the issue `issueId` is sealed. */
export function sealedById(db: Database, issueId: string): boolean {
  return sealedRowById(db, issueId)?.sealed === true;
}

/** Issue `number` in `repoId` as `mayView` reads it. */
export function sealedRowByNumber(
  db: Database,
  repoId: string,
  number: number,
): SealedRow | undefined {
  const row = db
    .query<{ sealed: number; author_id: string }, [string, number]>(
      "SELECT sealed, author_id FROM issue WHERE repo_id = ?1 AND number = ?2",
    )
    .get(repoId, number);
  return row ? { sealed: row.sealed === 1, authorId: row.author_id } : undefined;
}

/** Whether issue `number` in `repoId` is sealed. */
export function sealedByNumber(
  db: Database,
  repoId: string,
  number: number,
): boolean {
  return sealedRowByNumber(db, repoId, number)?.sealed === true;
}

/** Whether `user` may see a run, a decision or an event about issue `issueId`. */
export function mayViewId(
  db: Database,
  repo: Repo,
  issueId: string | null,
  user: User | undefined,
): boolean {
  if (issueId === null) return true;
  const row = sealedRowById(db, issueId);
  return row === undefined || mayView(db, repo, row, user);
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

/** The issue or pull an event is about, as `mayView` reads it. */
export function eventRow(
  db: Database,
  event: Parameters<typeof eventSubject>[0],
): SealedRow | undefined {
  const subject = eventSubject(event);
  if (subject === undefined) return undefined;
  return "id" in subject
    ? sealedRowById(db, subject.id)
    : sealedRowByNumber(db, subject.repoId, subject.number);
}

/** Whether an event is about a sealed issue or pull. */
export function eventSealed(
  db: Database,
  event: Parameters<typeof eventSubject>[0],
): boolean {
  return eventRow(db, event)?.sealed === true;
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
