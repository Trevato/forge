/**
 * A repository that runs on its own. Every minute, for each repository whose
 * autonomy is on: spend today against the ceiling; free slots against the
 * runs in flight; the map's ready list against the builders; and, when the
 * map has run dry, the planner against the direction. Green pulls land
 * when the repository is autonomous. All of it acts as the person who
 * turned autonomy on, through the same actions they would take by hand, so
 * every run and merge is credited and bounded exactly as theirs would be.
 *
 * What it never does: start more than the slots allow, spend past the
 * ceiling, re-queue anything a person must decide, or write to a
 * repository's origin.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import {
  addComment,
  assignIssue,
  openIssue,
  setIssueState,
} from "../actions/issues.ts";
import type { AccessError } from "../actions/access.ts";
import { mergeable, resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { mergePull } from "../actions/pulls.ts";
import {
  listCrewRoles,
  type Agent,
  type CrewRole,
  crewRole,
} from "../core/agents.ts";
import { pickBuilder, routeIssue } from "./route.ts";
import { readyNow, repoGraph, type Ranked } from "../core/dependencies.ts";
import {
  latestDecision,
  recordDecision,
  resolveOpen,
  stopStands,
} from "../core/decisions.ts";
import { certain } from "./decide.ts";
import { decideAndRecord } from "./ledger.ts";
import { wallOf, wallSentence } from "../contract/policy.ts";
import {
  getIssue,
  getIssueById,
  listComments,
  MAX_TITLE,
  type Issue,
} from "../core/issues.ts";
import {
  getPull,
  closesFromBody,
  listPulls,
  type MergePullError,
  type Pull,
} from "../core/pulls.ts";
import {
  getRepoById,
  listAutonomousRepos,
  setDirectionIssue,
  type Repo,
} from "../core/repos.ts";
import {
  activeRunFor,
  automaticRunsSince,
  listActive,
  type Run,
  verdictForHead,
} from "../core/runs.ts";
import {
  agentFor,
  CHECK_FAILED_LIMIT,
  lastHumanWord,
  queueAgentRun,
} from "./dispatch.ts";
import { getUserById, type User } from "../core/users.ts";
import { grantedAccounts } from "../core/subscriptions.ts";
import { reviewSummary } from "../core/reviews.ts";
import { standing } from "../core/standing.ts";
import { pace, type Pace } from "./pacing.ts";
import { BREAKER_NOTE, breakerTripped } from "./breaker.ts";
import { interruptionOf } from "./interrupted.ts";
import { parkedCount as countParks, PARK_STRIKES } from "./parks.ts";
import { createLog } from "../kernel/log.ts";
import {
  directorsAmong,
  landsOnItsOwn,
  markReaders,
  proposedWork,
  speaksForCrew,
} from "./direct.ts";
import { crewOffInPreview } from "./preview.ts";
import { reviewersOf, sendToReview, sweepReviews } from "./review.ts";

const log = createLog("autonomy");

export const AUTONOMY_TICK_MS = 60_000;
/** A planner is not asked again sooner than this unless the map changed. */
/**
 * How soon a dry map is planned again. A repository on its own is never
 * finished: when nothing is ready and nothing is in flight, the planner
 * is asked for the next increment, with only a short floor so a planner
 * that produced nothing is not asked every minute.
 */
const REPLAN_AFTER_MS = 20 * 60_000;

export type Paused = "ceiling" | "forge ceiling" | "nobody" | "no crew";

export interface AutonomyStatus {
  readonly autonomy: Repo["autonomy"];
  readonly spentTodayUsd: number;
  readonly ceilingUsd: number;
  readonly slots: number;
  /**
   * Agent runs in flight here that spend a slot — what `slottedRuns` counts,
   * which is what the loop gates on. Not every run in flight: see there.
   */
  readonly active: number;
  readonly paused: Paused | null;
  /** When a ceiling pause lifts: the next UTC midnight. */
  readonly resumesAt: string | null;
}

export function startOfTodayUtc(now: Date): Date {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

/** Agent spend on this repository since UTC midnight. */
export function spentToday(
  db: App["db"],
  repoId: string,
  now = new Date(),
): number {
  const since = startOfTodayUtc(now).toISOString();
  return (
    db
      .query<{ spent: number | null }, [string, string]>(
        `SELECT SUM(cost_usd) AS spent FROM run
         WHERE repo_id = ?1 AND kind = 'agent' AND created_at >= ?2`,
      )
      .get(repoId, since)?.spent ?? 0
  );
}

/** What the crew spent today across every repository, in dollars. */
export function spentTodayEverywhere(db: Database, now = new Date()): number {
  const since = startOfTodayUtc(now).toISOString();
  return (
    db
      .query<{ spent: number | null }, [string]>(
        `SELECT SUM(cost_usd) AS spent FROM run
         WHERE kind = 'agent' AND created_at >= ?1`,
      )
      .get(since)?.spent ?? 0
  );
}

/**
 * Agent spend since UTC midnight for many repositories at once, keyed by
 * repo id — one query, for a count that must not slow down as the apps
 * grow (the topbar's ask count is the reason this exists).
 */
export function spentTodayForRepos(
  db: App["db"],
  repoIds: readonly string[],
  now = new Date(),
): Map<string, number> {
  const out = new Map<string, number>();
  const unique = [...new Set(repoIds)];
  if (unique.length === 0) return out;
  const since = startOfTodayUtc(now).toISOString();
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<
        { repo_id: string; spent: number | null },
        string[]
      >(
        `SELECT repo_id, SUM(cost_usd) AS spent FROM run
         WHERE kind = 'agent' AND created_at >= ?${batch.length + 1}
           AND repo_id IN (${batch.map((_, n) => `?${n + 1}`).join(",")})
         GROUP BY repo_id`,
      )
      .all(...batch, since);
    for (const row of rows) out.set(row.repo_id, row.spent ?? 0);
  }
  return out;
}

