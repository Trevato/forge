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
import { openPullsClosing, type Pull } from "../core/pulls.ts";
import { getUserById, getUserByName, type User } from "../core/users.ts";

/** What a page says beside anything that talks to the crew. */
export const DIRECTION_NOTE =
  "Only people who can write here direct the crew; anyone else's words stay on the thread.";

/** Why the map holds a reader's issue back from the crew. */
export const READER_SUGGESTION =
  "a reader's suggestion: someone who writes here adopts it first";

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
 * Whether the crew takes this person's word here as direction: someone who
 * may direct it, or one of the crew's own agents, whose notes are the
 * crew's work. Everyone else is a reader — their words are quoted, never
 * obeyed, and never re-arm the clock (`autonomy.ts`, `parks.ts`).
 */
export function speaksForCrew(
  db: Database,
  repo: Repo,
  user: User | undefined,
): boolean {
  if (user?.kind === "agent" && crewRole(db, repo.id, user.id) !== undefined)
    return true;
  return mayDirectCrew(db, repo, user);
}

/**
 * Of the people named, those who may not direct the crew here: the brief
 * quotes their words as a reader's. A name that resolves to nobody is a
 * reader — the safe side of not knowing.
 */
export function readersAmong(
  db: Database,
  repo: Repo,
  names: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  for (const name of new Set(names))
    if (!speaksForCrew(db, repo, getUserByName(db, name))) out.add(name);
  return out;
}

/**
 * Of these user ids, the people (never agents) who may direct the crew
 * here: whose word answers the planner or resets a park's count.
 */
export function directorsAmong(
  db: Database,
  repo: Repo,
  ids: Iterable<string>,
): string[] {
  return [...new Set(ids)].filter((id) => {
    const user = getUserById(db, id);
    return user?.kind === "user" && mayDirectCrew(db, repo, user);
  });
}

/**
 * Of a repository's open issues, those a reader opened that nobody who may
 * direct the crew has adopted yet: the clock never picks them and the map
 * never calls them ready. A reader may suggest work; only a person who can
 * write here makes it the crew's, by assigning it, labelling it, or
 * linking it into the map — a link the crew's planner made does not count,
 * or a reader's words could reach a builder through the planner.
 */
export function unadoptedAmong(
  db: Database,
  repo: Repo,
  issues: readonly Issue[],
): Set<string> {
  const voice = new Map<string, boolean>();
  const speaks = (id: string): boolean => {
    let known = voice.get(id);
    if (known === undefined) {
      known = speaksForCrew(db, repo, getUserById(db, id));
      voice.set(id, known);
    }
    return known;
  };
  const suggested = issues.filter(
    (i) => i.state === "open" && i.assigneeId === null && !speaks(i.authorId),
  );
  const out = new Set<string>();
  if (suggested.length === 0) return out;
  const labelled = new Set(
    db
      .query<{ id: string }, [string]>(
        `SELECT DISTINCT il.issue_id AS id FROM issue_label il
           JOIN issue i ON i.id = il.issue_id WHERE i.repo_id = ?1`,
      )
      .all(repo.id)
      .map((r) => r.id),
  );
  const edges = db
    .query<{ a: string; b: string; actor: string }, [string]>(
      `SELECT d.issue_id AS a, d.blocked_by_id AS b, d.actor_id AS actor
         FROM issue_dependency d JOIN issue i ON i.id = d.issue_id
        WHERE i.repo_id = ?1 AND d.actor_id IS NOT NULL`,
    )
    .all(repo.id);
  const directors = new Set(
    directorsAmong(
      db,
      repo,
      edges.map((e) => e.actor),
    ),
  );
  const linked = new Set<string>();
  for (const e of edges)
    if (directors.has(e.actor)) {
      linked.add(e.a);
      linked.add(e.b);
    }
  for (const i of suggested)
    if (!labelled.has(i.id) && !linked.has(i.id)) out.add(i.id);
  return out;
}

/**
 * Whether autonomy may land this pull on green by itself: the crew wrote
 * it, or someone who can write here did. Never a reader's, whatever the
 * outsiders switch says — the switch lets a reader's words reach the
 * crew, not a reader's code reach the default branch unread by a person.
 */
export function landsOnItsOwn(db: Database, repo: Repo, pull: Pull): boolean {
  const author = getUserById(db, pull.authorId);
  if (author === undefined) return false;
  if (author.kind === "agent")
    return crewRole(db, repo.id, author.id) !== undefined;
  return canWrite(db, repo, author);
}

/**
 * The open issues an open pull would close, by number — counted only for a
 * pull the crew or someone who may direct it opened: a reader's pull that
 * says it closes an issue neither takes it off the crew's list nor shows
 * it as waiting on the map.
 */
export function proposedWork(db: Database, repo: Repo): Map<number, Pull> {
  const out = new Map<number, Pull>();
  for (const [n, pull] of openPullsClosing(db, repo.id))
    if (speaksForCrew(db, repo, getUserById(db, pull.authorId)))
      out.set(n, pull);
  return out;
}
