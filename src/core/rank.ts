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

/** A repository's ranks: each issue's place, and which of those issues a person placed. */
export interface Ranks {
  readonly places: ReadonlyMap<string, number>;
  readonly owners: ReadonlySet<string>;
}

/** Every rank in one repository: the issue id and its place, 1 at the top. */
export function ranksInRepo(db: Database, repoId: string): Ranks {
  const rows = db
    .query<{ issue_id: string; pos: number; by_owner: number }, [string]>(
      `SELECT r.issue_id, r.pos, r.by_owner FROM issue_rank r JOIN issue i ON i.id = r.issue_id
        WHERE i.repo_id = ?1 AND i.state = 'open'`,
    )
    .all(repoId);
  return {
    places: new Map(rows.map((r) => [r.issue_id, r.pos] as const)),
    owners: new Set(rows.filter((r) => r.by_owner === 1).map((r) => r.issue_id)),
  };
}

/** Forget the rank: the issue closed, or the owner said "Not now". */
export function clearRank(db: Database, issueId: string): void {
  db.query("DELETE FROM issue_rank WHERE issue_id = ?1").run(issueId);
}

/**
 * Make `order` the whole ranking of a repository: places 1..n in that order,
 * every other rank dropped. The caller's transaction makes it one write.
 * `by` says who is ranking: a person (`owner: true`) marks the rows it moves
 * (`moved`, else all) as the owner's; the planner or a keeper (`owner: false`)
 * leaves every owner-ranked row at its place and orders only the rest around
 * them. A row's mark survives a write that does not move it.
 */
export function writeOrder(
  db: Database,
  repo: Repo,
  order: readonly string[],
  actorId: string,
  at = new Date().toISOString(),
  by: { readonly owner: boolean; readonly moved?: string } = { owner: true },
): void {
  const before = db
    .query<{ issue_id: string; pos: number; by_owner: number }, [string]>(
      `SELECT r.issue_id, r.pos, r.by_owner FROM issue_rank r JOIN issue i ON i.id = r.issue_id WHERE i.repo_id = ?1`,
    )
    .all(repo.id);
  const owned = new Map(before.filter((r) => r.by_owner === 1).map((r) => [r.issue_id, r.pos]));
  let placed: string[];
  if (by.owner) placed = [...order];
  else {
    // Pinned rows keep their place; the others fill the free places in order.
    const free = order.filter((id) => !owned.has(id));
    const pinned = [...owned].filter(([id]) => order.includes(id)).sort((x, y) => x[1] - y[1]);
    placed = [...free];
    for (const [id, pos] of pinned) placed.splice(Math.min(pos - 1, placed.length), 0, id);
  }
  db.query(
    "DELETE FROM issue_rank WHERE issue_id IN (SELECT id FROM issue WHERE repo_id = ?1)",
  ).run(repo.id);
  const put = db.query(
    "INSERT INTO issue_rank (issue_id, pos, actor_id, at, by_owner) VALUES (?1, ?2, ?3, ?4, ?5)",
  );
  placed.forEach((id, n) => {
    // An owner's move marks the row it moved (every row when none is named);
    // a row already the owner's stays so; a planner's write marks nothing new.
    const movedByOwner = by.owner && (by.moved === undefined || id === by.moved);
    const mark = movedByOwner || owned.has(id);
    put.run(id, n + 1, actorId, at, mark ? 1 : 0);
  });
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
