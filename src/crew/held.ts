/**
 * Why a ready issue cannot start (#2244). The map's ready list is what no
 * open issue stands in front of; a builder may start only the ones no
 * filter holds. Each held issue is counted under the first filter that
 * holds it, so a tick that says `ready=33 startable=0` also says why:
 * `held: open_pull=10 stalled=12 run_cap=11`.
 *
 * The filters, in the order they are asked:
 * - `running`: a run is in flight on it.
 * - `open_pull`: an open pull already proposes it (`direct.ts`), or one a
 *   builder opened in the last 10 minutes (`fresh_pull.ts`).
 * - `planner`: the planner or a reviewer holds it, not a builder. The tick
 *   frees these (`freeParked` in `autonomy.ts`): neither ever builds it.
 * - `with_planner`: its limb was handed to the planner by a person and the
 *   planner has not answered (`core/limb_replan.ts`).
 * - `done_on_main`: the crew found it done on the base branch and waits for
 *   a person to close it (`done_on_main.ts`); nothing is left to plan.
 * - `landed`: a merged pull closes it, but it stayed open with boxes
 *   unticked, and no person has answered since (`landed.ts`): a builder
 *   would only find the pull landed.
 * - `stalled`: a builder ran on it and left without a pull, and nobody
 *   who directs the crew has spoken since. The next tick parks it in the
 *   crew's name, which frees it (`stalls.ts`).
 * - `run_cap`: it has used its runs for the day (`guard.ts`).
 * - `parked_twice`: the crew parked it twice; it is the planner's (`parks.ts`).
 *   Only under ask: a repository on go's builders retry it, bounded by `run_cap`.
 * - `red_fix`: a fix for a red main already covers it (`red_fix.ts`).
 * - `hot_file`: a file it names is touched by `HOT_PULLS` or more open
 *   pulls, or an admin holds it (`file_holds.ts`); it starts when that pile
 *   drains under the limit or the hold is released (`hot_files.ts`).
 *
 * The direction issue is the planner's standing issue and never a
 * builder's; it is left out, not counted.
 */

import type { App } from "../app.ts";
import { listCrewRoles, type Agent, type CrewRole } from "../core/agents.ts";
import { readyNow, repoGraph, type Graph, type Ranked } from "../core/dependencies.ts";
import { alreadyDone, BY_CREW, DONE_LIKE } from "../core/done_on_main.ts";
import { getIssuesByIds, getIssuesByNumbers, type Issue } from "../core/issues.ts";
import { withPlanner } from "../core/limb_replan.ts";
import { isGo, type Repo } from "../core/repos.ts";
import { sealedRowByNumber } from "../core/sealed.ts";
import { listActive, type Run } from "../core/runs.ts";
import { getUserById } from "../core/users.ts";
import type { Stuck } from "./brief.ts";
import { proposedWork, speaksForCrew } from "./direct.ts";
import { freshPulls, pullFor } from "./fresh_pull.ts";
import { capReached, capReachedFor, runCapOf } from "./guard.ts";
import { interruptionOf } from "./interrupted.ts";
import { landedUnanswered } from "./landed.ts";
import { PARK_STRIKES, parkedCount } from "./parks.ts";
import { heldFiles, type FileHold } from "./file_holds.ts";
import { expectedFiles, hotFiles, hotOverlap, pullsTouching, relievedFiles } from "./hot_files.ts";
import { coveredByRedFix } from "./red_fix.ts";
import { landedUnder } from "./stalls.ts";

export const HOLDS = [
  "running",
  "open_pull",
  "planner",
  "with_planner",
  "done_on_main",
  "landed",
  "stalled",
  "run_cap",
  "parked_twice",
  "red_fix",
  "hot_file",
] as const;

export type HoldName = (typeof HOLDS)[number];

/** The holds the planner can lift by re-planning: the rest wait on work in flight or a person. */
export const REPLANNABLE: readonly HoldName[] = ["stalled", "run_cap", "parked_twice"];