/**
 * Whether a repository is paused at today's ceiling right now — the same
 * three conditions `autonomyStatus`'s own `"ceiling"` reads for one, but
 * asked of crew and spend already read for the whole set
 * (`crewForRepos`, `spentTodayForRepos`), never a query of its own. The
 * ask card (`studio/asks.ts`) and the studio home's cost line
 * (`studio/home.ts`) both decide from this, so neither can disagree with
 * the other about which app is paused.
 */
export function isPausedAtCeiling(
  repo: Repo,
  crew: ReadonlyMap<string, readonly string[]>,
  spent: ReadonlyMap<string, number>,
): boolean {
  if (repo.autonomy === "off" || repo.autonomyBy === null) return false;
  if ((crew.get(repo.id)?.length ?? 0) === 0) return false;
  return (spent.get(repo.id) ?? 0) >= repo.autonomyCeilingUsd;
}

function activeRuns(app: App, repoId: string) {
  return listActive(app.db, "agent").filter((r) => r.repoId === repoId);
}

/**
 * Of the agent runs in flight here, the ones that spend a slot. Slots are
 * the builders' work-in-progress limit, so two kinds of run take none: a
 * review, which is the reviewer's short pass over a pull and must never
 * keep a builder from picking up the next issue, and any run by a planner
 * or a reviewer, whose work refills the map rather than works it.
 *
 * The rule lives here only: `driveRepo` gates on this set and
 * `autonomyStatus` counts it, so the number a page shows is the number the
 * loop enforces. The runs it leaves out are still in flight and still shown
 * — Now on the studio page lists every one of them.
 */
export function slottedRuns(
  active: readonly Run[],
  crew: readonly { readonly agent: Agent; readonly role: CrewRole }[],
): Run[] {
  const notBuilders = new Set(
    crew.filter((c) => c.role !== "builder").map((c) => c.agent.user.id),
  );
  return active.filter(
    (r) =>
      r.reason !== "review" &&
      (r.actorId === null || !notBuilders.has(r.actorId)),
  );
}

