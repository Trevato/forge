/**
 * The planner a direction needs. A repository in auto mode with a direction
 * and no planner on its crew would plan nothing, and say nothing (#7637):
 * the tick adds one — the agent that plans on the most of the owner's other repositories —
 * and the autonomy card says why when a saved direction has no issue yet.
 */

import type { App } from "../app.ts";
import { addToCrew } from "../actions/crew.ts";
import { getAgent, listCrewRoles, type Agent } from "../core/agents.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";

/**
 * The most-used planner among the owner's own repositories that is not
 * already on this crew: an agent the owner already put to work, never one
 * seen only on someone else's (private) repository.
 */
function ownersPlanner(app: App, repo: Repo): Agent | undefined {
  const row = app.db
    .query<{ user_id: string }, [string, string]>(
      `SELECT rc.user_id FROM repo_crew rc
         JOIN repo r ON r.id = rc.repo_id
         JOIN agent a ON a.user_id = rc.user_id
        WHERE rc.role = 'planner' AND r.owner_id = ?2 AND rc.repo_id <> ?1
          AND rc.user_id NOT IN (SELECT user_id FROM repo_crew WHERE repo_id = ?1)
        GROUP BY rc.user_id ORDER BY COUNT(*) DESC, rc.user_id LIMIT 1`,
    )
    .get(repo.id, repo.ownerId);
  return row === null ? undefined : getAgent(app.db, row.user_id);
}

/**
 * The repository's planner, adding one when the crew has none. The agent
 * joins through `addToCrew`, so `by` must be allowed to add it (a verified
 * admin here) and the `crew.added` event is the same; the agent's own budget
 * and the repository's ceiling bind it as any crew member. Undefined when
 * the owner has no planner to lend, or `by` may not add it: the caller says so.
 */
export function ensurePlanner(app: App, repo: Repo, by: User): Agent | undefined {
  const have = listCrewRoles(app.db, repo.id).find((c) => c.role === "planner");
  if (have !== undefined) return have.agent;
  const chosen = ownersPlanner(app, repo);
  if (chosen === undefined) return undefined;
  if (!addToCrew(app, by, repo, chosen.user.username, "planner").ok) return undefined;
  return chosen;
}

/**
 * Why a saved direction has no direction issue, or null when nothing is
 * wrong: autonomy off, no direction, or the issue exists.
 */
export function directionStall(app: App, repo: Repo): string | null {
  if (repo.autonomy === "off" || repo.autonomyDirection.trim() === "") return null;
  if (repo.directionIssueId !== null) return null;
  if (!listCrewRoles(app.db, repo.id).some((c) => c.role === "planner"))
    return "No planner is on the crew, so nothing will act on this direction. The next planning turn adds one if the forge has a planner to lend; otherwise add one under Crew.";
  return "The planner has not opened the direction issue yet; it does at the next planning turn, once the map runs thin.";
}
