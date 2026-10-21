/**
 * Why a ready issue cannot start (#2244). The map's ready list is what no
 * open issue stands in front of; a builder may start only the ones no
 * filter holds. Each held issue is counted under the first filter that
 * holds it, so a tick that says `ready=33 startable=0` also says why:
 * `held: open_pull=10 stalled=12 run_cap=11`.
 *
 * The filters, in the order they are asked:
 * - `running`: a run is in flight on it.
 * - `open_pull`: an open pull already proposes it (`direct.ts`).
 * - `planner`: the planner or a reviewer holds it, not a builder. The tick
 *   frees these (`freeParked` in `autonomy.ts`): neither ever builds it.
 * - `with_planner`: its limb was handed to the planner by a person and the
 *   planner has not answered (`core/limb_replan.ts`).
 * - `done_on_main`: the crew found it done on the base branch and waits for
 *   a person to close it (`done_on_main.ts`); nothing is left to plan.
 * - `stalled`: a builder ran on it and left without a pull, and nobody
 *   who directs the crew has spoken since. The next tick parks it in the
 *   crew's name, which frees it (`stalls.ts`).
 * - `run_cap`: it has used its runs for the day (`guard.ts`).
 * - `parked_twice`: the crew parked it twice; it is the planner's (`parks.ts`).
 * - `red_fix`: a fix for a red main already covers it (`red_fix.ts`).
 *
 * The direction issue is the planner's standing issue and never a
 * builder's; it is left out, not counted.
 */

import type { App } from "../app.ts";
import { listCrewRoles, type Agent, type CrewRole } from "../core/agents.ts";
import { readyNow, repoGraph, type Ranked } from "../core/dependencies.ts";
import { alreadyDone, BY_CREW, DONE_LIKE } from "../core/done_on_main.ts";
import type { Issue } from "../core/issues.ts";
import { withPlanner } from "../core/limb_replan.ts";
import type { Repo } from "../core/repos.ts";
import { listActive, type Run } from "../core/runs.ts";
import { getUserById } from "../core/users.ts";
import type { Stuck } from "./brief.ts";
import { proposedWork, speaksForCrew } from "./direct.ts";
import { capReached, runCapOf } from "./guard.ts";
import { interruptionOf } from "./interrupted.ts";
import { PARK_STRIKES, parkedCount } from "./parks.ts";
import { coveredByRedFix } from "./red_fix.ts";

export const HOLDS = [
  "running",
  "open_pull",
  "planner",
  "with_planner",
  "done_on_main",
  "stalled",
  "run_cap",
  "parked_twice",
  "red_fix",
] as const;

export type HoldName = (typeof HOLDS)[number];

/** The holds the planner can lift by re-planning: the rest wait on work in flight or a person. */
export const REPLANNABLE: readonly HoldName[] = ["stalled", "run_cap", "parked_twice"];

export interface Held {
  /** The ready issues a builder may start now, in the map's order. */
  readonly startable: Ranked[];
  /** Each held issue under the first filter that holds it. */
  readonly by: Readonly<Record<HoldName, readonly Issue[]>>;
}

/**
 * An issue a builder already ran on and left without a pull — declined, or
 * cut short — is not picked again blind: running it again unchanged is the
 * loop autonomy refuses. A person's word lifts it, and so does the park the
 * next tick writes with who stalled it and why (`stalls.ts`); two such
 * parks hand it to the planner.
 */
