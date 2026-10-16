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
import { gateOnLand, releaseOnLand } from "../checks/landing.ts";
import { mergeable, resolveOid, treeOf } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { mergePull } from "../actions/pulls.ts";
import {
  listCrewRoles,
  type Agent,
  type CrewRole,
  crewRole,
} from "../core/agents.ts";
import { pickBuilder, routeIssue } from "./route.ts";
import { coveredByRedFix } from "./red_fix.ts";
import { readyNow, repoGraph, type Ranked } from "../core/dependencies.ts";
import {
  latestDecision,
  recordDecision,
  resolveOpen,
  stopStands,
} from "../core/decisions.ts";
import { getHold } from "../core/holds.ts";
import { certain } from "./decide.ts";
import { decideAndRecord } from "./ledger.ts";
import { sentinelTick } from "./sentinel.ts";
import { triageTick } from "./triage.ts";
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
  pullDir,
} from "../core/pulls.ts";
import {
  canWrite,
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
import {
  capReached,
  ISSUE_RUN_CAP,
  SKIP_SUMMARY,
  skipsReplan,
} from "./guard.ts";
import { BY_CREW, DONE_LIKE } from "../core/done_on_main.ts";
import { ALREADY_NOTE, alreadyDoneOids } from "./already.ts";
import { interruptionOf } from "./interrupted.ts";
import {
  PARK_NOTE,
  PARK_STRIKES,
  PLANNER_HINT,
  parkedCount as countParks,
  parkedTwice,
  parkReason,
  parkReasons,
} from "./parks.ts";
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
  const busyIssues = new Set(active.map((r) => r.issueId));
  const graph = repoGraph(app.db, repo.id, { sealed: true });
  const proposed = proposedWork(app.db, repo);
  const ready = readyNow(graph).filter(
    (r) =>
      r.issue.id !== repo.directionIssueId &&
      !busyIssues.has(r.issue.id) &&
      !proposed.has(r.issue.number) &&
      (r.issue.assigneeId === null || !planners.has(r.issue.assigneeId)) &&
      !stalled(app, repo, r.issue) &&
      !atRunCap(app, repo, r.issue) &&
      parkedCount(app, repo, r.issue.id) < PARK_STRIKES &&
      !coveredByRedFix(app.db, repo.id, r.issue),
  );
  if (slotted.length >= paced.slots) {
    // The builders are busy; the planner can still refill the map, when
    // it is thin — counted, never assumed: a full crew with a full map is
    // not a reason to plan (#1097).
    if (await planIfThin(app, repo, by, crew, active, ready.length, now))
      return "planned";
    return "full";
  }

  const inFlight = new Map<string, number>();
  for (const r of active)
    if (r.actorId !== null)
      inFlight.set(r.actorId, (inFlight.get(r.actorId) ?? 0) + 1);
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
 * ready issues — or when the crew has handed it an issue it parked twice,
 * and no planning run is in flight, and the last one is old enough.
 * Returns whether a planning run was set up. Planning runs alongside
 * building: the builders are never waited for.
 *
 * A hand-over is owed one pass, not one a minute: it asks only while it is
 * newer than the last planning run. That one pass is owed even by a planner
 * that declined the direction — the decline answered the direction, and
 * this is something it has not seen. What the pass leaves as it was stays
 * on the board and in every later brief (`parks.ts`).
 */
function notPlanned(repo: Repo, why: string): false {
  log.info("planner not asked", {
    repo: `${repo.ownerName}/${repo.name}`,
    why,
  });
  return false;
}

/** Nothing landing for this long, with a pull closed unmerged, holds the planner. */
const LANDING_WINDOW_MS = 48 * 60 * 60_000;
/** More ready, unassigned issues than slots × this fill the plate. */
const PLATE_PER_SLOT = 3;

export type PlannerHold =
  | { readonly kind: "nothing landed"; readonly since: string }
  | { readonly kind: "plate full"; readonly ready: number };

/** Why a hold is held, as the tick log says it. */
export function holdWhy(hold: PlannerHold): string {
  return hold.kind === "plate full"
    ? `plate full (${hold.ready} ready)`
    : `nothing landed since ${hold.since.slice(0, 10)}`;
}

/** The same reason in plain words, for the board. */
export function holdWords(hold: PlannerHold): string {
  if (hold.kind === "plate full")
    return `Planning paused: ${hold.ready} issues are ready and waiting`;
  const at = new Date(hold.since);
  const day = at.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `Planning paused: nothing has landed since ${day}`;
}

/**
 * A word on the direction issue from someone who may write here, newer than
 * the planner's last pass: the owner steering, which is never held.
 */
function steered(app: App, repo: Repo): boolean {
  if (repo.directionIssueId === null) return false;
  const last = app.db
    .query<{ created_at: string }, [string]>(
      `SELECT created_at FROM run WHERE issue_id = ?1 AND kind = 'agent'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(repo.directionIssueId);
  return app.db
    .query<{ id: string }, [string, string]>(
      `SELECT DISTINCT author_id AS id FROM comment
        WHERE issue_id = ?1 AND created_at > ?2 AND origin_author IS NULL`,
    )
    .all(repo.directionIssueId, last?.created_at ?? "")
    .some((r) => {
      const who = getUserById(app.db, r.id);
      return who !== undefined && who.kind !== "agent" && canWrite(app.db, repo, who);
    });
}

/**
 * Whether the planner is held for this repository: no pull merged in 48 h
 * while one closed unmerged, or more ready, unassigned issues than
 * `slots × 3`. A steer from a writer on the direction issue lifts it.
 */
export function plannerHold(
  app: App,
  repo: Repo,
  now = new Date(),
): PlannerHold | null {
  if (steered(app, repo)) return null;
  const cutoff = new Date(now.getTime() - LANDING_WINDOW_MS).toISOString();
  const merged = app.db
    .query<{ at: string | null }, [string]>(
      `SELECT MAX(p.merged_at) AS at FROM pull p JOIN issue i ON i.id = p.issue_id
        WHERE i.repo_id = ?1`,
    )
    .get(repo.id)?.at ?? null;
  if (merged === null || merged < cutoff) {
    const refused = app.db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM issue i JOIN pull p ON p.issue_id = i.id
          WHERE i.repo_id = ?1 AND i.kind = 'pull' AND i.state = 'closed'
            AND p.merged_at IS NULL AND i.closed_at >= ?2`,
      )
      .get(repo.id, cutoff)?.n ?? 0;
    if (refused > 0) return { kind: "nothing landed", since: merged ?? cutoff };
  }
  const ready = readyNow(repoGraph(app.db, repo.id, { sealed: true })).filter(
    (r) => r.issue.id !== repo.directionIssueId && r.issue.assigneeId === null,
  ).length;
  if (ready > Math.max(1, repo.autonomySlots) * PLATE_PER_SLOT)
    return { kind: "plate full", ready };
  return null;
}

