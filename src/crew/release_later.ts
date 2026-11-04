/**
 * Releasing what the Later gate holds by an old rule (#7801). Before #7797
 * triage linked an issue to wait for the gate when it named no pillar; the
 * rule is gone, the links stayed. An issue is held by the gate alone when
 * the gate is the only open issue it waits for. Releasing it deletes that
 * one edge (`removeDependency`) and nothing else: it keeps its pillar
 * links, and any other open blocker keeps it blocked.
 *
 * Reads and one-row deletes only; `scripts/release-later.ts` is the owner's
 * way in, and lists before it writes.
 */

import type { Database } from "bun:sqlite";
import { removeDependency } from "../core/dependencies.ts";
import { getIssueById } from "../core/issues.ts";
import { servePillar } from "../core/pillar_pick.ts";
import { getRepoById } from "../core/repos.ts";
import { laterGate } from "./later.ts";

export interface Held {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  /** Who linked it to the gate; "unknown" when the edge kept no actor. */
  readonly linkedBy: string;
}

/** Open issues of a repository that wait for the open Later gate and for no other open issue. */
export function heldByGateAlone(db: Database, repoId: string): Held[] {
  const gate = laterGate(db, repoId);
  if (gate === undefined) return [];
  return db
    .query<Held, [string, number]>(
      `SELECT i.id AS id, i.number AS number, i.title AS title,
              COALESCE(u.username, 'unknown') AS linkedBy
         FROM issue i
         JOIN issue_dependency d ON d.issue_id = i.id
         JOIN issue g ON g.id = d.blocked_by_id AND g.repo_id = i.repo_id AND g.number = ?2
         LEFT JOIN user u ON u.id = d.actor_id
        WHERE i.repo_id = ?1 AND i.kind = 'issue' AND i.state = 'open'
          AND NOT EXISTS (
            SELECT 1 FROM issue_dependency o
              JOIN issue b ON b.id = o.blocked_by_id
             WHERE o.issue_id = i.id AND o.blocked_by_id <> g.id AND b.state = 'open')
        ORDER BY i.number`,
    )
    .all(repoId, gate);
}

/** Delete the gate edge of each issue named, all in one transaction (a failure releases none); returns the numbers released. */
export function releaseFromGate(db: Database, repoId: string, numbers: readonly number[], actorId?: string): number[] {
  return db.transaction(() => release(db, repoId, numbers, actorId)).immediate();
}

function release(db: Database, repoId: string, numbers: readonly number[], actorId?: string): number[] {
  const number = laterGate(db, repoId);
  if (number === undefined) return [];
  const gate = db
    .query<{ id: string }, [string, number]>(
      "SELECT id FROM issue WHERE repo_id = ?1 AND number = ?2",
    )
    .get(repoId, number);
  if (gate === null) return [];
  const want = new Set(numbers);
  const out: number[] = [];
  const repo = actorId === undefined ? undefined : getRepoById(db, repoId);
  for (const held of heldByGateAlone(db, repoId))
    if (want.has(held.number) && removeDependency(db, held.id, gate.id)) {
      out.push(held.number);
      // Released means startable: under a pillar, in the releaser's name (#8924).
      const issue = repo === undefined ? undefined : getIssueById(db, held.id);
      if (repo !== undefined && issue !== undefined && actorId !== undefined) servePillar(db, repo, issue, actorId);
    }
  return out;
}