export function stalled(app: App, repo: Repo, issue: Issue): boolean {
  const last = app.db
    .query<{ state: string; summary: string; created_at: string }, [string]>(
      `SELECT state, summary, created_at FROM run WHERE issue_id = ?1 AND kind = 'agent'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(issue.id);
  if (last === null || last === undefined) return false;
  if (last.state === "queued" || last.state === "running") return true;
  if (/opened pull #|updated pull #/.test(last.summary)) return false;
  // Cut short by the provider or a restart: nobody tried it, so the clock
  // tries again (`interrupted.ts`).
  if (last.state === "failed" && interruptionOf(last.summary) !== undefined)
    return false;
  // A word since then — from someone who may direct the crew, or the
  // planner's when it re-planned a parked issue — is what un-stalls it. A
  // reader's comment stays on the thread, and so does one imported from
  // an origin, whoever connected it (#619).
  return !app.db
    .query<{ id: string }, [string, string]>(
      `SELECT DISTINCT n.author_id AS id FROM comment n
        WHERE n.issue_id = ?1 AND n.created_at > ?2 AND n.origin_author IS NULL
          AND NOT (n.body LIKE '${DONE_LIKE}' AND ${BY_CREW})`,
    )
    .all(issue.id, last.created_at)
    .some((r) => speaksForCrew(app.db, repo, getUserById(app.db, r.id)));
}

/** Whether `issue` is at its run cap (`guard.ts`): the clock neither picks nor plans it. */
export function atRunCap(app: App, repo: Repo, issue: Issue): boolean {
  return capReached(app.db, repo, issue, runCapOf(repo, issue, app.config));
}

/** Sort the ready list into what a builder may start and what holds the rest. */
export function heldBy(
  app: App,
  repo: Repo,
  ready: readonly Ranked[],
  crew: readonly { agent: Agent; role: CrewRole }[],
  active: readonly Run[],
): Held {
  const busyIssues = new Set(active.map((r) => r.issueId));
  const proposed = proposedWork(app.db, repo);
  // An issue a planner or a reviewer holds is theirs, not a builder's.
  const planners = new Set(
    crew.filter((c) => c.role !== "builder").map((c) => c.agent.user.id),
  );
  const handed = withPlanner(app.db, repo);
  const holdOf = (issue: Issue): HoldName | null => {
    if (busyIssues.has(issue.id)) return "running";
    if (proposed.has(issue.number)) return "open_pull";
    if (issue.assigneeId !== null && planners.has(issue.assigneeId)) return "planner";
    if (handed.has(issue.id)) return "with_planner";
    if (alreadyDone(app.db, [issue.id]).has(issue.id)) return "done_on_main";
    if (stalled(app, repo, issue)) return "stalled";
    if (atRunCap(app, repo, issue)) return "run_cap";
    if (parkedCount(app.db, repo, issue.id) >= PARK_STRIKES) return "parked_twice";
    if (coveredByRedFix(app.db, repo.id, issue)) return "red_fix";
    return null;
  };
  const by = Object.fromEntries(HOLDS.map((h) => [h, [] as Issue[]])) as Record<
    HoldName,
    Issue[]
  >;
  const startable: Ranked[] = [];
  for (const r of ready) {
    if (r.issue.id === repo.directionIssueId) continue;
    const hold = holdOf(r.issue);
    if (hold === null) startable.push(r);
    else by[hold].push(r.issue);
  }
  return { startable, by };
}

/** The count per filter, in `HOLDS` order. */
export function heldCounts(held: Held): Record<HoldName, number> {
  return Object.fromEntries(HOLDS.map((h) => [h, held.by[h].length])) as Record<
    HoldName,
    number
  >;
}

/** The counts as the tick line says them: `open_pull=10 stalled=3`, the empty ones left out. */
export function heldWords(held: Held): string {
  const said = HOLDS.filter((h) => held.by[h].length > 0).map(
    (h) => `${h}=${held.by[h].length}`,
  );
  return said.length === 0 ? "none" : said.join(" ");
}

/** The held issues the planner can lift by re-planning them. */
export function replannable(held: Held): Issue[] {
  return REPLANNABLE.flatMap((h) => held.by[h]);
}

/** The ready list sorted now, from the map, the crew and the runs in flight. */
export function heldNow(app: App, repo: Repo): Held {
  return heldBy(
    app,
    repo,
    readyNow(repoGraph(app.db, repo.id, { sealed: true })),
    listCrewRoles(app.db, repo.id),
    listActive(app.db, "agent").filter((r) => r.repoId === repo.id),
  );
}

/**
 * What a planning pass is told when nothing ready can start: the counts,
 * and the stalled and capped issues to re-plan. Parked-twice ones reach it
 * as hand-overs already (`parks.ts`). Undefined when something can start
 * or nothing re-planning lifts holds the rest.
 */
export function stuckOf(held: Held): Stuck | undefined {
  if (held.startable.length > 0) return undefined;
  const issues = (["stalled", "run_cap"] as const).flatMap((hold) =>
    held.by[hold].map((issue) => ({ number: issue.number, title: issue.title, hold })),
  );
  return issues.length === 0 ? undefined : { held: heldWords(held), issues };
}