export interface Held {
  /** The ready issues a builder may start now, in the map's order. */
  readonly startable: Ranked[];
  /** Each held issue under the first filter that holds it. */
  readonly by: Readonly<Record<HoldName, readonly Issue[]>>;
  /** Of the `hot_file` ones, those an admin's hold keeps: issue number to the hold that does. */
  readonly pinned: ReadonlyMap<number, FileHold>;
  /** Of the `hot_file` ones, those that wait because another issue already relieves the same path: issue number to that path and issue. */
  readonly relieving: ReadonlyMap<number, { path: string; by: number }>;
}

export interface LastRun {
  readonly state: string;
  readonly summary: string;
  readonly created_at: string;
}

/** The newest agent run of each of `ids` in a few reads, not one per issue; an issue never run is absent. */
export function lastAgentRuns(app: App, ids: readonly string[]): Map<string, LastRun> {
  const out = new Map<string, LastRun>();
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    for (const r of app.db
      .query<LastRun & { issue_id: string }, string[]>(
        `SELECT issue_id, state, summary, created_at FROM (
           SELECT issue_id, state, summary, created_at,
                  ROW_NUMBER() OVER (PARTITION BY issue_id ORDER BY created_at DESC, id DESC) AS rn
             FROM run WHERE kind = 'agent' AND issue_id IN (${batch.map((_, n) => `?${n + 1}`).join(",")}))
          WHERE rn = 1`,
      )
      .all(...batch))
      out.set(r.issue_id, r);
  }
  return out;
}

/**
 * An issue a builder already ran on and left without a pull — declined, or
 * cut short — is not picked again blind: running it again unchanged is the
 * loop autonomy refuses. A person's word lifts it, and so does the park the
 * next tick writes with who stalled it and why (`stalls.ts`); two such
 * parks hand it to the planner.
 */
