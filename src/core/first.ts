/**
 * "This first" (#7806): a writer puts an open, ready issue ahead of the rest.
 * The dispatcher starts ranked issues before the others, the latest rank
 * first; a rank never lifts the Later gate or a blocker, because it only
 * orders what is already ready (`readyNow`). The rank is cleared when the
 * issue closes.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { readyNow, repoGraph } from "./dependencies.ts";
import type { Issue } from "./issues.ts";
import { canWrite, type Repo } from "./repos.ts";
import type { User } from "./users.ts";

/** Put an issue first. `invalid` unless it is an open issue nothing stands in front of. */
export function putFirst(
  app: App,
  actor: User,
  repo: Repo,
  issue: Issue,
): Result<{ at: string }, "forbidden" | "not_found" | "invalid"> {
  if (issue.repoId !== repo.id || issue.kind !== "issue") return err("not_found");
  if (actor.kind === "agent" || !canWrite(app.db, repo, actor)) return err("forbidden");
  if (issue.state !== "open") return err("invalid");
  const ready = readyNow(repoGraph(app.db, repo.id, { sealed: true }));
  if (!ready.some((r) => r.issue.id === issue.id)) return err("invalid");
  const at = new Date().toISOString();
  app.db
    .query(
      `INSERT INTO issue_first (issue_id, actor_id, at) VALUES (?1, ?2, ?3)
       ON CONFLICT(issue_id) DO UPDATE SET actor_id = excluded.actor_id, at = excluded.at`,
    )
    .run(issue.id, actor.id, at);
  app.bus.append({
    kind: "issue.first",
    repoId: repo.id,
    actorId: actor.id,
    payload: { number: issue.number },
  });
  return ok({ at });
}

/** Forget the rank: the issue closed. */
export function clearFirst(db: Database, issueId: string): void {
  db.query("DELETE FROM issue_first WHERE issue_id = ?1").run(issueId);
}

/** When each of these issues was put first, for the ones that were. */
export function firstAt(db: Database, issueIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < issueIds.length; i += 500) {
    const batch = issueIds.slice(i, i + 500);
    for (const r of db
      .query<{ issue_id: string; at: string }, string[]>(
        `SELECT issue_id, at FROM issue_first WHERE issue_id IN (${batch.map(() => "?").join(",")})`,
      )
      .all(...batch))
      out.set(r.issue_id, r.at);
  }
  return out;
}

/** Every rank in one repository: when it was put first, and by whom (username). */
export function firstMarksInRepo(
  db: Database,
  repoId: string,
): Map<string, { at: string; by: string }> {
  const out = new Map<string, { at: string; by: string }>();
  for (const r of db
    .query<{ issue_id: string; at: string; username: string }, [string]>(
      `SELECT f.issue_id, f.at, u.username FROM issue_first f
       JOIN issue i ON i.id = f.issue_id JOIN user u ON u.id = f.actor_id WHERE i.repo_id = ?1`,
    )
    .all(repoId))
    out.set(r.issue_id, { at: r.at, by: r.username });
  return out;
}

/** Every rank in one repository, as when each was put. */
export function firstInRepo(db: Database, repoId: string): Map<string, string> {
  return new Map([...firstMarksInRepo(db, repoId)].map(([id, m]) => [id, m.at]));
}
