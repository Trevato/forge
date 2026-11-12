/**
 * "Give back to the crew" on a hand-over card: one press assigns the pull
 * (and the open issue it closes, when a person holds that too) to the agent
 * that opened it, and says so in a comment. The comment is a director's
 * word newer than the third review, which is what takes the card off the
 * board (`crew/guard.ts`); the assignment is what the next tick dispatches.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { assignIssue, addComment } from "./issues.ts";
import { crewRole, crewWithRole, isCrew } from "../core/agents.ts";
import { getIssue, getIssueById, setAssignee, type Issue } from "../core/issues.ts";
import { closesFromBody } from "../core/pulls.ts";
import { canWrite, getRepoById, type Repo } from "../core/repos.ts";
import { getUserById, getUsersByIds, type User } from "../core/users.ts";
import { handoverOf } from "../crew/guard.ts";
import { transact } from "../kernel/db.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { FleetError } from "./fleet.ts";
import { NO_LONGER_ASKS, SIGN_IN_TO_ACT } from "./asks_words.ts";

const ITEM = /^(?:handover|assigned):[A-Za-z0-9_-]{1,64}$/;

const fail = (code: FleetError["code"], message: string) =>
  err<FleetError>({ code, message });

/**
 * The crew member that opened this pull, when there is one to give it back
 * to: a pull a person opened, or by an agent gone from the crew, has none.
 */
export function builderOf(db: Database, repo: Repo, pull: Issue): User | undefined {
  if (!pull.authorIsAgent) return undefined;
  const agent = getUserById(db, pull.authorId);
  return agent !== undefined && agent.kind === "agent" && isCrew(db, repo.id, agent.id)
    ? agent
    : undefined;
}

/**
 * Who a pass handed a pull over from: the crew member whose agent run on it
 * is the latest and who is still on the crew, else whoever opened it.
 */
export function lastBuilderOf(db: Database, repo: Repo, pull: Issue): User | undefined {
  const rows = db
    .query<{ actor_id: string }, [string]>(
      "SELECT actor_id FROM run WHERE kind = 'agent' AND issue_id = ?1 AND actor_id IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 5",
    )
    .all(pull.id);
  for (const { actor_id } of rows) {
    const agent = getUserById(db, actor_id);
    if (agent !== undefined && agent.kind === "agent" && isCrew(db, repo.id, agent.id)) return agent;
  }
  return builderOf(db, repo, pull);
}

export interface GivenBack {
  readonly pull: number;
  readonly builder: string;
}

/** Give one handed-over pull (`item`: `handover:<pull id>`) back to its builder. */
export function giveBack(
  app: App,
  actor: User | undefined,
  item: unknown,
): Result<GivenBack, FleetError> {
  if (!actor) return fail("unauthorized", SIGN_IN_TO_ACT);
  if (typeof item !== "string" || !ITEM.test(item))
    return fail("bad_action", "only a hand-over can be given back to the crew");
  const pull = getIssueById(app.db, item.slice(item.indexOf(":") + 1));
  const repo = pull === undefined ? undefined : getRepoById(app.db, pull.repoId);
  // A reader, or someone who cannot see it, is told nothing exists.
  if (pull === undefined || repo === undefined || !canWrite(app.db, repo, actor))
    return fail("not_found", NO_LONGER_ASKS);
  if (pull.state !== "open") return fail("not_found", NO_LONGER_ASKS);
  // Three reviews without an approval, or work a person holds: a pass's
  // hand-over, or any pull or issue assigned to them.
  const byPass = item.startsWith("assigned:");
  if (!byPass && pull.kind !== "pull") return fail("not_found", NO_LONGER_ASKS);
  const stillAsks = byPass
    ? pull.assigneeId === actor.id && !pull.assigneeIsAgent
    : handoverOf(app.db, repo, pull.id) !== undefined;
  if (!stillAsks) return fail("not_found", NO_LONGER_ASKS);
  const builder = byPass ? crewHandFor(app.db, repo, pull) : builderOf(app.db, repo, pull);
  if (builder === undefined)
    return fail("bad_action", "no builder on the crew opened this pull, so there is no one to give it back to");
  const given = handBack(app, actor, repo, pull, builder, `Given back to the crew by @${actor.username}`);
  if (!given.ok) return given;
  return ok({ pull: pull.number, builder: builder.username });
}

/**
 * Who work a person holds goes to: the crew member who last worked on it,
 * else (for an issue) a builder on the crew.
 */
export function crewHandFor(db: Database, repo: Repo, work: Issue): User | undefined {
  const last = lastBuilderOf(db, repo, work);
  if (last !== undefined || work.kind === "pull") return last;
  return crewWithRole(db, [repo.id], "builder").get(repo.id)?.[0]?.user;
}

/**
 * `crewHandFor` for many at once, by work id: the same answer, in a fixed
 * number of statements however many rows (the home reads this per page).
 */