export function stalled(
  app: App,
  repo: Repo,
  issue: Issue,
  lastRuns?: ReadonlyMap<string, LastRun>,
): boolean {
  const last =
    lastRuns !== undefined
      ? lastRuns.get(issue.id)
      : app.db
          .query<LastRun, [string]>(
            `SELECT state, summary, created_at FROM run WHERE issue_id = ?1 AND kind = 'agent'
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(issue.id);
  if (last === null || last === undefined) return false;
  if (last.state === "queued" || last.state === "running") return true;
  if (/opened pull #|updated pull #/.test(last.summary)) return false;
  // Its pull landed under it: the work is on the base, not stalled (#8481).
  if (landedUnder(last)) return false;
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
  admit: (pullNumber: number) => boolean = () => true,
): Held {
  const busyIssues = new Set(active.map((r) => r.issueId));
  // Only the pulls the viewer may see count: a sealed pull holds nothing for a guest.
  const proposed = new Map([...proposedWork(app.db, repo)].filter(([, pull]) => admit(pull.number)));
  // An issue a planner or a reviewer holds is theirs, not a builder's.
  const planners = new Set(
    crew.filter((c) => c.role !== "builder").map((c) => c.agent.user.id),
  );
  const builders = crew.filter((c) => c.role === "builder").map((c) => c.agent.user.username);
  // Read once for the whole pass, matched per issue in memory (#10445).
  const fresh = builders.length === 0 ? [] : freshPulls(app.db, repo.id);
  const handed = withPlanner(app.db, repo);
  const hot = hotFiles(repo.id, admit);
  const pins = new Map(heldFiles(app.db, repo.id).map((h) => [h.path, h]));
  const pinned = new Map<number, FileHold>();
  // The hold an admin set on a file the issue names, if any: the first by hold order.
  const pinOf = (issue: Issue): FileHold | undefined =>
    pins.size === 0 ? undefined : expectedFiles(issue).map((f) => pins.get(f)).find((h) => h !== undefined);
  // Who is relieving which path now: issues with an open pull or a run in flight (#7422).
  const relievers = new Map<string, number>();
  const learnRelievers = (): void => {
    const served = [
      ...getIssuesByNumbers(app.db, [...proposed.keys()].map((number) => ({ repoId: repo.id, number }))).values(),
      ...getIssuesByIds(app.db, [...busyIssues].filter((id): id is string => id !== null)).values(),
    ];
    for (const i of served)
      for (const path of relievedFiles(i)) if (!relievers.has(path) || i.number < relievers.get(path)!) relievers.set(path, i.number);
  };
  let relieversKnown = false;
  const relieving = new Map<number, { path: string; by: number }>();
  const waitsOnRelief = (issue: Issue): boolean => {
    const mine = relievedFiles(issue).filter((p) => hot.has(p));
    if (mine.length === 0) return false;
    if (!relieversKnown) {
      learnRelievers();
      relieversKnown = true;
    }
    for (const path of mine) {
      const by = relievers.get(path);
      if (by !== undefined && by !== issue.number) {
        relieving.set(issue.number, { path, by });
        return true;
      }
    }
    // It starts, so no other issue in this pass may relieve the same path.
    for (const path of mine) relievers.set(path, issue.number);
    return false;
  };
  // The newest run of every ready issue, read once for the whole pass.
  // The run cap of every ready issue, worked out once for the pass on first need.
  let cappedAll: Map<string, boolean> | undefined;
  const capped = (): Map<string, boolean> =>
    (cappedAll ??= capReachedFor(
      app.db,
      repo,
      ready.map((r) => r.issue),
      (i) => runCapOf(repo, i, app.config),
    ));
  const lastRuns = lastAgentRuns(app, ready.map((r) => r.issue.id));
  const holdOf = (issue: Issue): HoldName | null => {
    if (busyIssues.has(issue.id)) return "running";
    if (proposed.has(issue.number)) return "open_pull";
    if (issue.assigneeId !== null && planners.has(issue.assigneeId)) return "planner";
    if (handed.has(issue.id)) return "with_planner";
    if (alreadyDone(app.db, [issue.id]).has(issue.id)) return "done_on_main";
    if (landedUnanswered(app.db, repo, issue) !== undefined) return "landed";
    if (stalled(app, repo, issue, lastRuns)) return "stalled";
    if (capped().get(issue.id) ?? atRunCap(app, repo, issue)) return "run_cap";
    if (!isGo(repo) && parkedCount(app.db, repo, issue.id) >= PARK_STRIKES) return "parked_twice";
    if (coveredByRedFix(app.db, repo.id, issue)) return "red_fix";
    const pin = pinOf(issue);
    if (pin !== undefined) {
      pinned.set(issue.number, pin);
      return "hot_file";
    }
    if (hotOverlap(issue, hot).length > 0) return "hot_file";
    if (waitsOnRelief(issue)) return "hot_file";
    // The dispatcher refuses a build on an issue whose pull just opened (#8473): held, not picked.
    if (pullFor(fresh, issue.number, builders) !== undefined) return "open_pull";
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
  return { startable, by, pinned, relieving };
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

/** What holds a ready issue, as the map's API says it. */
export interface MapHold {
  readonly by: HoldName;
  readonly detail: string;
  /** For a hot file: the open pulls that touch it, oldest first, at most 8. */
  readonly pulls?: readonly number[];
}

const HOLD_WORDS: Readonly<Record<HoldName, string>> = {
  running: "a run is in flight on it",
  open_pull: "an open pull already proposes it",
  planner: "the planner or a reviewer holds it",
  with_planner: "its limb waits on the planner",
  done_on_main: "found done on the base branch; waits for a person to close it",
  landed: "a merged pull closes it with boxes unticked; waits for a person",
  stalled: "a builder ran on it and left without a pull",
  run_cap: "it has used its runs for the day",
  parked_twice: "parked twice; it is the planner's",
  red_fix: "a fix for a red main covers it",
  hot_file: "a file it names is hot",
};

/**
 * The hold on each held ready issue, by number, and the numbers none holds.
 * `hot_file` names the file and its open pulls. Memory and the database only:
 * no git call. `issues` is the viewer's own ready list, so a sealed issue the
 * viewer may not see is never named.
 */
export function mapHolds(
  repo: Repo,
  held: Held,
  admit: (pullNumber: number) => boolean = () => true,
): { holds: Map<number, MapHold>; startable: number[] } {
  const hot = hotFiles(repo.id, admit);
  const holds = new Map<number, MapHold>();
  for (const name of HOLDS) {
    for (const issue of held.by[name]) {
      let detail = HOLD_WORDS[name];
      let pulls: number[] | undefined;
      if (name === "hot_file") {
        const pin = held.pinned.get(issue.number);
        const top = hotOverlap(issue, hot)[0];
        const rel = held.relieving.get(issue.number);
        if (pin !== undefined) detail = `${pin.path} is held by an admin`;
        else if (top === undefined && rel !== undefined)
          detail = `waits: ${rel.path} is already being relieved by #${rel.by}`;
        else if (top !== undefined) {
          detail = `${top.path} is in ${top.pulls} open ${top.pulls === 1 ? "pull" : "pulls"}`;
          pulls = pullsTouching(repo.id, top.path, admit);
        }
      }
      holds.set(issue.number, { by: name, detail, ...(pulls === undefined ? {} : { pulls }) });
    }
  }
  return { holds, startable: held.startable.map((r) => r.issue.number) };
}

