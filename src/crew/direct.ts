/**
 * Who directs the crew on a repository. On a public repository anyone with
 * an account may comment, and a run holds a write token and spends the
 * owner's budget: so speaking is open, but only some voices start or steer
 * a run. One rule, asked by every path that does either — a comment or a
 * review reaching the dispatcher, the steering box, `tell`, assignment,
 * converge over HTTP and the MCP — and by the brief, which marks what
 * anyone else said as a reader's words, never an instruction (#619).
 *
 * The rule: the actor can write here (`canWrite`); or it is the crew's own
 * reviewer, whose verdict is a review like a person's; or the owner turned
 * on "outsiders may trigger the crew" (`repo.crewOutsiders`, off by
 * default, recorded in the repository's activity when it changes) and the
 * actor is signed in and can read.
 */

import type { Database } from "bun:sqlite";
import { crewRole } from "../core/agents.ts";
import { canRead, canWrite, type Repo } from "../core/repos.ts";
import type { Issue } from "../core/issues.ts";
import { getUserById, getUserByName, type User } from "../core/users.ts";

/** What a page says beside anything that talks to the crew. */
export const DIRECTION_NOTE =
  "Only people who can write here direct the crew; anyone else's words stay on the thread.";

export const OUTSIDERS_NOTE =
  "Anyone signed in may direct the crew here: the owner let outsiders trigger it.";

export function mayDirectCrew(
  db: Database,
  repo: Repo,
  actor: User | undefined,
): boolean {
  if (actor === undefined || actor.kind === "org") return false;
  if (canWrite(db, repo, actor)) return true;
  if (actor.kind === "agent")
    return crewRole(db, repo.id, actor.id) === "reviewer";
  return repo.crewOutsiders && canRead(db, repo, actor);
}

/** The line a page shows about who directs the crew here. */
export function directionNote(repo: Repo): string {
  return repo.crewOutsiders ? OUTSIDERS_NOTE : DIRECTION_NOTE;
}

/**
 * The note for a thread an agent holds — its assignee, or the author of
 * an unassigned pull, the same holders `agentFor` reads — or undefined
 * where no agent is listening.
 */
export function threadNote(
  db: Database,
  repo: Repo,
  issue: Issue,
): string | undefined {
  const holder =
    issue.assigneeId !== null
      ? issue.assigneeId
      : issue.kind === "pull"
        ? issue.authorId
        : null;
  if (holder === null) return undefined;
  return getUserById(db, holder)?.kind === "agent"
    ? directionNote(repo)
    : undefined;
}

/**
 * Of the people named, those who may not direct the crew here: the brief
 * quotes their words as a reader's. The crew's own agents are not readers
 * (their notes are the crew's work, and never start a run). A name that
 * resolves to nobody is a reader — the safe side of not knowing.
 */
export function readersAmong(
  db: Database,
  repo: Repo,
  names: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  for (const name of new Set(names)) {
    const user = getUserByName(db, name);
    const crew =
      user?.kind === "agent" && crewRole(db, repo.id, user.id) !== undefined;
    if (!crew && !mayDirectCrew(db, repo, user)) out.add(name);
  }
  return out;
}