export function crewHandsFor(
  db: Database,
  rows: readonly { readonly repo: Repo; readonly work: Issue }[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (rows.length === 0) return out;
  const CHUNK = 400;
  const runs = new Map<string, string[]>();
  const members = new Set<string>();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const issues = batch.map((r) => r.work.id);
    for (const r of db
      .query<{ issue_id: string; actor_id: string }, string[]>(
        // The five newest per issue, as `lastBuilderOf` reads, cut in SQL so a long history is never returned.
        `SELECT issue_id, actor_id FROM (
           SELECT issue_id, actor_id,
                  ROW_NUMBER() OVER (PARTITION BY issue_id ORDER BY created_at DESC, id DESC) AS nth
             FROM run WHERE kind = 'agent' AND actor_id IS NOT NULL
              AND issue_id IN (${issues.map((_, n) => `?${n + 1}`).join(",")})
         ) WHERE nth <= 5 ORDER BY issue_id, nth`,
      )
      .all(...issues)) {
      const list = runs.get(r.issue_id) ?? [];
      list.push(r.actor_id);
      runs.set(r.issue_id, list);
    }
    const repos = [...new Set(batch.map((r) => r.repo.id))];
    for (const m of db
      .query<{ repo_id: string; user_id: string }, string[]>(
        `SELECT repo_id, user_id FROM repo_crew WHERE repo_id IN (${repos.map((_, n) => `?${n + 1}`).join(",")})`,
      )
      .all(...repos))
      members.add(`${m.repo_id}:${m.user_id}`);
  }
  const ids = [...new Set([...runs.values()].flat().concat(rows.map((r) => r.work.authorId)))];
  const users = getUsersByIds(db, ids);
  const builders = crewWithRole(db, rows.map((r) => r.repo.id), "builder");
  const crew = (repo: Repo, userId: string | undefined): User | undefined => {
    const u = userId === undefined ? undefined : users.get(userId);
    return u !== undefined && u.kind === "agent" && members.has(`${repo.id}:${u.id}`) ? u : undefined;
  };
  for (const { repo, work } of rows) {
    const last = (runs.get(work.id) ?? []).map((a) => crew(repo, a)).find((u) => u !== undefined);
    const by = last ?? (work.authorIsAgent ? crew(repo, work.authorId) : undefined);
    const named = by ?? (work.kind === "pull" ? undefined : builders.get(repo.id)?.[0]?.user);
    if (named !== undefined) out.set(work.id, named.username);
  }
  return out;
}

/**
 * Assign `pull` (and the open issue it closes, when a person holds that
 * too) to `builder` and say `words`, all or nothing.
 */
export function handBack(
  app: App,
  actor: User,
  repo: Repo,
  pull: Issue,
  builder: User,
  words: string,
): Result<true, FleetError> {
  const refusal = (what: string, why: string) => new Refused(`could not ${what}: ${why}`);
  try {
    transact(app.db, () => {
      const assigned = assignIssue(app, actor, repo, pull, builder);
      if (!assigned.ok) throw refusal(`assign @${builder.username}`, assigned.error);
      // The issue it closes, when a person was left holding it.
      for (const n of pull.kind === "pull" ? closesFromBody(pull.body) : []) {
        const issue = getIssue(app.db, repo.id, n);
        if (issue?.kind !== "issue" || issue.state !== "open" || issue.assigneeId === null || issue.assigneeIsAgent)
          continue;
        const moved = assignIssue(app, actor, repo, issue, builder);
        if (!moved.ok) throw refusal(`assign #${n} to @${builder.username}`, moved.error);
      }
      const said = addComment(app, actor, repo, pull, words);
      if (!said.ok) throw refusal("comment", said.error);
    });
  } catch (e) {
    if (e instanceof Refused) return fail("bad_action", e.message);
    throw e;
  }
  return ok(true);
}

class Refused extends Error {}

/** What a planner's comment starts with to send a handed-over pull one more round. */
export const ANOTHER_ROUND = "Planner, one more round";

/**
 * The planner's "one more round" comment on a handed-over crew pull gives
 * it back to its builder, as the button does. The planner cannot assign an
 * agent (that is a person's to spend), so the rule is this one narrow
 * door: the repository's planner, an open handed-over pull, a comment that
 * starts with the phrase. The assignment event is what starts the run.
 * An agent's word is not a director's: it does not end the hand-over, so the
 * card stays on /asks and the pull counts as handed over during the round.
 * Returns whether the pull was given back.
 */
export function planAnotherRound(
  app: App,
  actor: User,
  repo: Repo,
  pull: Issue,
  body: unknown,
): boolean {
  if (typeof body !== "string" || !body.startsWith(ANOTHER_ROUND)) return false;
  if (actor.kind !== "agent" || crewRole(app.db, repo.id, actor.id) !== "planner") return false;
  if (pull.kind !== "pull" || pull.state !== "open" || repo.archivedAt !== null) return false;
  if (handoverOf(app.db, repo, pull.id) === undefined) return false;
  const builder = builderOf(app.db, repo, pull);
  if (builder === undefined) return false;
  // A crew pull starts assigned to its builder and hand-over never unassigns,
  // so the builder usually holds it already: the event is what starts the run.
  if (pull.assigneeId !== builder.id) setAssignee(app.db, pull.id, builder.id);
  app.bus.append({
    kind: "pull.assigned",
    repoId: repo.id,
    actorId: actor.id,
    payload: { number: pull.number, assignee: builder.username, agent: true },
  });
  return true;
}