function held(repo: Repo, why: string): false {
  log.info("tick", {
    repo: `${repo.ownerName}/${repo.name}`,
    planner: "held",
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
  const handed = parkedTwice(app.db, [repo]);
  if (ready >= THIN_MAP && handed.length === 0) return false;
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
  if (breakerTripped(app.db, repo, direction.id, now))
    return notPlanned(repo, "parked: three failed runs in an hour");
  // The hand-overs the planner has not been given: newer than its last pass.
  const seen = lastPlan?.created_at ?? "";
  const owed = handed.filter((issue) => issue.at > seen);
  if (ready >= THIN_MAP && owed.length === 0) return false;
  if (atRunCap(app, repo, direction))
    return notPlanned(repo, "parked: the direction is at its run cap");
  // An issue the crew handed over is owed its pass whatever the hold: the
  // planner splitting it is how work starts landing again.
  const hold = owed.length === 0 ? plannerHold(app, repo, now) : null;
  if (hold !== null) return held(repo, holdWhy(hold));
  if (lastPlan !== null && lastPlan !== undefined) {
    // A planner that declined the direction is not asked again until a
    // person has said something on it, or the crew hands it an issue.
    if (
      owed.length === 0 &&
      lastPlan.state === "failed" &&
      declinedUnanswered(app, repo, direction)
    )
      return notPlanned(repo, "the planner declined; waiting for a person");
    if (lastPlan.state === "queued" || lastPlan.state === "running")
      return notPlanned(repo, "a planning run is in flight");
    if (
      now.getTime() - new Date(lastPlan.created_at).getTime() <
      REPLAN_AFTER_MS
    )
      return notPlanned(repo, "planned recently");
    // Nobody spoke and the map has not moved since the last pass: another
    // would read its own summary and change nothing (#1097).
    if (
      owed.length === 0 &&
      skipsReplan(app.db, repo, direction, planner, lastPlan.created_at)
    )
      return notPlanned(repo, SKIP_SUMMARY);
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
    owed.length > 0
      ? "parked twice; planner asked"
      : ready === 0
        ? "map ran dry; planner asked"
        : "map is thin; planner asked",
    {
      repo: `${repo.ownerName}/${repo.name}`,
      planner: planner.user.username,
      ready,
      ...(owed.length > 0
        ? { parkedTwice: owed.map((issue) => `#${issue.number}`).join(" ") }
        : {}),
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
      `SELECT DISTINCT n.author_id AS id FROM comment n
        WHERE n.issue_id = ?1 AND n.created_at > ?2 AND n.origin_author IS NULL
          AND NOT (n.body LIKE '${DONE_LIKE}' AND ${BY_CREW})`,
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
      `SELECT DISTINCT n.author_id AS id FROM comment n
       WHERE n.issue_id = ?1 AND n.created_at > ?2 AND n.origin_author IS NULL
         AND n.body NOT LIKE 'Parked by the crew%'
         AND NOT (n.body LIKE '${DONE_LIKE}' AND ${BY_CREW})`,
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
 * The map reads the note as `parked`; the asks list it for a person.
 */
export function parkForBreaker(
  app: App,
  repo: Repo,
  issue: Issue,
  agent: Agent,
  note: string = BREAKER_NOTE,
): boolean {
  const author =
    (repo.autonomyBy === null ? undefined : getUserById(app.db, repo.autonomyBy)) ??
    agent.user;
  if (issue.assigneeId !== null) assignIssue(app, author, repo, issue, null);
  const last = listComments(app.db, issue.id).at(-1);
  if (last?.body === note) return false;
  addComment(app, author, repo, issue, note);
  log.info(note === BREAKER_NOTE ? "parked by the breaker" : "parked at the run cap", {
    repo: `${repo.ownerName}/${repo.name}`,
    issue: issue.number,
  });
  return true;
}

/** Whether `issue` is at its run cap (`guard.ts`): the clock neither picks nor plans it. */
export function atRunCap(app: App, repo: Repo, issue: Issue): boolean {
  return capReached(app.db, repo, issue, app.config.issueRunCap ?? ISSUE_RUN_CAP);
}

/** How many times the crew has parked this issue since a person who directs it last spoke (`parks.ts`). */
export function parkedCount(app: App, repo: Repo, issueId: string): number {
  return countParks(app.db, repo, issueId);
}

/** What happens to an issue the crew hands over, said once on the issue. */
const HANDED_OVER =
  "The planner splits it, replaces it with a fresh issue, or defers it; a person can also say what to try. Nothing starts here until then, and the board lists it.";

/**
 * What a park says on its issue. A first strike is the reason — and, when a
 * pull closed with it, a word to the planner. The strike that takes the
 * issue out of the crew's hands also says every reason since someone who
 * directs the crew last spoke, and whose it is now: an issue parked twice
 * is handed over, never dropped.
 */
function strikeNote(
  db: Database,
  repo: Repo,
  issue: Issue,
  reason: string,
  hint = "",
): string {
  const note = `${PARK_NOTE}${reason}`;
  const reasons = [...parkReasons(db, repo, issue.id), parkReason(note)];
  if (reasons.length < PARK_STRIKES)
    return hint === "" ? note : `${note} ${hint}`;
  return [
    note,
    "",
    `Parked ${reasons.length === 2 ? "twice" : `${reasons.length} times`} since a person last spoke here, so it is the planner's now. Every reason:`,
    "",
    ...reasons.map((r, n) => `${n + 1}. ${r}`),
    "",
    HANDED_OVER,
  ].join("\n");
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
  addComment(app, by, repo, issue, strikeNote(app.db, repo, issue, why));
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
  const done = alreadyDoneOids(run.summary);
  if (run.state === "ok" && done.length > 0)
    return noteAlreadyDone(app, repo, issue, done);
  return parkIssue(
    app,
    repo,
    issue,
    `the run ended without a pull: ${run.summary || run.state}`,
  );
}

/**
 * A run found its issue done on the base, by commits that are there
 * (`already.ts`): one note on the issue with the commits, the assignee
 * cleared, and no park — it is no strike and never reaches the planner as
 * parked twice. Closing it is the asker's. Said once per run.
 */
function noteAlreadyDone(
  app: App,
  repo: Repo,
  issue: Issue,
  oids: readonly string[],
): boolean {
  if (repo.autonomyBy === null) return false;
  const by = getUserById(app.db, repo.autonomyBy);
  if (!by) return false;
  if (issue.assigneeId !== null) assignIssue(app, by, repo, issue, null);
  addComment(app, by, repo, issue, `${ALREADY_NOTE}${oids.join(" ")}`);
  log.info("already done", {
    repo: `${repo.ownerName}/${repo.name}`,
    issue: issue.number,
    commits: oids.length,
  });
  return true;
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
 * handed to the planner with every reason (`strikeNote`). A pull a person
 * holds is not parked: closing it would hand its issue back to the crew, to
 * build the same change again beside the one that was told to wait.
 */
export function parkPull(
  app: App,
  repo: Repo,
  pull: Pull,
  why: string,
): boolean {
  if (repo.autonomy !== "autonomous" || repo.autonomyBy === null) return false;
  if (getHold(app.db, pull.id) !== undefined) return false;
  const by = getUserById(app.db, repo.autonomyBy);
  if (!by) return false;
  const issue = getIssueById(app.db, pull.id);
  if (!issue || issue.state !== "open") return false;
  addComment(app, by, repo, issue, `${PARK_NOTE}${why}`);
  const closed = setIssueState(app, by, repo, issue, "closed", {
    reason: "parked",
  });
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
      strikeNote(
        app.db,
        repo,
        about,
        `${why} (pull #${pull.number} closed).`,
        PLANNER_HINT,
      ),
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
  for (const pull of listPulls(app.db, repo.id, { sealed: true, state: "open", limit: 50 }))
    if (await landIfGreen(app, repo, pull)) landed++;
  return landed;
}

/** The sweep each repository has in flight, by repository id. */
const sweeping = new Map<string, Promise<number>>();

/**
 * Starts the green sweep beside the tick, never in front of it: a landing
 * gate takes minutes, and builders are picked meanwhile (#2015). One sweep
 * per repository is in flight — a tick that finds one running returns it
 * rather than start a second. Never rejects; a failure is logged.
 */
export function startSweep(
  app: App,
  repo: Repo,
  sweep: (app: App, repo: Repo) => Promise<number> = sweepGreen,
): Promise<number> {
  const running = sweeping.get(repo.id);
  if (running) return running;
  const started = sweep(app, repo)
    .catch((error) => {
      log.error("green sweep failed", {
        repo: `${repo.ownerName}/${repo.name}`,
        error: String(error),
      });
      return 0;
    })
    .finally(() => sweeping.delete(repo.id));
  sweeping.set(repo.id, started);
  return started;
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
export async function autonomyTick(
  app: App,
  now = new Date(),
  sweep: (app: App, repo: Repo) => Promise<number> = sweepGreen,
): Promise<void> {
  if (crewOffInPreview()) return;
  for (const repo of listAutonomousRepos(app.db)) {
    try {
      void startSweep(app, repo, sweep);
      // Quick, and before the picks: a pull main moved under is brought up
      // to date within this tick, not after a landing gate (#2039).
      await sweepConflicts(app, repo).catch((error) =>
        log.error("conflict sweep failed", {
          repo: `${repo.ownerName}/${repo.name}`,
          error: String(error),
        }),
      );
      const current = getRepoById(app.db, repo.id) ?? repo;
      const did = await driveRepo(app, current, now);
      // Every tick says what it did and why, so an app that sits still is
      // never a mystery: the numbers behind "idle" are on the line.
      const status = autonomyStatus(app, current, now);
      const graph = repoGraph(app.db, current.id, { sealed: true });
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
  // Every thought is placed within minutes (`crew/triage.ts`).
  try {
    await triageTick(app, now);
  } catch (error) {
    log.error("triage failed", { error: String(error) });
  }
  // The forge hunts its own faults on the same clock (`crew/sentinel.ts`).
  try {
    sentinelTick(app, now.getTime());
  } catch (error) {
    log.error("sentinel failed", { error: String(error) });
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
  ).map((issue, n) =>
    // A sealed report's words never leave the forge for a decider
    // (`core/sealed.ts`): it is a number, and that it is sealed.
    issue.sealed
      ? { number: issue.number, sealed: true, holdsUp: few[n]!.holdsUp }
      : {
          number: issue.number,
          title: issue.title,
          body: issue.body.slice(0, 400),
          holdsUp: few[n]!.holdsUp,
          ...(issue.untrusted === undefined
            ? {}
            : { untrusted: issue.untrusted }),
        },
  );
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
      `#${r.issue.number} ${r.issue.sealed ? "(sealed)" : r.issue.title}` +
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

/** Pull id → the tips git last read, and the files in conflict (null: clean). */
const checked = new Map<
  string,
  { head: string; key: string; files: string[] | null }
>();
/** Pull id → when the sweep last saw it merge cleanly. */
const cleanAt = new Map<string, string>();

/**
 * Where this conflict began counting: a person's last word, or the last
 * time the pull was seen clean. After a restart nothing is remembered, so a
 * run that ended well is taken as the end of the episode before it. A
 * finished run in the episode that left the pull conflicted is a failed
 * attempt, whatever state it ended in.
 */
function conflictEpisodeStart(app: App, issue: Issue, pullId: string): string {
  const agent = agentFor(app, issue);
  let start = agent ? lastHumanWord(app, issue, agent) : issue.createdAt;
  const clean = cleanAt.get(pullId);
  if (clean !== undefined) {
    if (clean > start) start = clean;
  } else {
    const ended = app.db
      .query<{ at: string | null }, [string]>(
        `SELECT MAX(finished_at) AS at FROM run
          WHERE kind = 'agent' AND reason = 'conflict' AND issue_id = ?1 AND state = 'ok'`,
      )
      .get(pullId)?.at;
    if (ended != null && ended > start) start = ended;
  }
  return start;
}

/** How long a conflicted pull may wait to be brought up to date. */
const CONFLICT_LIMIT_MS = 24 * 3_600_000;

/**
 * Close a pull the crew could not bring up to date, and put its issues back
 * on the map unassigned with the conflict named. Unlike `parkPull` it is
 * main that moved, not the builder that failed: the note is not a park, so
 * it is never a strike against the issue or the builder.
 */
export function releaseConflicted(
  app: App,
  repo: Repo,
  pull: Pull,
  why: string,
  files: readonly string[],
): boolean {
  if (repo.autonomy !== "autonomous" || repo.autonomyBy === null) return false;
  if (getHold(app.db, pull.id) !== undefined) return false;
  const by = getUserById(app.db, repo.autonomyBy);
  const issue = getIssueById(app.db, pull.id);
  if (!by || !issue || issue.state !== "open") return false;
  const named = files.length > 0 ? ` Conflicting files: ${files.join(", ")}.` : "";
  addComment(app, by, repo, issue, `Closed by the crew: ${why}.${named}`);
  const closed = setIssueState(app, by, repo, issue, "closed", {
    reason: "parked",
  });
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
      `Ready again: pull #${pull.number} was closed because main moved under it and it could not be brought up to date.${named}`,
    );
  }
  log.info("conflicted pull released", {
    repo: `${repo.ownerName}/${repo.name}`,
    pull: pull.number,
    why,
  });
  return true;
}

/**
 * Every tick, each open crew pull that no longer merges gets a
 * bring-up-to-date run (one in flight per pull). After two finished
 * attempts, or 24 h since the first, it is closed and its issue is ready
 * again. Returns how many pulls were acted on.
 */
export async function sweepConflicts(app: App, repo: Repo): Promise<number> {
  if (repo.autonomy !== "autonomous") return 0;
  let acted = 0;
  // Forget pulls that are no longer open: closed, merged or released.
  for (const id of new Set([...checked.keys(), ...cleanAt.keys()]))
    if (getIssueById(app.db, id)?.state !== "open") {
      checked.delete(id);
      cleanAt.delete(id);
    }
  for (const pull of listPulls(app.db, repo.id, { sealed: true, state: "open", limit: 50 })) {
    if (!pull.authorIsAgent || pull.mergedAt !== null) continue;
    if (getHold(app.db, pull.id) !== undefined) continue;
    const dir = await pullDir(app.db, app.reposRoot, repo, pull);
    const baseTip = await resolveOid(dir, `refs/heads/${pull.baseBranch}`);
    if (baseTip === undefined) continue;
    // Git is asked once per pair of tips; until one moves, the answer stands.
    const key = `${pull.headOid}:${baseTip}`;
    let seen = checked.get(pull.id);
    // The head moved since the last read: the builder pushed (or a person
    // did), so what was tried before belongs to an earlier episode.
    if (seen !== undefined && seen.head !== pull.headOid)
      cleanAt.set(pull.id, new Date().toISOString());
    if (seen?.key !== key) {
      const reading = await mergeable(dir, baseTip, pull.headOid);
      seen = {
        head: pull.headOid,
        key,
        files: reading.ok
          ? null
          : reading.error.kind === "conflict"
            ? reading.error.files
            : null,
      };
      checked.set(pull.id, seen);
    }
    if (seen.files === null) {
      // Merges cleanly: whatever came before was a different episode.
      cleanAt.set(pull.id, new Date().toISOString());
      continue;
    }
    const files = seen.files;
    const issue = getIssueById(app.db, pull.id);
    if (!issue || issue.state !== "open") continue;
    if (activeRunFor(app.db, "agent", issue.id) !== undefined) continue;
    const since = conflictEpisodeStart(app, issue, pull.id);
    const runs = app.db
      .query<{ n: number; first: string | null }, [string, string]>(
        `SELECT COUNT(*) AS n, MIN(created_at) AS first FROM run
          WHERE kind = 'agent' AND reason = 'conflict' AND issue_id = ?1
            AND created_at > ?2 AND state IN ('ok','failed')`,
      )
      .get(pull.id, since);
    const aged =
      runs?.first != null &&
      Date.now() - Date.parse(runs.first) >= CONFLICT_LIMIT_MS;
    if ((runs?.n ?? 0) >= CHECK_FAILED_LIMIT || aged) {
      const why = aged
        ? "main moved under it and the branch was not brought up to date within 24 hours"
        : `main moved under it and ${runs?.n} attempts to bring the branch up to date failed`;
      if (releaseConflicted(app, repo, pull, why, files)) {
        acted++;
        checked.delete(pull.id);
        cleanAt.delete(pull.id);
      }
      continue;
    }
    if (bringUpToDate(app, repo, pull, files, since) !== undefined) acted++;
  }
  return acted;
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
  episodeStart = "",
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
    episodeStart > lastHumanWord(app, issue, agent)
      ? episodeStart
      : lastHumanWord(app, issue, agent),
  );
  if (tries >= CHECK_FAILED_LIMIT) {
    // Autonomous: closed, never waiting. Assisted: the person's word.
    releaseConflicted(
      app,
      repo,
      pull,
      `main moved under it ${tries} times and the branch could not be brought up to date`,
      files,
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
 * Whether the review gate lets this green head land: `pass` with an
 * approval on this head and no change requested; `hold` while the review
 * is out or changes are asked for. An agent's pull is held until approved
 * — with no reviewer, or after one lapsed, a person's review is what it
 * waits for (#597). A person's own pull passes with no reviewer on the
 * crew, and is `lapsed` when the reviewer was asked twice and never
 * answered: it lands without it, and says so (`crew/review.ts`).
 */
async function reviewed(
  app: App,
  repo: Repo,
  pull: Pull,
): Promise<"pass" | "hold" | "lapsed"> {
  const seen = reviewSummary(app.db, pull.id, pull.headOid);
  if (seen.changesRequested > 0) return "hold";
  if (seen.approvals > 0) return "pass";
  // An agent's pull ships only on an approving review — the crew's reviewer
  // or a person's. With no reviewer, or a review that lapsed, it waits for
  // a person (`waitsForPerson` puts it where a person looks); never by lapse.
  if (pull.authorIsAgent) {
    if (reviewersOf(app.db, repo.id).length > 0) await sendToReview(app, repo, pull);
    return "hold";
  }
  // A person's own pull is not held for a review that never comes.
  if (reviewersOf(app.db, repo.id).length === 0) return "pass";
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
  // The caller's copy may predate a landing: the row says whether it is
  // still open (#2017).
  const row = getPull(app.db, repo.id, pull.number);
  if (row === undefined || row.state !== "open" || row.mergedAt !== null)
    return false;
  // A person said "not this one yet": nothing below happens until it is
  // released — no landing, no review sent, no run to bring the branch up
  // to date (`core/holds.ts`).
  if (getHold(app.db, pull.id) !== undefined) return false;
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
  // Asked where the pull's objects are: a sealed one's own place (`pullDir`).
  const dir = await pullDir(app.db, app.reposRoot, repo, pull);
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
    // Nothing the base does not already hold: no gate and no review, for
    // there is nothing to land. The merge closes the pull as merged into
    // the commit that carried it, and main does not move (#2017).
    if (clean.value.treeOid === (await treeOf(dir, baseTip))) {
      const closed = await mergePull(app, by, repo, pull, "squash");
      log.info("already on the base, not landed again", {
        repo: `${repo.ownerName}/${repo.name}`,
        pull: pull.number,
        closed: closed.ok,
      });
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
  // so it starts over. An agent's pull waits for that approval however
  // long it takes — with no reviewer, or after one lapsed, a person's
  // (#597). Only a person's own pull lands without a reviewer, or after a
  // review lapsed.
  const review = await reviewed(app, repo, pull);
  if (review === "hold") return false;
  // The full tier, once, on the merge with its base (#1198). Red is told to
  // the pull once per head and base, and the pull waits for a push.
  const red = latestDecision(app.db, pull.id, "land");
  const gatedAt = `${pull.headOid}:${baseTip}`;
  if (
    red?.answer === "red" &&
    typeof red.state === "object" &&
    red.state !== null &&
    (red.state as { at?: unknown }).at === gatedAt
  )
    return false;
  const verdict = await gateOnLand(app, repo, pull, dir, baseTip);
  if (!verdict.lands) {
    recordDecision(app.db, {
      kind: "land",
      repoId: repo.id,
      issueId: pull.id,
      state: { head: pull.headOid, at: gatedAt },
      answer: "red",
      p: 1,
      by: "rule",
      ms: 0,
    });
    addComment(app, by, repo, getIssueById(app.db, pull.id) ?? pull, verdict.comment);
    return false;
  }
  // The gate took minutes: the pull it was run on must still be the one
  // here — open, unmerged, at the same head — or another landing, or a
  // push, came first and this verdict is about nothing.
  const still = getPull(app.db, repo.id, pull.number);
  if (
    still === undefined ||
    still.state !== "open" ||
    still.mergedAt !== null ||
    still.headOid !== pull.headOid
  )
    return false;
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
  // Closed as merged into what already carried it: main did not move, so
  // there is no release to cut and nothing new was landed.
  if (merged.value.carried) return false;
  resolveOpen(app.db, pull.id, "land", "shipped");
  // On the forge's own code, the landed tree is checked out and preflighted
  // off to the side; the landing does not wait on it (#1662).
  void releaseOnLand(app, by, repo, pull, merged.value.mergeOid).catch((error) =>
    log.warn("release checkout failed", {
      pull: pull.number,
      why: error instanceof Error ? error.message : String(error),
    }),
  );
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