/** The pulls a viewer of `scope` may see: all with the sealed scope, else the unsealed and their own. */
export function admits(app: App, repo: Repo, scope: { sealed?: true; sealedBy?: string }) {
  if (scope.sealed === true) return () => true;
  return (n: number): boolean => {
    const row = sealedRowByNumber(app.db, repo.id, n);
    return row === undefined || !row.sealed || row.authorId === scope.sealedBy;
  };
}

/** How long a viewer's map holds are reused by the next reader of the same repository. Off under `bun test`. */
export const mapHeldReuse = { ms: process.env["NODE_ENV"] === "test" ? 0 : 5_000 };
const mapHeldKept = new WeakMap<App, Map<string, { at: number; holds: ReturnType<typeof mapHolds> }>>();

/**
 * The map's holds for one viewer: shared by the route and the MCP `map` tool.
 * The map, the forge view, the terminal's plan and the asks each sorted the
 * ready list for themselves on every look; a look within five seconds of
 * another of the same viewer's reads that one. The crew's own tick never comes
 * through here (it calls `heldBy`) and a question about named issues
 * (`only`) is worked out fresh.
 */
export function mapHeldFor(
  app: App,
  repo: Repo,
  graph: Graph,
  scope: { sealed?: true; sealedBy?: string },
  /** Only these issue numbers are worked out: the cost grows with them, not with the ready list. */
  only?: ReadonlySet<number>,
): ReturnType<typeof mapHolds> {
  const reuse = mapHeldReuse.ms > 0 && only === undefined;
  const key = `${repo.id} ${scope.sealed === true ? "s" : "-"} ${scope.sealedBy ?? ""}`;
  let kept = mapHeldKept.get(app);
  if (reuse) {
    if (kept === undefined) mapHeldKept.set(app, (kept = new Map()));
    const hit = kept.get(key);
    if (hit !== undefined && Date.now() - hit.at < mapHeldReuse.ms) return hit.holds;
  }
  const admit = admits(app, repo, scope);
  const active = listActive(app.db, "agent").filter((r) => r.repoId === repo.id);
  const ready = readyNow(graph).filter((r) => only === undefined || only.has(r.issue.number));
  const holds = mapHolds(
    repo,
    heldBy(app, repo, ready, listCrewRoles(app.db, repo.id), active, admit),
    admit,
  );
  if (reuse && kept !== undefined) {
    if (kept.size >= 512) kept.clear();
    kept.set(key, { at: Date.now(), holds });
  }
  return holds;
}