export function autonomyStatus(
  app: App,
  repo: Repo,
  now = new Date(),
): AutonomyStatus {
  const spent = spentToday(app.db, repo.id, now);
  const crew = listCrewRoles(app.db, repo.id);
  const forgeCap = app.config.crewCeilingUsd;
  const paused: Paused | null =
    repo.autonomy === "off"
      ? null
      : repo.autonomyBy === null
        ? "nobody"
        : crew.length === 0
          ? "no crew"
          : spent >= repo.autonomyCeilingUsd
            ? "ceiling"
            : forgeCap !== undefined &&
                spentTodayEverywhere(app.db, now) >= forgeCap
              ? "forge ceiling"
              : null;
  const tomorrow = startOfTodayUtc(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return {
    autonomy: repo.autonomy,
    spentTodayUsd: spent,
    ceilingUsd: repo.autonomyCeilingUsd,
    slots: repo.autonomySlots,
    active: slottedRuns(activeRuns(app, repo.id), crew).length,
    paused,
    resumesAt:
      paused === "ceiling" || paused === "forge ceiling"
        ? tomorrow.toISOString()
        : null,
  };
}

/** What a run costs here on average lately; a dollar before there is a history. */
function meanRunUsd(db: App["db"], repoId: string): number {
  return (
    db
      .query<{ m: number | null }, [string]>(
        `SELECT AVG(cost_usd) AS m FROM (
           SELECT cost_usd FROM run WHERE repo_id = ?1 AND kind = 'agent'
             AND state IN ('ok','failed') AND cost_usd > 0
           ORDER BY created_at DESC LIMIT 20)`,
      )
      .get(repoId)?.m ?? 1
  );
}

/** The crew's pace here: the operator's slots, held to what the windows have left. */
export function repoPace(app: App, repo: Repo, now = new Date()): Pace {
  const accounts = grantedAccounts(app.db, repo.id, repo.ownerId).flatMap(
    (a) => {
      const s = standing(app.db, a.id, now);
      return s === undefined ? [] : [{ name: a.name, standing: s }];
    },
  );
  return pace(accounts, repo.autonomySlots, meanRunUsd(app.db, repo.id), now);
}

export type Drove = "off" | "paused" | "waiting" | "full" | "picked" | "planned" | "idle";

/**
 * One turn of the loop for one repository. Returns what it did, for the
 * log and for tests; the effects are an assignment (which the crew turns
 * into a run) or a planner given the direction.
 */
export async function driveRepo(
  app: App,
  repo: Repo,
  now = new Date(),
): Promise<Drove> {
  if (repo.autonomy === "off") return "off";
  const status = autonomyStatus(app, repo, now);
  if (status.paused !== null) return "paused";
  const by = getUserById(app.db, repo.autonomyBy!);
  if (!by) return "paused";
  const crew = listCrewRoles(app.db, repo.id);
  const builders = crew.filter((c) => c.role === "builder").map((c) => c.agent);
  const planner = crew.find((c) => c.role === "planner")?.agent;
  const active = activeRuns(app, repo.id);
  // An issue a planner or a reviewer holds is theirs, not a builder's.
  const planners = new Set(
    crew.filter((c) => c.role !== "builder").map((c) => c.agent.user.id),
  );
  const slotted = slottedRuns(active, crew);
  // Slots follow the subscriptions' remaining windows, never past the
  // operator's; at a wall nothing new starts until the reset.
  const paced = repoPace(app, repo, now);
  if (paced.slots === 0 && slotted.length === 0) return "waiting";
  if (slotted.length >= paced.slots) {
    // The builders are busy; the planner can still refill the map.
    if (await planIfThin(app, repo, by, crew, active, 0, now)) return "planned";
    return "full";
  }

  const busyIssues = new Set(active.map((r) => r.issueId));
  const inFlight = new Map<string, number>();
  for (const r of active)
    if (r.actorId !== null)
      inFlight.set(r.actorId, (inFlight.get(r.actorId) ?? 0) + 1);
  const graph = repoGraph(app.db, repo.id);
  const proposed = proposedWork(app.db, repo);
  const ready = readyNow(graph).filter(
    (r) =>
      r.issue.id !== repo.directionIssueId &&
      !busyIssues.has(r.issue.id) &&
      !proposed.has(r.issue.number) &&
      (r.issue.assigneeId === null || !planners.has(r.issue.assigneeId)) &&
      !stalled(app, repo, r.issue) &&
      parkedCount(app, repo, r.issue.id) < PARK_STRIKES,
  );
  const next = await nextOf(app, repo, ready);
  if (next !== undefined) {
    const routed = await routeIssue(app, repo, next.issue, crew, inFlight);
    if (!routed) return "paused";
    const builder = routed.builder;
    // Assigning is the event that starts a run. An issue already carrying
    // the builder's name is assigned afresh so the event fires once more.
    if (next.issue.assigneeId === builder.user.id) {
      const cleared = assignIssue(app, by, repo, next.issue, null);
      if (!cleared.ok) return "idle";
    }
    const current = getIssueById(app.db, next.issue.id) ?? next.issue;
    const assigned = assignIssue(app, by, repo, current, builder.user);
    if (!assigned.ok) {
      log.warn("could not assign the next ready issue", {
        repo: `${repo.ownerName}/${repo.name}`,
        issue: next.issue.number,
        error: assigned.error,
      });
      return "idle";
    }
    log.info("picked", {
      repo: `${repo.ownerName}/${repo.name}`,
      issue: next.issue.number,
      agent: builder.user.username,
      size: routed.size,
      by: routed.by,
    });
    // Planning runs alongside building: when the ready list is thin, the
    // planner is asked now, not when the builders have run it dry.
    await planIfThin(app, repo, by, crew, active, ready.length - 1, now);
    return "picked";
  }

  // Nothing is ready: the planner is asked, thin or dry, at most every
  // REPLAN_AFTER_MS.
  if (await planIfThin(app, repo, by, crew, active, 0, now)) return "planned";
  return "idle";
}

/** The map is thin below this many ready issues; the planner refills it. */
const THIN_MAP = 3;

/**
 * Give the planner the direction when the map is thin — fewer than a few
 * ready issues — and no planning run is in flight, and the last one is
 * old enough. Returns whether a planning run was set up. Planning runs
 * alongside building: the builders are never waited for.
 */
function notPlanned(repo: Repo, why: string): false {
  log.info("planner not asked", {
    repo: `${repo.ownerName}/${repo.name}`,
    why,
  });
  return false;
}

async function planIfThin(
  app: App,
  repo: Repo,
  by: User,
  crew: readonly { agent: Agent; role: CrewRole }[],
  active: readonly Run[],
  ready: number,
  now: Date,
): Promise<boolean> {
  if (ready >= THIN_MAP) return false;
  const planner = crew.find((c) => c.role === "planner")?.agent;
  if (planner === undefined) return notPlanned(repo, "no planner on the crew");
  if (repo.autonomyDirection.trim() === "")
    return notPlanned(repo, "no direction written");
  const direction = ensureDirectionIssue(app, by, repo);
  if (!direction) return notPlanned(repo, "no direction issue");
  if (active.some((r) => r.issueId === direction.id))
    return notPlanned(repo, "a planning run is in flight");
  const lastPlan = app.db
    .query<{ state: string; created_at: string }, [string]>(
      `SELECT state, created_at FROM run WHERE issue_id = ?1 AND kind = 'agent'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(direction.id);
  if (breakerTripped(app.db, direction.id, now))
    return notPlanned(repo, "parked: three failed runs in an hour");
  if (lastPlan !== null && lastPlan !== undefined) {
    // A planner that declined the direction is not asked again until a
    // person has said something on it.
    if (lastPlan.state === "failed" && declinedUnanswered(app, repo, direction))
      return notPlanned(repo, "the planner declined; waiting for a person");
    if (lastPlan.state === "queued" || lastPlan.state === "running")
      return notPlanned(repo, "a planning run is in flight");
    if (
      now.getTime() - new Date(lastPlan.created_at).getTime() <
      REPLAN_AFTER_MS
    )
      return notPlanned(repo, "planned recently");
  } else if (direction.assigneeId === planner.user.id) {
    return notPlanned(repo, "the planner already holds the direction");
  }
  if (direction.assigneeId !== null) {
    const cleared = assignIssue(app, by, repo, direction, null);
    if (!cleared.ok)
      return notPlanned(repo, `could not clear: ${String(cleared.error)}`);
  }
  const current = getIssueById(app.db, direction.id) ?? direction;
  const assigned = assignIssue(app, by, repo, current, planner.user);
  if (!assigned.ok)
    return notPlanned(repo, `could not assign: ${String(assigned.error)}`);
  log.info(
    ready === 0 ? "map ran dry; planner asked" : "map is thin; planner asked",
    {
      repo: `${repo.ownerName}/${repo.name}`,
      planner: planner.user.username,
      ready,
    },
  );
  return true;
}

/**
 * An issue a builder already ran on and left without a pull — declined, or
 * cut short — is not picked again by the clock: running it again blind is
 * the loop autonomy refuses. It waits for a person's word, which is a
 * feedback run like any other.
 */
function stalled(app: App, repo: Repo, issue: Issue): boolean {
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
      `SELECT DISTINCT author_id AS id FROM comment
        WHERE issue_id = ?1 AND created_at > ?2 AND origin_author IS NULL`,
    )
    .all(issue.id, last.created_at)
    .some((r) => speaksForCrew(app.db, repo, getUserById(app.db, r.id)));
}

/** Whether the newest run on the issue was a decline and no person has spoken since. */
function declinedUnanswered(app: App, repo: Repo, issue: Issue): boolean {
  return declineOf(app.db, repo, issue.id) !== undefined;
}

/** A planner's decline that nobody has answered yet. */
export interface PlannerDecline {
  readonly repo: Repo;
  /** The direction issue the planner declined. */
  readonly issue: Issue;
  /** The declining run: a new decline is a new id, so it pages once. */
  readonly runId: string;
  /** What the planner said, without the `declined:` mark. */
  readonly words: string;
  readonly at: string;
}

/**
 * The newest agent run on an issue, when it is a decline no person who
 * may direct the crew has answered since: the state `planIfThin` waits in.
 * A reader's comment is no answer (#619).
 */
function declineOf(
  db: Database,
  repo: Repo,
  issueId: string,
): { id: string; summary: string; created_at: string } | undefined {
  const last = db
    .query<{ id: string; state: string; summary: string; created_at: string }, [string]>(
      `SELECT id, state, summary, created_at FROM run WHERE issue_id = ?1 AND kind = 'agent'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(issueId);
  if (!last || last.state !== "failed" || !last.summary.startsWith("declined"))
    return undefined;
  const spoke = db
    .query<{ id: string }, [string, string]>(
      `SELECT DISTINCT author_id AS id FROM comment
       WHERE issue_id = ?1 AND created_at > ?2 AND origin_author IS NULL
         AND body NOT LIKE 'Parked by the crew%'`,
    )
    .all(issueId, last.created_at)
    .map((r) => r.id);
  return directorsAmong(db, repo, spoke).length === 0 ? last : undefined;
}

/**
 * The autonomous repositories among these whose planner declined the
 * direction and waits for a person: the board's line, the asks, the phone.
 * One small read per repository that has a direction issue.
 */
export function plannerDeclines(
  db: Database,
  repos: readonly Repo[],
): PlannerDecline[] {
  const out: PlannerDecline[] = [];
  for (const repo of repos) {
    if (repo.autonomy !== "autonomous" || repo.directionIssueId === null)
      continue;
    const issue = getIssueById(db, repo.directionIssueId);
    if (!issue || issue.state !== "open") continue;
    const run = declineOf(db, repo, issue.id);
    if (run === undefined) continue;
    out.push({
      repo,
      issue,
      runId: run.id,
      words: run.summary.replace(/^declined:?\s*/, ""),
      at: run.created_at,
    });
  }
  return out;
}

/**
 * The breaker trips: the assignment is cleared and one note says why, once.
 * The map reads the note as `parked`; the board's "needs you" lists it.
 */
export function parkForBreaker(
  app: App,
  repo: Repo,
  issue: Issue,
  agent: Agent,
): void {
  const author =
    (repo.autonomyBy === null ? undefined : getUserById(app.db, repo.autonomyBy)) ??
    agent.user;
  if (issue.assigneeId !== null) assignIssue(app, author, repo, issue, null);
  const last = listComments(app.db, issue.id).at(-1);
  if (last?.body === BREAKER_NOTE) return;
  addComment(app, author, repo, issue, BREAKER_NOTE);
  log.info("parked by the breaker", {
    repo: `${repo.ownerName}/${repo.name}`,
    issue: issue.number,
  });
}

/** How many times the crew has parked this issue since a person who directs it or the planner last spoke (`parks.ts`). */
export function parkedCount(app: App, repo: Repo, issueId: string): number {
  return countParks(app.db, repo, issueId);
}

/**
 * Park an issue: a note with the reason and the assignee cleared, so the
 * planner rewrites it on its next pass and the crew tries it fresh once.
 */
export function parkIssue(
  app: App,
  repo: Repo,
  issue: Issue,
  why: string,
): boolean {
  if (repo.autonomy !== "autonomous" || repo.autonomyBy === null) return false;
  const by = getUserById(app.db, repo.autonomyBy);
  if (!by || issue.state !== "open") return false;
  if (issue.assigneeId !== null) assignIssue(app, by, repo, issue, null);
  addComment(app, by, repo, issue, `Parked by the crew: ${why}`);
  log.info("parked", {
    repo: `${repo.ownerName}/${repo.name}`,
    issue: issue.number,
    why,
  });
  return true;
}

/**
 * After a builder's run on an issue ends without a pull to show for it —
 * declined, out of budget, or simply nothing pushed — the issue is parked
 * rather than left stalled: one fresh try later, then the planner's. A run
 * the provider or a restart cut short is interrupted, not parked: no note,
 * no strike.
 */
export function settleAgentRun(
  app: App,
  repo: Repo,
  run: {
    readonly issueId: string;
    readonly state: string;
    readonly summary: string;
    readonly reason: string;
    readonly actorId: string | null;
  },
): boolean {
  if (repo.autonomy !== "autonomous") return false;
  if (run.state !== "ok" && run.state !== "failed") return false;
  // A planner is done with the direction once its run ends, whichever way:
  // a stale assignment must not start another.
  if (run.issueId === repo.directionIssueId && repo.autonomyBy !== null) {
    const direction = getIssueById(app.db, run.issueId);
    const by = getUserById(app.db, repo.autonomyBy);
    if (direction?.assigneeId && by) assignIssue(app, by, repo, direction, null);
    return false;
  }
  if (run.reason === "review") return false;
  if (/opened pull #|updated pull #/.test(run.summary)) return false;
  if (interruptionOf(run.summary) !== undefined) return false;
  if (answeredWithoutChange(app, repo, run)) return true;
  const issue = getIssueById(app.db, run.issueId);
  if (!issue || issue.kind !== "issue" || issue.state !== "open") return false;
  if (issue.id === repo.directionIssueId) return false;
  if (
    run.actorId !== null &&
    crewRole(app.db, repo.id, run.actorId) !== "builder"
  )
    return false;
  return parkIssue(
    app,
    repo,
    issue,
    `the run ended without a pull: ${run.summary || run.state}`,
  );
}

/**
 * A builder's run on its pull that ended without a push while the crew's
 * reviewer still asks for changes on the head: the request was not
 * answered, and nothing will answer it. The pull is parked rather than
 * left waiting on a verdict that will not move.
 */
function answeredWithoutChange(
  app: App,
  repo: Repo,
  run: { readonly issueId: string; readonly reason: string; readonly actorId: string | null },
): boolean {
  if (run.reason !== "feedback" || run.actorId === null) return false;
  if (crewRole(app.db, repo.id, run.actorId) !== "builder") return false;
  const issue = getIssueById(app.db, run.issueId);
  if (!issue || issue.kind !== "pull" || issue.state !== "open") return false;
  const pull = getPull(app.db, repo.id, issue.number);
  if (!pull || pull.mergedAt !== null) return false;
  if (reviewSummary(app.db, pull.id, pull.headOid).changesRequested === 0)
    return false;
  return parkPull(
    app,
    repo,
    pull,
    "the reviewer asked for changes and the builder's run ended without pushing any",
  );
}

/**
 * Park a pull the crew cannot finish: close it with the reason, put its
 * issues back on the map unassigned with the same reason, and move on. A
 * repository on its own never waits for a person; a parked issue is the
 * planner's to split or drop on its next pass, and one parked twice is
 * left to the direction.
 */
export function parkPull(
  app: App,
  repo: Repo,
  pull: Pull,
  why: string,
): boolean {
  if (repo.autonomy !== "autonomous" || repo.autonomyBy === null) return false;
  const by = getUserById(app.db, repo.autonomyBy);
  if (!by) return false;
  const issue = getIssueById(app.db, pull.id);
  if (!issue || issue.state !== "open") return false;
  const note = `Parked by the crew: ${why}`;
  addComment(app, by, repo, issue, note);
  const closed = setIssueState(app, by, repo, issue, "closed");
  if (!closed.ok) return false;
  for (const number of closesFromBody(pull.body)) {
    const about = getIssue(app.db, repo.id, number);
    if (!about || about.state !== "open") continue;
    if (about.assigneeId !== null) assignIssue(app, by, repo, about, null);
    addComment(
      app,
      by,
      repo,
      about,
      `${note} (pull #${pull.number} closed). Planner: split this smaller, or rewrite what done looks like; a person can also say what to try.`,
    );
  }
  log.info("parked", {
    repo: `${repo.ownerName}/${repo.name}`,
    pull: pull.number,
    why,
  });
  return true;
}

/**
 * Green pulls that have not landed — a check that passed before autonomy
 * was turned on, or one the event missed — land on the tick, so nothing
 * green waits on chance.
 */
export async function sweepGreen(app: App, repo: Repo): Promise<number> {
  if (repo.autonomy !== "autonomous") return 0;
  let landed = 0;
  for (const pull of listPulls(app.db, repo.id, { state: "open", limit: 50 }))
    if (await landIfGreen(app, repo, pull)) landed++;
  return landed;
}

/** The label every direction issue's title starts with. Read elsewhere to
 * find a repository's standing direction — keep it exactly as it is. */
const DIRECTION_PREFIX = "Direction: ";
/** How much of the direction fits in the title, capped so the title
 * (prefix included) never exceeds `MAX_TITLE`. */
const DIRECTION_TITLE_LIMIT = Math.min(120, MAX_TITLE - DIRECTION_PREFIX.length);

/** Cuts `text` to at most `limit` characters at a word boundary, ending in
 * "…" when something was cut — never mid-word, never a dangling "(" before
 * the ellipsis. Text that already fits is returned unchanged. */
export function truncateAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const ellipsis = "…";
  const budget = Math.max(limit - ellipsis.length, 0);
  let cut = text.slice(0, budget);
  if (text[budget] !== " " && text[budget] !== undefined) {
    const lastSpace = cut.lastIndexOf(" ");
    cut = lastSpace === -1 ? "" : cut.slice(0, lastSpace);
  }
  return cut.replace(/[\s(]+$/, "") + ellipsis;
}

/**
 * The issue the planner works from: the direction, as an open issue the
 * run can be about. Made once, kept, and never counted as work.
 */
export function ensureDirectionIssue(
  app: App,
  by: User,
  repo: Repo,
): Issue | undefined {
  if (repo.directionIssueId !== null) {
    const existing = getIssueById(app.db, repo.directionIssueId);
    if (existing && existing.state === "open") return existing;
  }
  const opened = openIssue(app, by, repo, {
    title: `${DIRECTION_PREFIX}${truncateAtWord(repo.autonomyDirection.trim(), DIRECTION_TITLE_LIMIT)}`,
    body: `${repo.autonomyDirection.trim()}\n\nThis issue carries the repository's direction. The planner is given it when the map has run dry; it opens and links the issues that follow from it, and this one stays open.`,
  });
  if (!opened.ok) return undefined;
  setDirectionIssue(app.db, repo.id, opened.value.id);
  return opened.value;
}

/** Every repository that runs on its own, one turn each. */
export async function autonomyTick(app: App, now = new Date()): Promise<void> {
  if (crewOffInPreview()) return;
  for (const repo of listAutonomousRepos(app.db)) {
    try {
      await sweepGreen(app, repo);
      const current = getRepoById(app.db, repo.id) ?? repo;
      const did = await driveRepo(app, current, now);
      // Every tick says what it did and why, so an app that sits still is
      // never a mystery: the numbers behind "idle" are on the line.
      const status = autonomyStatus(app, current, now);
      const graph = repoGraph(app.db, current.id);
      log.info("tick", {
        repo: `${repo.ownerName}/${repo.name}`,
        did,
        ready: readyNow(graph).length,
        active: status.active,
        slots: status.slots,
        spent: `${status.spentTodayUsd.toFixed(2)}/${status.ceilingUsd}`,
        ...(status.paused === null ? {} : { paused: status.paused }),
      });
    } catch (error) {
      log.error("autonomy tick failed", {
        repo: `${repo.ownerName}/${repo.name}`,
        error: String(error),
      });
    }
  }
  // Review is not autonomy's alone: an agent's green pull is read by the
  // crew's reviewer in every repository that has one.
  try {
    await sweepReviews(app);
  } catch (error) {
    log.error("review sweep failed", { error: String(error) });
  }
}

/**
 * Which ready issue next. The rule takes the top of the ready list (the
 * critical path); the decider, when there is one, chooses among the first
 * few with the direction in hand. Recorded, so a pick can be judged later.
 */
/**
 * The ready issues as the next-issue decider reads them: a reader's words
 * carry the brief's mark here too (`markReaders`), though it can only pick
 * a number.
 */
export function readyState(
  db: Database,
  repo: Repo,
  few: readonly Ranked[],
): Record<string, unknown>[] {
  return markReaders(
    db,
    repo,
    few.map((r) => r.issue),
  ).map((issue, n) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body.slice(0, 400),
    holdsUp: few[n]!.holdsUp,
    ...(issue.untrusted === undefined ? {} : { untrusted: issue.untrusted }),
  }));
}

async function nextOf(
  app: App,
  repo: Repo,
  ready: readonly Ranked[],
): Promise<Ranked | undefined> {
  const first = ready[0];
  if (first === undefined) return undefined;
  if (ready.length === 1 || app.config.decider === undefined) return first;
  const few = ready.slice(0, 6);
  const options = few.map((r) => String(r.issue.number));
  const describe: Record<string, string> = {};
  for (const r of few)
    describe[String(r.issue.number)] =
      `#${r.issue.number} ${r.issue.title}` +
      (r.holdsUp > 0 ? ` (holds up ${r.holdsUp})` : "");
  const decided = await decideAndRecord(
    app,
    { kind: "next", repo, issue: first.issue },
    {
      direction: repo.autonomyDirection,
      ready: readyState(app.db, repo, few),
    },
    {
      next: {
        options,
        about:
          "Which of these ready issues moves the direction forward most right now? Prefer what unblocks others and what the direction names.",
        describe,
      },
    },
    () => ({ next: certain(options, options[0]!) }),
  );
  return (
    few.find((r) => String(r.issue.number) === decided.answers.next.choice) ??
    first
  );
}

/** Pull id → the `head:base` tips a merge last conflicted between. */
const conflicted = new Map<string, string>();

/** A merge refusal in words a log can carry. */
function mergeWhy(error: AccessError | MergePullError): string {
  if (typeof error === "string") return error;
  switch (error.kind) {
    case "conflict":
      return `conflict: ${error.files.join(", ")}`;
    case "git":
      return `git: ${error.message}`;
    default:
      return error.kind;
  }
}

/**
 * Queue one run for the pull's agent to merge main into its branch. One
 * waiting is enough, and the automatic tries since a person last spoke
 * stop at the same limit a failing check does — past it, the pull waits
 * for a person.
 */
export function bringUpToDate(
  app: App,
  repo: Repo,
  pull: Pull,
  files: readonly string[],
): string | undefined {
  const issue = getIssueById(app.db, pull.id);
  if (!issue || issue.state !== "open") return undefined;
  const agent = agentFor(app, issue);
  if (!agent) return undefined;
  if (activeRunFor(app.db, "agent", issue.id) !== undefined)
    return agent.user.username;
  const tries = automaticRunsSince(
    app.db,
    issue.id,
    lastHumanWord(app, issue, agent),
  );
  if (tries >= CHECK_FAILED_LIMIT) {
    // Autonomous: parked, never waiting. Assisted: the person's word.
    parkPull(
      app,
      repo,
      pull,
      `main moved under it ${tries} times and the branch could not be brought up to date (${files.join(", ")})`,
    );
    return undefined;
  }
  queueAgentRun(app, repo, issue, agent, "conflict", undefined, {
    notBefore: new Date().toISOString(),
    attempt: 0,
    summary: `main moved: ${files.join(", ")}`,
  });
  return agent.user.username;
}

/**
 * Whether the review gate lets this green head land: `pass` with no
 * reviewer on the crew, or with an approval on this head and no change
 * requested; `hold` while the review is out or changes are asked for; and
 * `lapsed` when the reviewer was asked twice and never answered — the pull
 * lands without it, and says so (`crew/review.ts`).
 */
async function reviewed(
  app: App,
  repo: Repo,
  pull: Pull,
): Promise<"pass" | "hold" | "lapsed"> {
  if (reviewersOf(app.db, repo.id).length === 0) return "pass";
  const seen = reviewSummary(app.db, pull.id, pull.headOid);
  if (seen.changesRequested > 0) return "hold";
  if (seen.approvals > 0) return "pass";
  const stage = await sendToReview(app, repo, pull);
  return stage === "lapsed" ? "lapsed" : stage === "none" ? "pass" : "hold";
}

/**
 * Ship on green. An open pull whose head has a passing check and a passing
 * deploy, and nothing failed, lands as the person who turned autonomy on —
 * with their review and check requirements still enforced inside the
 * merge. Only in `autonomous`; `assisted` leaves every green pull for a
 * look.
 */
export async function landIfGreen(
  app: App,
  repo: Repo,
  pull: Pull,
): Promise<boolean> {
  if (repo.autonomy !== "autonomous" || repo.autonomyBy === null) return false;
  if (pull.state !== "open" || pull.mergedAt !== null) return false;
  // Only work the crew wrote, or a writer's, lands on green by itself: a
  // reader's pull — from a fork, say — waits for a person, outsiders
  // switch or not, and is never sent to the crew's reviewer (#619).
  if (!landsOnItsOwn(app.db, repo, pull)) return false;
  const by = getUserById(app.db, repo.autonomyBy);
  if (!by) return false;
  // The newest run of each kind is what the head says: a red that a re-run
  // on the same commit has since turned green is history.
  const checks = verdictForHead(app.db, pull.id, pull.headOid);
  if (checks.length === 0) return false;
  if (checks.some((c) => c.state !== "ok")) return false;
  // A stop the crew took on a red check ends with the green after it; a
  // person's stop waits for a person.
  const greenAt = checks
    .map((c) => c.finishedAt ?? "")
    .reduce((a, b) => (a > b ? a : b), "");
  if (stopStands(latestDecision(app.db, pull.id, "retry"), greenAt))
    return false;
  // Conflicts first: a pull that no longer merges is the crew's to bring
  // up to date, before anyone is asked whether it should land. A conflict
  // is remembered by the two tips it was between: until one of them moves
  // there is nothing new to try.
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const baseTip =
    (await resolveOid(dir, `refs/heads/${pull.baseBranch}`)) ?? "";
  const between = `${pull.headOid}:${baseTip}`;
  if (conflicted.get(pull.id) === between) return false;
  if (baseTip !== "") {
    const clean = await mergeable(dir, baseTip, pull.headOid);
    if (!clean.ok) {
      if (clean.error.kind === "conflict") {
        conflicted.set(pull.id, between);
        bringUpToDate(app, repo, pull, clean.error.files);
      }
      return false;
    }
  }
  // A pull that loosens the contract is a change of policy, which is a
  // wall: decided by a person, never crossed by the crew. The pull stays
  // green and open, on the studio's cards, until someone lands it.
  const wall = await wallOf(dir, baseTip, pull.headOid);
  if (wall !== undefined) {
    // Once per head, as a ledger row: it is what puts the card on the
    // studio, and what the audit's third lens will read as a crossing.
    const cells = wall.unsound ?? wall.loosened.map(wallSentence);
    const earlier = latestDecision(app.db, pull.id, "land");
    // Told once per head — and again if what the wall says about this head
    // has changed, so the card never quotes cells the rule no longer counts.
    const told =
      earlier?.answer === "wall" &&
      typeof earlier.state === "object" &&
      earlier.state !== null &&
      (earlier.state as { head?: unknown }).head === pull.headOid &&
      JSON.stringify((earlier.state as { cells?: unknown }).cells) ===
        JSON.stringify(cells);
    if (!told) {
      recordDecision(app.db, {
        kind: "land",
        repoId: repo.id,
        issueId: pull.id,
        state: {
          head: pull.headOid,
          cells,
          unsound: wall.unsound !== undefined,
        },
        answer: "wall",
        p: 1,
        by: "wall",
        ms: 0,
      });
      log.info("green; crosses the wall, left to a person", {
        repo: `${repo.ownerName}/${repo.name}`,
        pull: pull.number,
        cells: cells.join("; "),
      });
    }
    return false;
  }
  // One gate for every pull, whoever wrote it: when the crew has a
  // reviewer, a green head is queued for review and waits for an approval
  // on that very head (a person's counts the same). A push is a new head,
  // so it starts over. Without a reviewer the pull lands as it always has,
  // and so does one whose review lapsed.
  const review = await reviewed(app, repo, pull);
  if (review === "hold") return false;
  // Green and clear of the wall lands. An autonomous repository does not
  // wait on a person; the ledger keeps the landing as the rule it is, once
  // per head, so the week's numbers still add up.
  const already = latestDecision(app.db, pull.id, "land");
  if (
    !(
      already?.answer === "ship" &&
      typeof already.state === "object" &&
      already.state !== null &&
      (already.state as { head?: unknown }).head === pull.headOid
    )
  )
    recordDecision(app.db, {
      kind: "land",
      repoId: repo.id,
      issueId: pull.id,
      state:
        review === "lapsed"
          ? { head: pull.headOid, review: "lapsed" }
          : { head: pull.headOid },
      answer: "ship",
      p: 1,
      by: "rule",
      ms: 0,
    });
  const merged = await mergePull(app, by, repo, pull, "squash");
  if (!merged.ok) {
    const why = mergeWhy(merged.error);
    log.info("green but not landed", {
      repo: `${repo.ownerName}/${repo.name}`,
      pull: pull.number,
      why,
    });
    // Main moved under a green pull: that is the agent's to fix, once per
    // move, and never past the same limit a red check gets.
    if (typeof merged.error !== "string" && merged.error.kind === "conflict") {
      conflicted.set(pull.id, between);
      bringUpToDate(app, repo, pull, merged.error.files);
    }
    return false;
  }
  conflicted.delete(pull.id);
  resolveOpen(app.db, pull.id, "land", "shipped");
  // Said once it has landed, so the note wakes no builder: the review was
  // asked for and never came.
  if (review === "lapsed") {
    const landed = getIssueById(app.db, pull.id);
    if (landed)
      addComment(
        app,
        by,
        repo,
        landed,
        "Landed on green without a review: the crew's reviewer was asked twice and posted no verdict.",
      );
  }
  for (const number of closesFromBody(pull.body)) {
    const closed = getIssue(app.db, repo.id, number);
    if (closed) resolveOpen(app.db, closed.id, "next", "shipped");
  }
  log.info("landed on green", {
    repo: `${repo.ownerName}/${repo.name}`,
    pull: pull.number,
  });
  return true;
}

export { pickBuilder };

export function roleOf(app: App, repo: Repo, agent: Agent): CrewRole {
  return (
    listCrewRoles(app.db, repo.id).find(
      (c) => c.agent.user.id === agent.user.id,
    )?.role ?? "builder"
  );
}

export { getPull };
