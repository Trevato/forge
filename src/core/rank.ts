/**
 * "Next up" (#8694): the owner's one ranked list. A rank is a place in line,
 * 1 at the top, one row per issue; the dispatcher starts the highest ranked
 * issue that is startable before any other (`readyNow`), and a rank never
 * lifts a blocker — only `lift` removes the Later gate's hold, and only when
 * a person asks for the issue on top. The rank is cleared when the issue
 * closes or goes to "Not now".
 */

import type { Database } from "bun:sqlite";
import { removeDependency } from "./dependencies.ts";
import { pillarsOf } from "./pillars.ts";
import type { Repo } from "./repos.ts";

/** The most issues one repository ranks: a move rewrites the whole list, so it is bounded. */
export const MAX_RANKED = 200;

/** Every rank in one repository: the issue id and its place, 1 at the top. */
export function ranksInRepo(db: Database, repoId: string): Map<string, number> {
  return new Map(
    db
      .query<{ issue_id: string; pos: number }, [string]>(
        `SELECT r.issue_id, r.pos FROM issue_rank r JOIN issue i ON i.id = r.issue_id
          WHERE i.repo_id = ?1 AND i.state = 'open'`,
      )
      .all(repoId)
      .map((r) => [r.issue_id, r.pos]),
  );
}

/** Forget the rank: the issue closed, or the owner said "Not now". */
export function clearRank(db: Database, issueId: string): void {
  db.query("DELETE FROM issue_rank WHERE issue_id = ?1").run(issueId);
}

/**
 * Make `order` the whole ranking of a repository: places 1..n in that order,
 * every other rank dropped. The caller's transaction makes it one write.
 */
export function writeOrder(
  db: Database,
  repo: Repo,
  order: readonly string[],
  actorId: string,
  at = new Date().toISOString(),
): void {
  db.query(
    "DELETE FROM issue_rank WHERE issue_id IN (SELECT id FROM issue WHERE repo_id = ?1)",
  ).run(repo.id);
  const put = db.query(
    "INSERT INTO issue_rank (issue_id, pos, actor_id, at) VALUES (?1, ?2, ?3, ?4)",
  );
  order.forEach((id, n) => put.run(id, n + 1, actorId, at));
}

/**
 * Take an issue past the Later gate: delete the edge that makes it wait for
 * the gate, and the Later umbrella's edge to it. Returns whether any hold
 * was removed. What only deferred work needs stays deferred; `deferred`
 * says so after.
 */
export function lift(db: Database, repo: Repo, issueId: string): boolean {
  const set = pillarsOf(db, repo);
  let lifted = false;
  if (set.gate !== undefined) lifted = removeDependency(db, issueId, set.gate.id) || lifted;
  if (set.later !== undefined) lifted = removeDependency(db, set.later.id, issueId) || lifted;
  return lifted;
}
