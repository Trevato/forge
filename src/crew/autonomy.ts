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

import { noteRed, treatRed } from "../checks/doctor.ts";
import { tickBets } from "../actions/bets.ts";
import { betsInUse } from "../core/bets.ts";
import { onlyListDocs, resolveListConflicts } from "../actions/list-conflicts.ts";
import { closedToday, closeStale } from "./stale_pulls.ts";
import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { ceilingReached, forgeCeiling } from "../flow/ceiling.ts";
import {
  addComment,
  assignIssue,
  openIssue,
  setIssueState,
} from "../actions/issues.ts";
import type { AccessError } from "../actions/access.ts";
import { adoptGate, gateCandidate, releaseOnLand } from "../checks/landing.ts";
import { queueStore } from "../checks/queue_store.ts";
import { addLearned } from "../checks/learned.ts";
import { batchWords, dropFromLine, enqueue, type GateCandidate, type Queued, type QueueOptions, queueClashes, queueWords, waitingPulls } from "../checks/queue.ts";
import { checksFor } from "../checks/service.ts";
import { queueBatch, queueDepth } from "../core/capacity.ts";
import { crewFor as crewForIssue, passedWords, pickFilter, routable } from "./pick_filter.ts";
import { readConflictLane, readConflictRoom } from "./conflict_room.ts";
import { mergeable, resolveOid, treeOf } from "../git/merge.ts";
import { CLOSED_NOTE, leftNote, reopenedByPerson, unticked } from "../core/done_on_main.ts";
import { mergePull } from "../actions/pulls.ts";
import { carriesUpstream } from "../actions/upstream_follow.ts";
import { sourceHeld } from "./source_held.ts";
import {
  listCrewRoles,
  type Agent,
  type CrewRole,
  crewRole,
} from "../core/agents.ts";
import { pickBuilder, routeIssue } from "./route.ts";
import { fromAppIssues } from "../core/from_app.ts";
import { pickOrder } from "../core/next_up.ts";
import { ranksInRepo } from "../core/rank.ts";
import { ensurePlanner } from "./planner.ts";
import { readyNow, repoGraph, type Ranked } from "../core/dependencies.ts";
import {
  type Decision,
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
import { liveTriage, none as noTriage, tickFields } from "./livetriage.ts";
import { wallOf, wallPlain, wallSentence } from "../contract/policy.ts";
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
  listOpenPulls,
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
import { heldByGateAlone, releaseFromGate } from "./release_later.ts";
import { staggeredUntil } from "./ceiling_stagger.ts";
import { crewWeekFor, weekFor, weekScope } from "./week_read.ts";
import { announceGovernor, governorFor } from "./governed.ts";
import { BREAKER_NOTE, breakerTripped } from "./breaker.ts";
import { REPEAT_NOTE } from "./repeat_note.ts";
import { given, pendingReplans } from "../core/limb_replan.ts";
import { handedOverPulls, SKIP_SUMMARY, skipsReplan } from "./guard.ts";
import { atRunCap, type Held, heldBy, heldWords, replannable } from "./held.ts";
import { holdHot, hotFiles, hotWords, learnPullFiles } from "./hot_files.ts";
import { landedUnder, NO_PULL, stallReason, unstickOwed } from "./stalls.ts";
import { alreadyDone, BY_CREW, DONE_LIKE } from "../core/done_on_main.ts";
import { repoDir } from "../git/repos.ts";
import { ALREADY_NOTE, alreadyDoneOids } from "./already.ts";
import { removedBy, retiredNames } from "./retired.ts";
import { interruptionOf } from "./interrupted.ts";
import {
  parkedCount as countParks,
  parkedTwice,
} from "./parks.ts";
import { due, reserveOf, reserveWords } from "./reserve.ts";
import { createLog } from "../kernel/log.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import {
  directorsAmong,
  landsOnItsOwn,
  markReaders,
} from "./direct.ts";
import { foldsIn, needsCrewReview } from "../core/trusted_sources.ts";
import { foldWall } from "./fold_walls.ts";
import { guardedList } from "./stranger.ts";
import { warnExpiring } from "./fold_in.ts";
import { crewOffInPreview } from "./preview.ts";
import { approvedOnHead, finishApproved, finishFields } from "./finishing.ts";
import { recheckRedApproved } from "./red_approved.ts";
import { sweepStaleReds } from "./stale_reds.ts";
import { sweepStranded } from "./stranded.ts";
import { parkPull, parkPullTold, strikeNote } from "./park_pull.ts";
import { keepVerdict } from "../flow/culprits.ts";
import { sweepRepeats } from "./repeat_checks.ts";
import { breathe } from "../kernel/breathe.ts";
import { keepBatch } from "../flow/red_batches.ts";
import { recordQueueFlakes } from "../checks/flake.ts";
import { readVitals, vitalsMisses, vitalsWords } from "../flow/vitals.ts";
import { moveRequested, tallyRequested, tallyWords } from "./requested.ts";
import { passLanded } from "./box_pass.ts";
import { reviewersForRepos, reviewsOff, sendToReview, sweepReviews } from "./review.ts";
import { lastWaits, noteWaits, tallyWaits, type Wait, waitWords } from "./waits.ts";
import { bootCounts } from "../kernel/boots.ts";

const log = createLog("autonomy");

export { parkPull, parkPullTold };

export const AUTONOMY_TICK_MS = 60_000;
/**
 * How soon a planner whose last pass did not end well — a decline a person
 * answered, a failure — is asked again. A pass that ended well has no
 * floor: while the reserve is short the planner is asked again as soon as
 * the map moves, and a pass that moved nothing is held by `skipsReplan`.
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

/**
 * The builders with nothing in flight here. One agent runs one thing at a
 * time, so `active` on the tick line climbs to at most
 * min(slots, startable, idle builders + active) (#7006).
 */
export function idleBuilders(
  active: readonly Run[],
  crew: readonly { readonly agent: Agent; readonly role: CrewRole }[],
): number {
  const busy = new Set(active.map((r) => r.actorId));
  return crew.filter((c) => c.role === "builder" && !busy.has(c.agent.user.id)).length;
}

export function autonomyStatus(
  app: App,
  repo: Repo,
  now = new Date(),
): AutonomyStatus {
  const spent = spentToday(app.db, repo.id, now);
  const crew = listCrewRoles(app.db, repo.id);
  const forgeCap = forgeCeiling(app.config);
  const paused: Paused | null =
    repo.autonomy === "off"
      ? null
      : repo.autonomyBy === null
        ? "nobody"
        : crew.length === 0
          ? "no crew"
          : spent >= repo.autonomyCeilingUsd
            ? "ceiling"
            : ceilingReached(spentTodayEverywhere(app.db, now), forgeCap)
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

/** The issues each repository picked in this tick, by repository id: their runs may not show yet. */
export type TickPicks = ReadonlyMap<string, ReadonlySet<string>>;

/** The crew's pace here: the operator's slots, held to what the windows have left and to the governor's. */
export function repoPace(app: App, repo: Repo, now = new Date(), crew = true, picked: TickPicks = new Map()): Pace {
  const accounts = grantedAccounts(app.db, repo.id, repo.ownerId).flatMap(
    (a) => {
      const s = standing(app.db, a.id, now);
      return s === undefined ? [] : [{ name: a.name, standing: s }];
    },
  );
  const paced = pace(accounts, repo.autonomySlots, meanRunUsd(app.db, repo.id), now);
  const governed = governorFor(app, repo, now).slots;
  const limited = governed < paced.slots ? { ...paced, slots: governed } : paced;
  // Finishing and rework run ahead of new picks: only a new pick waits on the crew's week and the midnight spread.
  if (!crew) return limited;
  const until = staggeredUntil(app.db, repo, now);
  if (until !== null)
    return { ...limited, slots: 0, reason: `0 of ${repo.autonomySlots} slots until ${until.toISOString().slice(11, 16)} UTC: the daily ceilings reset together and each repository restarts at its own time` };
  // The week is one budget for the whole crew on these accounts, and the repository's own slots are limits inside it (#8989).
  const week = crewWeekFor(app, repo, now);
  if (week === null) return limited;
  const scope = weekScope(app, repo, now);
  let others = 0;
  for (const other of listAutonomousRepos(app.db)) {
    if (other.id === repo.id || other.autonomy !== "autonomous" || other.archivedAt !== null) continue;
    if (weekScope(app, other, now) !== scope) continue;
    const active = activeRuns(app, other.id);
    others += slottedRuns(active, listCrewRoles(app.db, other.id)).length;
    // Picked earlier in this tick and not yet running: a slot of the crew's week already spent.
    const running = new Set(active.map((r) => r.issueId));
    others += [...(picked.get(other.id) ?? [])].filter((id) => !running.has(id)).length;
  }
  const here = Math.max(0, week.slots - others);
  return here < limited.slots
    ? { ...limited, slots: here, reason: `${here} of ${repo.autonomySlots} slots: the whole crew has ${week.slots} for the week, ${others} running elsewhere. ${week.sentence}` }
    : limited;
}

/**
 * Behind the week's pace with builders idle and nothing startable, the next
 * gated issue (the lowest number the Later gate alone holds) is released:
 * one per look, each logged and noted on the issue with why (#8695).
 */
function releaseForPace(app: App, repo: Repo, by: User, slotted: number, startable: number, now: Date): number | undefined {
  const gated = heldByGateAlone(app.db, repo.id);
  const week = weekFor(app, repo, now, { idleSlots: Math.max(0, repo.autonomySlots - slotted), startable, gated: gated.length });
  const next = gated[0];
  if (week === null || !week.release || next === undefined) return undefined;
  const [number] = releaseFromGate(app.db, repo.id, [next.number], by.id);
  if (number === undefined) return undefined;
  const why = `Released from Later to use the week's subscription: ${week.sentence}`;
  log.info("released", { repo: `${repo.ownerName}/${repo.name}`, issue: number, why });
  const issue = getIssueById(app.db, next.id);
  if (issue !== undefined) addComment(app, by, repo, issue, why);
  return number;
}

/** The builder slots free now: none while paused, else the paced slots less what is slotted. */
function freeSlots(app: App, repo: Repo, now: Date): number {
  if (autonomyStatus(app, repo, now).paused !== null) return 0;
  const slotted = slottedRuns(activeRuns(app, repo.id), listCrewRoles(app.db, repo.id));
  return Math.max(0, repoPace(app, repo, now, false).slots - slotted.length);
}

/** The pickable issues in slot order: the order Next up shows. */
export function inSlotOrder(app: App, repo: Repo, ready: readonly Ranked[], now: Date = new Date()): Ranked[] {
  const ranked = ranksInRepo(app.db, repo.id);
  const { allowed } = pickFilter(app, repo, ready, now);
  // The order is the one Next up shows (#8826): ranked by place, then the ready order.
  return pickOrder(allowed, ranked, (r) => r.issue.id, [], fromAppIssues(app.db, allowed.map((r) => r.issue.id)));
}

export type Drove = "off" | "paused" | "waiting" | "full" | "picked" | "planned" | "released" | "idle";

/**
 * One turn of the loop for one repository. Returns what it did, for the
 * log and for tests; the effects are an assignment (which the crew turns
 * into a run) or a planner given the direction.
 */
export async function driveRepo(
  app: App,
  repo: Repo,
  now = new Date(),
  picked: Map<string, Set<string>> = new Map(),
): Promise<Drove> {
  // One start per free builder slot (#8729). Each pass re-reads the ceiling,
  // the paced slots and the held filters, so a start the dispatcher refused
  // or a spend that reached the wall ends the tick's starts there.
  // An issue picked this tick may not have its run yet: it is kept out of the
  // next pass and counted against the slots until the run shows.
  const taken = new Set<string>();
  picked.set(repo.id, taken);
  const did = await driveOnce(app, repo, now, taken, picked);
  if (did !== "picked") return did;
  for (let n = 1; n < Math.max(1, repo.autonomySlots); n++) {
    const next = await driveOnce(app, getRepoById(app.db, repo.id) ?? repo, now, taken, picked);
    if (next !== "picked") break;
  }
  return did;
}

async function driveOnce(
  app: App,
  repo: Repo,
  now: Date,
  taken: Set<string>,
  picked: TickPicks,
): Promise<Drove> {
  if (repo.autonomy === "off") return "off";
  tickBets(app, repo, now);
  const status = autonomyStatus(app, repo, now);
  if (status.paused !== null) return "paused";
  const by = getUserById(app.db, repo.autonomyBy!);
  if (!by) return "paused";
  const crew = listCrewRoles(app.db, repo.id);
  const active = activeRuns(app, repo.id);
  const slotted = slottedRuns(active, crew);
  // Picked earlier in this tick and not yet running: still a slot spent.
  const running = new Set(active.map((r) => r.issueId));
  const pending = [...taken].filter((id) => !running.has(id)).length;
  // Slots follow the subscriptions' remaining windows, never past the
  // operator's; at a wall nothing new starts until the reset.
  const paced = repoPace(app, repo, now, true, picked);
  if (paced.slots === 0 && slotted.length === 0) return "waiting";
  // The files the open pulls touch, read before the sort: a build that
  // names a hot one waits for its pile to drain (#5934).
  await learnPullFiles(app, repo).catch((error) =>
    log.warn("could not read the open pulls' files", {
      repo: `${repo.ownerName}/${repo.name}`,
      error: String(error),
    }),
  );
  const sorted = () => heldBy(app, repo, readyNow(repoGraph(app.db, repo.id, { sealed: true })), crew, active);
  let held = sorted();
  if (freeParked(app, repo, by, held) > 0) held = sorted();
  // An issue a landing left open with boxes is given the reviewer's pass once (#8682).
  await passLanded(app, repo, held.by.landed);
  holdHot(
    repo.id,
    held.by.hot_file,
    now,
    new Map(
      [...held.pinned].map(([n, h]) => [n, { path: h.path, byName: getUserById(app.db, h.by)?.username ?? "someone" }]),
    ),
    held.relieving,
  );
  const ready = held.startable.filter((r) => !taken.has(r.issue.id));
  const used = slotted.length + pending;
  if (used < paced.slots && releaseForPace(app, repo, by, used, ready.length, now) !== undefined)
    return "released";
  if (used >= paced.slots) {
    // The builders are busy; the planner can still refill the map, when
    // the reserve is short — counted, never assumed: a full crew with a
    // full reserve is not a reason to plan (#1097, #3237).
    if (await planIfThin(app, repo, by, crew, active, ready.length, now))
      return "planned";
    return "full";
  }

  const inFlight = new Map<string, number>();
  for (const r of active)
    if (r.actorId !== null)
      inFlight.set(r.actorId, (inFlight.get(r.actorId) ?? 0) + 1);
  // A builder that stalled an issue within the hour leaves it to the
  // others; one no builder may take now is skipped, not waited on (#4073).
  const crewFor = (issue: Issue) => crewForIssue(app, repo, issue.id, crew, now);
  const pickable = await withoutRetired(app, repo, routable(app, repo, ready, crew, now).kept);
  // The roadmap first, and small issues held to their share of the slots (#7571).
  const next = await nextOf(app, repo, inSlotOrder(app, repo, pickable, now));
  if (next !== undefined) {
    taken.add(next.issue.id);
    const routed = await routeIssue(app, repo, next.issue, crewFor(next.issue), inFlight);
    if (!routed) return "paused";
    const builder = routed.builder;
    // Assigning is the event that starts a run. An issue already carrying
    // the builder's name is assigned afresh so the event fires once more.
    if (next.issue.assigneeId === builder.user.id) {
      const cleared = assignIssue(app, by, repo, next.issue, null);
      if (!cleared.ok) return "idle";
    }
    const current = getIssueById(app.db, next.issue.id) ?? next.issue;
    const assigned = assignIssue(app, by, repo, current, builder.user, undefined, true);
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
    // Planning runs alongside building: when the reserve is short, the
    // planner is asked now, not when the builders have run it dry.
    await planIfThin(app, repo, by, crew, active, ready.length - 1, now);
    return "picked";
  }

  // Nothing is startable with slots free: the planner is asked. When
  // ready issues are held by what re-planning lifts — stalled, capped,
  // parked twice — it is asked with that breakdown, and neither a full
  // plate nor its own unanswered decline holds it: nothing else will move them (#2244).
  const stuck = replannable(held).length > 0 ? held : null;
  if (await planIfThin(app, repo, by, crew, active, 0, now, stuck)) return "planned";
  return "idle";
}

/**
 * A ready issue assigned to a planner or a reviewer with no run on it is
 * parked on a crew member that never builds it — a sentinel's finding, a
 * planner's pass that ended (#3002). Its assignee is cleared so a builder
 * may start it this tick. Returns how many were freed.
 */
export function freeParked(app: App, repo: Repo, by: User, held: Held): number {
  let freed = 0;
  for (const issue of held.by.planner) {
    const cleared = assignIssue(app, by, repo, issue, null);
    if (!cleared.ok) {
      log.warn("could not free an issue parked on a non-builder", {
        repo: `${repo.ownerName}/${repo.name}`,
        issue: issue.number,
        error: cleared.error,
      });
      continue;
    }
    log.info("freed", { repo: `${repo.ownerName}/${repo.name}`, issue: issue.number });
    freed++;
  }
  return freed;
}

/**
 * A ready issue a builder ran on and left without a pull, nobody having
 * spoken since, is parked by the next tick rather than held for a person
 * (#4073): the note says whose run stalled it and the run's last summary,
 * the assignee is cleared, and any other builder may pick it. That note is
 * a strike (`parks.ts`), so a second stall hands it to the planner. A run
 * still in flight is not a stall yet. Returns how many were freed.
 */
export function freeStalled(app: App, repo: Repo, by: User, held: Held): number {
  let freed = 0;
  for (const issue of held.by.stalled) {
    const last = app.db
      .query<{ state: string; summary: string; actor: string | null }, [string]>(
        `SELECT state, summary, actor_id AS actor FROM run
          WHERE issue_id = ?1 AND kind = 'agent' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(issue.id);
    if (!last || last.state === "queued" || last.state === "running") continue;
    // A run its pull landed under left the work on the base: no park, no strike (#8481).
    if (landedUnder(last)) continue;
    const who = last.actor === null ? undefined : getUserById(app.db, last.actor)?.username;
    if (parkAs(app, by, repo, issue, stallReason(who, last.summary || last.state), "unstuck"))
      freed++;
  }
  return freed;
}

/**
 * The ready issues a builder may start now: not the direction, and held by
 * none of `held.ts`'s filters. The tick log counts these beside the raw
 * ready list, and the held ones per filter.
 */
export function startable(
  app: App,
  repo: Repo,
  ready: readonly Ranked[],
  crew: readonly { agent: Agent; role: CrewRole }[],
  active: readonly Run[],
): Ranked[] {
  return heldBy(app, repo, ready, crew, active).startable;
}

/**
 * Give the planner the direction when the reserve is due a pass — down to
 * half of two startable issues per builder slot (`reserve.ts`) — or when the crew has handed it an issue it parked twice,
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
  stuck: Held | null = null,
): Promise<boolean> {
  const handed = [...parkedTwice(app.db, [repo]), ...handedOverPulls(app.db, repo)];
  const limbs = pendingReplans(app.db, repo);
  const reserve = reserveOf(ready, repo.autonomySlots);
  if (!due(reserve) && handed.length === 0 && limbs.length === 0) return false;
  // Paused by its pillar's setting (#7668): the planner stays on the crew.
  if (repo.plannerSlots === 0) return notPlanned(repo, "the planner is paused");
  if (repo.autonomyDirection.trim() === "")
    return notPlanned(repo, "no direction written");
  // A direction with no planner would go nowhere; the forge lends one (#7637).
  const planner =
    crew.find((c) => c.role === "planner")?.agent ?? ensurePlanner(app, repo, by);
  if (planner === undefined) return notPlanned(repo, "no planner on the crew");
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
  // A limb a person handed over is owed one pass, whatever the map and
  // whatever the planner said of the direction before (#761).
  const limbsOwed = limbs.filter((r) => !given(app.db, repo, r.at));
  if (!due(reserve) && owed.length === 0 && limbsOwed.length === 0) return false;
  // Nothing startable for issues held since its last pass that re-planning
  // lifts: owed one pass like a hand-over, once (#2244).
  const unstuck = stuck === null ? [] : replannable(stuck).filter((issue) => heldSince(app, issue, seen));
  const news = owed.length + unstuck.length + limbsOwed.length;
  // The direction is the planner's standing issue, not one issue retried:
  // it is held to its own day's share, never the builders' cap (#2143).
  // Except for an issue struck out by a stall: unsticking is not planning (#4073).
  if (atRunCap(app, repo, direction) && !unstickOwed(app.db, repo, seen))
    return notPlanned(repo, "parked: the direction is at its day's planning cap");
  // An issue the crew handed over is owed its pass whatever the hold: the
  // planner splitting it is how work starts landing again.
  const hold = news === 0 ? plannerHold(app, repo, now) : null;
  if (hold !== null) return held(repo, holdWhy(hold));
  if (lastPlan !== null && lastPlan !== undefined) {
    // A planner that declined the direction is not asked again until a
    // person has said something on it, or the crew hands it an issue.
    if (
      news === 0 &&
      lastPlan.state === "failed" &&
      declinedUnanswered(app, repo, direction)
    )
      return notPlanned(repo, "the planner declined; waiting for a person");
    if (lastPlan.state === "queued" || lastPlan.state === "running")
      return notPlanned(repo, "a planning run is in flight");
    // Only a pass that did not end well waits out the floor; a person's
    // hand-over never does.
    if (
      limbsOwed.length === 0 &&
      lastPlan.state !== "ok" &&
      now.getTime() - new Date(lastPlan.created_at).getTime() <
        REPLAN_AFTER_MS
    )
      return notPlanned(repo, "planned recently");
    // Nobody spoke and the map has not moved since the last pass: another
    // would read its own summary and change nothing (#1097).
    if (
      news === 0 &&
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
    limbsOwed.length > 0
      ? "a limb was handed over; planner asked"
      : owed.length > 0
      ? "parked twice; planner asked"
      : unstuck.length > 0
        ? "nothing startable; planner asked"
        : ready === 0
          ? "map ran dry; planner asked"
          : "reserve is short; planner asked",
    {
      repo: `${repo.ownerName}/${repo.name}`,
      planner: planner.user.username,
      ready,
      reserve: reserveWords(reserve),
      ...(owed.length > 0
        ? { parkedTwice: owed.map((issue) => `#${issue.number}`).join(" ") }
        : {}),
      ...(stuck === null ? {} : { held: heldWords(stuck) }),
    },
  );
  return true;
}

/**
 * Whether `issue` came to be held after `since` — its newest builder run
 * ended then, which is what stalls or caps it — so a planning pass that
 * started before has not seen it.
 */
function heldSince(app: App, issue: Issue, since: string): boolean {
  const last = app.db
    .query<{ at: string | null }, [string]>(
      `SELECT MAX(COALESCE(finished_at, created_at)) AS at FROM run
        WHERE issue_id = ?1 AND kind = 'agent'`,
    )
    .get(issue.id)?.at;
  return typeof last === "string" && last > since;
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
  log.info(note === BREAKER_NOTE ? "parked by the breaker" : note === REPEAT_NOTE ? "parked by the repeat stop" : "parked at the run cap", {
    repo: `${repo.ownerName}/${repo.name}`,
    issue: issue.number,
  });
  return true;
}

/** How many times the crew has parked this issue since a person who directs it last spoke (`parks.ts`). */
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
  if (!by) return false;
  return parkAs(app, by, repo, issue, why, "parked");
}

/** Park `issue` in `by`'s name: the strike note, the assignee cleared, and `said` in the log. */
function parkAs(
  app: App,
  by: User,
  repo: Repo,
  issue: Issue,
  why: string,
  said: string,
): boolean {
  if (issue.state !== "open") return false;
  if (issue.assigneeId !== null) assignIssue(app, by, repo, issue, null);
  addComment(app, by, repo, issue, strikeNote(app.db, repo, issue, why));
  log.info(said, {
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
  const carried = alreadyDoneOids(run.summary);
  if (run.state === "ok" && carried.length > 0) {
    const asked = getIssueById(app.db, run.issueId);
    const own = asked?.kind === "pull" ? getPull(app.db, repo.id, asked.number) : undefined;
    if (own && own.mergedAt === null)
      return closeSuperseded(app, repo, own, carried);
  }
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
    `the ${NO_PULL}: ${run.summary || run.state}`,
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
 * Green pulls that have not landed — a check that passed before autonomy
 * was turned on, or one the event missed — land on the tick, so nothing
 * green waits on chance.
 */
export async function sweepGreen(app: App, repo: Repo, now: Date = new Date()): Promise<number> {
  if (repo.autonomy !== "autonomous") return 0;
  // Admitted one by one, queued together, oldest first: the green pulls of
  // one sweep are one candidate and one gate (#2036).
  const entries: Queued[] = [];
  // Why each approved pull waits, for the tick line (#3055).
  const waits: Wait[] = [];
  for (const pull of listOpenPulls(app.db, repo.id)) {
    const admitted = await admit(app, repo, pull, now);
    if (admitted.ok) entries.push(admitted.value);
    const seen = reviewSummary(app.db, pull.id, pull.headOid);
    if (seen.approvals > 0 && seen.changesRequested === 0)
      waits.push(admitted.ok ? "queued" : admitted.error);
  }
  noteWaits(repo.id, tallyWaits(waits));
  if (entries.length === 0) return 0;
  const landed = await enqueue(repo.id, entries, gateFor(app, repo), queueOptions(app, repo));
  return landed.filter(Boolean).length;
}

/**
 * Take out of the merge queue's line every waiting pull that would no
 * longer be admitted (#6611): held, closed or merged, pushed to since it
 * joined, no longer green on its head, or with changes requested on it.
 * Run on every tick, beside the sweep: a sweep in flight waits on its whole
 * line, so the line is cleared here, not there. Reads only rows: cheap.
 * How many were taken out.
 */
export function pruneLine(app: App, repo: Repo): number {
  const out = new Set<string>();
  for (const joined of waitingPulls(repo.id)) {
    const row = getPull(app.db, repo.id, joined.number);
    const stays =
      row !== undefined &&
      row.state === "open" &&
      row.mergedAt === null &&
      row.headOid === joined.headOid &&
      getHold(app.db, row.id) === undefined &&
      verdictForHead(app.db, row.id, row.headOid).every((c) => c.state === "ok") &&
      reviewSummary(app.db, row.id, row.headOid).changesRequested === 0;
    if (!stays) out.add(joined.id);
  }
  return out.size === 0 ? 0 : dropFromLine(repo.id, out);
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
export const DIRECTION_PREFIX = "Direction: ";
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

/**
 * Repositories with a backed bet go first, so a short week budget (#8989) is
 * spent on what the owner backed before the rest; the order is otherwise kept.
 */
export function byBackedBets(db: App["db"], repos: Repo[]): Repo[] {
  const backed = (r: Repo): number => (betsInUse(db, r.id) ? 0 : 1);
  return [...repos].sort((a, b) => backed(a) - backed(b));
}

/** Every repository that runs on its own, one turn each. */
export async function autonomyTick(
  app: App,
  now = new Date(),
  sweep: (app: App, repo: Repo) => Promise<number> = sweepGreen,
): Promise<void> {
  if (crewOffInPreview()) return;
  // A pull a person holds with changes requested goes back to its builder after a day of silence, in any repository.
  try {
    sweepStranded(app, now);
  } catch (error) {
    log.error("stranded sweep failed", { error: String(error) });
  }
  // Three days before a trusted source lapses, a note (#8937).
  try {
    warnExpiring(app, now);
  } catch (error) {
    log.error("trust note failed", { error: String(error) });
  }
  const picked = new Map<string, Set<string>>();
  for (const repo of byBackedBets(app.db, listAutonomousRepos(app.db))) {
    // An archived repository is put away: the crew starts nothing in it.
    if (repo.archivedAt !== null) continue;
    try {
      // A hold, a close, a push or a lost approval leaves the line before
      // the next batch is formed, not at its gate (#6611).
      pruneLine(app, repo);
      void startSweep(app, repo, sweep);
      // Each pass below is one slice of the thread: a request waiting is served between them (#8848).
      await breathe();
      // First of all: a slot freed goes to an approved pull that no longer
      // merges, before a changes-requested one or a new issue (#3682).
      const finishing = await finishApproved(app, repo, freeSlots(app, repo, now));
      await breathe();
      // An approved pull red for a day gets one re-check, then goes back (#6349).
      await recheckRedApproved(app, repo, now).catch((error) =>
        log.error("red approved re-check failed", {
          repo: `${repo.ownerName}/${repo.name}`,
          error: String(error),
        }),
      );
      await breathe();
      // Quick, and before the picks: a pull main moved under is brought up
      // to date within this tick, not after a landing gate (#2039).
      await sweepConflicts(app, repo).catch((error) =>
        log.error("conflict sweep failed", {
          repo: `${repo.ownerName}/${repo.name}`,
          error: String(error),
        }),
      );
      const current = getRepoById(app.db, repo.id) ?? repo;
      await breathe();
      // A red pull nobody is working is checked again, reworked, parked or closed (#8245).
      await sweepStaleReds(app, current, now, freeSlots(app, current, now)).catch((error) => {
        log.error("stale red sweep failed", {
          repo: `${repo.ownerName}/${repo.name}`,
          error: String(error),
        });
      });
      // What reviewers keep asking for becomes an issue to automate it (#8716).
      try {
        await sweepRepeats(app, current, now);
      } catch (error) {
        log.error("repeat check sweep failed", { repo: `${repo.ownerName}/${repo.name}`, error: String(error) });
      }
      await breathe();
      // Before the picks: a pull a reviewer answered is finished before new
      // work takes the slots it needs (#2172).
      const requested = await moveRequested(app, current, freeSlots(app, current, now), now);
      await breathe();
      const unstuck = unstickNow(app, current, now);
      const did = await driveRepo(app, current, now, picked);
      await breathe();
      // Rules only, no run: an issue noted already done on the base closes.
      const triaged = await liveTriage(app, current, now).catch((error) => {
        log.error("live triage failed", {
          repo: `${repo.ownerName}/${repo.name}`,
          error: String(error),
        });
        return noTriage();
      });
      await breathe();
      // Every tick says what it did and why, so an app that sits still is
      // never a mystery: the numbers behind "idle" are on the line.
      const status = autonomyStatus(app, current, now);
      await breathe();
      const approved = waitWords(lastWaits(current.id));
      const ready = readyNow(repoGraph(app.db, current.id, { sealed: true }));
      const crewNow = listCrewRoles(app.db, current.id);
      const activeNow = activeRuns(app, current.id);
      await breathe();
      const held = heldBy(app, current, ready, crewNow, activeNow);
      const boots = bootCounts(app.config.dataDir);
      await breathe();
      await breathe();
      const staleToday = closedToday(app, current.id, now);
      // Says when the governor lowers the slots (#6375); one feed item per change.
      const governor = announceGovernor(app, current, now);
      log.info("tick", {
        repo: `${repo.ownerName}/${repo.name}`,
        did,
        ...tickFields(triaged),
        ready: ready.length,
        // What the builders could start after the filters (#2143), and
        // what holds the rest, per filter (#2244).
        startable: held.startable.length,
        // The standing reserve the planner keeps: startable/target (#3237).
        reserve: reserveWords(reserveOf(held.startable.length, status.slots)),
        held: heldWords(held),
        // What the picker passes over among the startable, so no ready issue goes unexplained (#8924).
        passed: passedWords(pickFilter(app, current, held.startable, now).passed),
        // The files 5 or more open pulls touch, which no new build starts on (#5934).
        ...(held.by.hot_file.length === 0 ? {} : { hot: hotWords(hotFiles(current.id)) }),
        // Stalled issues this tick parked and freed for another builder (#4073).
        unstuck,
        // Crew pulls closed today after 3 days in conflict (#5940).
        ...(staleToday === 0 ? {} : { staleClosed: staleToday }),
        // Open pulls, opened/landed per hour and per 6 h, conflicted (#5935).
        ...flowVitals(app.db, now),
        active: status.active,
        slots: status.slots,
        // Builders with nothing in flight: what bounds active beside slots and startable (#7006).
        idle: idleBuilders(activeNow, crewNow),
        ...(governor === undefined ? {} : { governor }),
        // Approved conflicted pulls: queued, in flight, and why each other is
        // skipped (#3682, #6237), or "0 candidates of N open" (#6263); and the lane for rebases: conflicted N,
        // rebasing M, room R (#6140).
        ...finishFields(finishing.moves, readConflictLane(app.db), finishing.open),
        ...(requested.length === 0
          ? {}
          : {
              requested: tallyWords(tallyRequested(requested)),
            }),
        // The approved pulls the last green sweep saw, and why each waits (#3055).
        ...(approved === undefined ? {} : { approved }),
        // What the merge queue is doing now, not what the sweep admitted (#3430).
        queue: queueWords(current.id),
        // The size of the next batch: `8`, or `4 of 16` after a red (#6674).
        batch: batchWords(current.id, queueBatch(app.db)),
        // Pulls the queue found red on top of others of their candidate (#4235).
        clashes: queueClashes(current.id),
        spent: `${status.spentTodayUsd.toFixed(2)}/${status.ceilingUsd}`,
        ...(status.paused === null ? {} : { paused: status.paused }),
        // Starts after the first, and how many followed a crash (#3708).
        restarts: boots.restarts,
        ...(boots.unclean === 0 ? {} : { unclean: boots.unclean }),
      });
    } catch (error) {
      log.error("autonomy tick failed", {
        repo: `${repo.ownerName}/${repo.name}`,
        error: String(error),
      });
    }
  }
  await breathe();
  // Every thought is placed within minutes (`crew/triage.ts`).
  try {
    await triageTick(app, now);
  } catch (error) {
    log.error("triage failed", { error: String(error) });
  }
  await breathe();
  // The forge hunts its own faults on the same clock (`crew/sentinel.ts`).
  try {
    sentinelTick(app, now.getTime());
  } catch (error) {
    log.error("sentinel failed", { error: String(error) });
  }
  await breathe();
  // Review is not autonomy's alone: an agent's green pull is read by the
  // crew's reviewer in every repository that has one.
  try {
    await sweepReviews(app);
  } catch (error) {
    log.error("review sweep failed", { error: String(error) });
  }
}

/** The tick line's flow vitals (#5935): the counts in words, and the targets they miss. */
export function flowVitals(db: App["db"], now: Date): { pulls: string; offTarget?: string } {
  const v = readVitals(db, now);
  const misses = vitalsMisses(v);
  return { pulls: vitalsWords(v), ...(misses.length === 0 ? {} : { offTarget: misses.join("; ") }) };
}

/**
 * The stalled issues freed this tick (`freeStalled`): none while the crew
 * is off or paused, or nobody stands behind it.
 */
function unstickNow(app: App, repo: Repo, now: Date): number {
  if (repo.autonomy === "off" || repo.autonomyBy === null) return 0;
  if (autonomyStatus(app, repo, now).paused !== null) return 0;
  const by = getUserById(app.db, repo.autonomyBy);
  if (!by) return 0;
  const held = heldBy(
    app,
    repo,
    readyNow(repoGraph(app.db, repo.id, { sealed: true })),
    listCrewRoles(app.db, repo.id),
    activeRuns(app, repo.id),
  );
  return held.by.stalled.length === 0 ? 0 : freeStalled(app, repo, by, held);
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

/**
 * The ready issues, less those that retire names already gone from the base
 * (`retired.ts`): each gets the already-done note, once, and is not handed out.
 */
async function withoutRetired(
  app: App,
  repo: Repo,
  ready: readonly Ranked[],
): Promise<Ranked[]> {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const kept: Ranked[] = [];
  for (const r of ready) {
    const names = retiredNames(r.issue);
    if (names.length === 0) {
      kept.push(r);
      continue;
    }
    const oids = await removedBy(dir, repo.defaultBranch, names);
    if (oids.length === 0) {
      kept.push(r);
      continue;
    }
    if (!alreadyDone(app.db, [r.issue.id]).has(r.issue.id))
      noteAlreadyDone(app, repo, r.issue, oids);
  }
  return kept;
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
    case "guarded":
      return `guarded: ${guardedList(error.paths)}`;
    default:
      return error.kind;
  }
}

/** Pull id → the tips git last read, and the files in conflict (null: clean). */
const checked = new Map<
  string,
  { head: string; key: string; files: string[] | null; tree: string | null }
>();
/** Pull id → the head it conflicts at, and when the sweep first saw that (#5940). */
const conflictedAt = new Map<string, { head: string; since: string }>();
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

/**
 * Close a pull whose change is already on the base, naming the commits that
 * carry it, and close the issues it said it closes as done (#2121). Not a
 * park and no strike: nothing failed, the work landed another way.
 */
export function closeSuperseded(
  app: App,
  repo: Repo,
  pull: Pull,
  oids: readonly string[],
): boolean {
  if (repo.autonomyBy === null) return false;
  const by = getUserById(app.db, repo.autonomyBy);
  const issue = getIssueById(app.db, pull.id);
  if (!by || !issue || issue.state !== "open") return false;
  const named = oids.map((o) => o.slice(0, 8)).join(" ");
  addComment(
    app,
    by,
    repo,
    issue,
    `Closed by the crew: superseded, its change is already on ${pull.baseBranch} in ${named}.`,
  );
  const closed = setIssueState(app, by, repo, issue, "closed");
  if (!closed.ok) return false;
  for (const number of closesFromBody(pull.body)) {
    const about = getIssue(app.db, repo.id, number);
    if (!about || about.state !== "open") continue;
    // A superseded pull landed nothing: a person's reopen stands against it,
    // and so does work still unticked.
    if (reopenedByPerson(app.db, repo.id, number)) continue;
    const left = unticked(about.body);
    if (left.length > 0) {
      addComment(app, by, repo, issue, leftNote(number, left));
      continue;
    }
    if (about.assigneeId !== null) assignIssue(app, by, repo, about, null);
    addComment(app, by, repo, about, `${CLOSED_NOTE}${named} (pull #${pull.number}).`);
    setIssueState(app, by, repo, about, "closed", { reason: "done", system: true });
  }
  log.info("superseded pull closed", {
    repo: `${repo.ownerName}/${repo.name}`,
    pull: pull.number,
    commits: oids.length,
  });
  return true;
}

/** Conflict runs the crew may spend on one pull for one main tip. */
const RUNS_PER_TIP = 2;

/** Pull id → the main tip it was last asked about, and how many times. */
const asked = new Map<string, { tip: string; n: number }>();

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
 * again. An approved pull is not this sweep's but `finishApproved`'s.
 * Runs start oldest pull first, only as many as the check lane has room
 * for (`conflict_room.ts`); the rest wait for a later tick (#4459).
 * Returns how many pulls were acted on.
 */
export async function sweepConflicts(
  app: App,
  repo: Repo,
  now: Date = new Date(),
): Promise<number> {
  if (repo.autonomy !== "autonomous") return 0;
  let acted = 0;
  let room = readConflictRoom(app.db);
  // Forget pulls that are no longer open: closed, merged or released.
  for (const id of new Set([...checked.keys(), ...cleanAt.keys(), ...conflictedAt.keys()]))
    if (getIssueById(app.db, id)?.state !== "open") {
      checked.delete(id);
      conflictedAt.delete(id);
      cleanAt.delete(id);
      asked.delete(id);
    }
  // Every open pull, not the newest page: an old one main moved under is
  // the crew's too (#6263).
  for (const pull of listOpenPulls(app.db, repo.id)) {
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
        tree: reading.ok ? reading.value.treeOid : null,
        files: reading.ok
          ? null
          : reading.error.kind === "conflict"
            ? reading.error.files
            : null,
      };
      checked.set(pull.id, seen);
    }
    // Merging main leaves main's own tree: the pull adds nothing, so there
    // is no work to bring up to date and no run to spend on it.
    if (seen.tree !== null && seen.tree === (await treeOf(dir, baseTip))) {
      if (closeSuperseded(app, repo, pull, [baseTip])) {
        acted++;
        checked.delete(pull.id);
        cleanAt.delete(pull.id);
      }
      continue;
    }
    if (seen.files === null) {
      // Merges cleanly: whatever came before was a different episode.
      cleanAt.set(pull.id, new Date().toISOString());
      conflictedAt.delete(pull.id);
      continue;
    }
    const files = seen.files;
    // A push moves the head and the 72-hour clock starts again.
    let conflict = conflictedAt.get(pull.id);
    if (conflict?.head !== pull.headOid)
      conflictedAt.set(
        pull.id,
        (conflict = { head: pull.headOid, since: now.toISOString() }),
      );
    // An approved pull is finished first, and handed to a person rather
    // than closed: the tick's finishing pass has it (`finishing.ts`).
    if (approvedOnHead(app.db, pull)) continue;
    const issue = getIssueById(app.db, pull.id);
    if (!issue || issue.state !== "open") continue;
    if (activeRunFor(app.db, "agent", issue.id) !== undefined) continue;
    // Past 72 hours in conflict, whatever the attempts did (#5940).
    if (closeStale(app, repo, pull, conflict.since, now)) {
      acted++;
      checked.delete(pull.id);
      cleanAt.delete(pull.id);
      conflictedAt.delete(pull.id);
      continue;
    }
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
    // Main's tip asks no more than twice: a run that ends "ok" without a
    // push must not be queued again on every tick.
    const tried = asked.get(pull.id);
    if (tried?.tip === baseTip && tried.n >= RUNS_PER_TIP) continue;
    // A clash only in list docs is settled by the forge, with no run: its
    // push is a check, and the next tick sees the pull clean (#7909).
    if (onlyListDocs(files) && room > 0 && (await resolveListConflicts(app, repo, pull)) !== undefined) {
      room--;
      acted++;
      checked.delete(pull.id);
      continue;
    }
    // Its push is a check: none starts that the lane has no slot for (#4459).
    if (room <= 0) continue;
    if (bringUpToDate(app, repo, pull, files, since) !== undefined) {
      room--;
      acted++;
      asked.set(pull.id, {
        tip: baseTip,
        n: tried?.tip === baseTip ? tried.n + 1 : 1,
      });
    }
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
export async function reviewed(
  app: App,
  repo: Repo,
  pull: Pull,
  now: Date = new Date(),
): Promise<"pass" | "hold" | "lapsed"> {
  const seen = reviewSummary(app.db, pull.id, pull.headOid);
  if (seen.changesRequested > 0) return "hold";
  if (seen.approvals > 0) return "pass";
  // A trusted source's pull needs no person's review (#8937); its check, the
  // boot proof and the walls above still stood before this point.
  // A big first fold, and the crew's resolution of a conflict, are reviewed
  // by the crew first (#9003): they take the path below.
  if (foldsIn(app.db, pull.id, now) && !needsCrewReview(app.db, pull.id)) return "pass";
  // An agent's pull ships only on an approving review — the crew's reviewer
  // or a person's. With no reviewer, or a review that lapsed, it waits for
  // a person (`waitsForPerson` puts it where a person looks); never by lapse.
  // An app whose owner has not asked for reviews lands a green pull without
  // one (#11666); a verdict already on the head was handled above.
  const seated = reviewersForRepos(app.db, [repo.id]);
  if (reviewsOff(app.db, repo, seated)) return "pass";
  const reviewers = seated.get(repo.id)?.length ?? 0;
  if (pull.authorIsAgent) {
    if (reviewers > 0) await sendToReview(app, repo, pull);
    return "hold";
  }
  // A person's own pull is not held for a review that never comes.
  if (reviewers === 0) return "pass";
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
  const admitted = await admit(app, repo, pull);
  if (!admitted.ok) return false;
  const [landed] = await enqueue(repo.id, [admitted.value], gateFor(app, repo), queueOptions(app, repo));
  return landed === true;
}

/**
 * Everything a green pull must be before it joins the merge queue
 * (#2036): autonomous, open, unheld, green on its head, clear of the wall,
 * reviewed, and not already told red on this head and base. The queue
 * entry, or undefined when it does not join (and why is already done:
 * a conflict sent to the crew, a pull closed as carried, a wall card).
 */
async function admit(
  app: App,
  repo: Repo,
  pull: Pull,
  now: Date = new Date(),
): Promise<Result<Queued, Wait>> {
  if (repo.autonomy !== "autonomous" || repo.autonomyBy === null) return err("off");
  if (pull.state !== "open" || pull.mergedAt !== null) return err("closed");
  // The caller's copy may predate a landing: the row says whether it is
  // still open (#2017).
  const row = getPull(app.db, repo.id, pull.number);
  if (row === undefined || row.state !== "open" || row.mergedAt !== null)
    return err("closed");
  // A person said "not this one yet": nothing below happens until it is
  // released — no landing, no review sent, no run to bring the branch up
  // to date (`core/holds.ts`).
  if (getHold(app.db, pull.id) !== undefined) return err("held");
  // Only work the crew wrote, or a writer's, lands on green by itself: a
  // reader's pull — from a fork, say — waits for a person, outsiders
  // switch or not; not from here is it sent to the crew's reviewer (#619),
  // only through `sendToReview` on an autonomous repository (#9575).
  if (!landsOnItsOwn(app.db, repo, pull, now)) return err("outsider");
  const by = getUserById(app.db, repo.autonomyBy);
  if (!by) return err("off");
  // The newest run of each kind is what the head says: a red that a re-run
  // on the same commit has since turned green is history.
  const checks = verdictForHead(app.db, pull.id, pull.headOid);
  if (checks.length === 0) return err("unchecked");
  if (checks.some((c) => c.state !== "ok")) return err("not-green");
  // A stop the crew took on a red check ends with the green after it; a
  // person's stop waits for a person.
  const greenAt = checks
    .map((c) => c.finishedAt ?? "")
    .reduce((a, b) => (a > b ? a : b), "");
  if (stopStands(latestDecision(app.db, pull.id, "retry"), greenAt))
    return err("stopped");
  // Conflicts first: a pull that no longer merges is the crew's to bring
  // up to date, before anyone is asked whether it should land. A conflict
  // is remembered by the two tips it was between: until one of them moves
  // there is nothing new to try.
  // Asked where the pull's objects are: a sealed one's own place (`pullDir`).
  const dir = await pullDir(app.db, app.reposRoot, repo, pull);
  const baseTip =
    (await resolveOid(dir, `refs/heads/${pull.baseBranch}`)) ?? "";
  const between = `${pull.headOid}:${baseTip}`;
  if (conflicted.get(pull.id) === between) return err("conflict");
  if (baseTip !== "") {
    const clean = await mergeable(dir, baseTip, pull.headOid);
    if (!clean.ok) {
      if (clean.error.kind === "conflict") {
        conflicted.set(pull.id, between);
        // An approved one waits for the tick's finishing pass and its slot.
        if (!approvedOnHead(app.db, pull)) bringUpToDate(app, repo, pull, clean.error.files);
      }
      return err("conflict");
    }
    // A merge of a followed source's head that leaves most of its diff
    // behind marks the work taken without taking it (#9034): decided by a
    // person, trusted or not, and before "nothing new" closes it as carried.
    const dropped = await sourceHeld(app, repo, pull, baseTip);
    if (dropped.length > 0) {
      const earlier = latestDecision(app.db, pull.id, "land");
      const told =
        earlier?.answer === "wall" &&
        (earlier.state as { head?: unknown } | null)?.head === pull.headOid;
      if (!told)
        recordDecision(app.db, {
          kind: "land",
          repoId: repo.id,
          issueId: pull.id,
          state: { head: pull.headOid, cells: dropped, plain: dropped, unsound: false },
          answer: "wall",
          p: 1,
          by: "wall",
          ms: 0,
        });
      return err("wall");
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
      return err("carried");
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
          plain: wall.unsound ?? wall.loosened.map(wallPlain),
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
    return err("wall");
  }
  // A trusted source's pull that touches secrets, credentials, permissions,
  // the contract or release machinery waits for a person like a guest's.
  const folded = await foldWall(app, repo, pull, baseTip, now);
  if (folded.length > 0) {
    const earlier = latestDecision(app.db, pull.id, "land");
    const told =
      earlier?.answer === "wall" &&
      (earlier.state as { head?: unknown } | null)?.head === pull.headOid;
    if (!told)
      recordDecision(app.db, {
        kind: "land",
        repoId: repo.id,
        issueId: pull.id,
        state: { head: pull.headOid, cells: folded, plain: folded, unsound: false },
        answer: "wall",
        p: 1,
        by: "wall",
        ms: 0,
      });
    return err("wall");
  }
  // One gate for every pull, whoever wrote it: when the crew has a
  // reviewer, a green head is queued for review and waits for an approval
  // on that very head (a person's counts the same). A push is a new head,
  // so it starts over. An agent's pull waits for that approval however
  // long it takes — with no reviewer, or after one lapsed, a person's
  // (#597). Only a person's own pull lands without a reviewer, or after a
  // review lapsed.
  const review = await reviewed(app, repo, pull, now);
  if (review === "hold") return err("review");
  // The full tier, once, on the queue's candidate (#1198, #2036). Red is
  // told to the pull once per head and base, and the pull is out of the
  // queue until a push — a base that moved is no new try, or a pull red on
  // main rides every batch after each landing (#4235). A red the pull has
  // not moved off is gated once more after REGATE_RED_MS, alone (the queue
  // remembers it), so a red that was the machine's and not the code's does
  // not hold it for good; a red that reproduces stays red (#3155).
  const told = latestDecision(app.db, pull.id, "land");
  if (redOf(told)?.head === pull.headOid && !regateDue(told!, Date.now())) return err("red");
  // Green only against a base that has moved since is admitted as it is:
  // the candidate's full gate runs on the base tip with this pull merged,
  // which is the proof a re-check of its own would give, and a red one
  // bisects out (#3316). Re-checking each first made the line serial — a
  // landing staled every other pull, and each waited a check of its own.
  return ok({
    pull,
    dir,
    land: (expect) => landGated(app, repo, by, pull, review, expect),
    // On the forge's own code, the landed tree is checked out and
    // preflighted off to the side; the landing does not wait on it
    // (#1662). Once per candidate, at the last step that landed: that is
    // the tree main is at.
    release: (tip) =>
      void releaseOnLand(app, by, repo, pull, tip).catch((error) =>
        log.warn("release checkout failed", {
          pull: pull.number,
          why: error instanceof Error ? error.message : String(error),
        }),
      ),
    handBack: (red, baseOid, together) => {
      // Told on the base it was found red on: a new base is a new try. Red
      // again on the same head and base is the re-gate reproducing it: it
      // stays red for good, and the pull is not told twice.
      const at = `${pull.headOid}:${baseOid}`;
      const again = redAt(latestDecision(app.db, pull.id, "land"), at);
      const state: RedState = again ? { head: pull.headOid, at, again } : { head: pull.headOid, at };
      recordDecision(app.db, {
        kind: "land",
        repoId: repo.id,
        issueId: pull.id,
        state,
        answer: "red",
        p: 1,
        by: "rule",
        ms: 0,
      });
      addLearned(app.config.dataDir, pull.id, red.learn);
      if (!again) addComment(app, by, repo, getIssueById(app.db, pull.id) ?? pull, clashSaid(red.comment, together));
      // A red that reproduces on the re-gate is the code's: only then is it the doctor's to hold.
      if (again) treatRed(app, repo, by, pull, red, baseOid);
      // Red only on top of pulls that landed first: no single culprit yet, so the class is recorded and the re-gate alone decides.
      else noteRed(app, repo, pull, red, baseOid, together);
    },
  });
}

/**
 * A red's comment, and when it was red on top of pulls of its candidate
 * that landed first, a line naming them (#4235). The search does not gate
 * the pull alone on the base before them, so it says both readings.
 */
function clashSaid(comment: string, together: readonly number[]): string {
  if (together.length === 0) return comment;
  const names = together.map((n) => `#${n}`).join(", ");
  return `${comment}\n\nRed on top of ${names}, which landed first from the same merge-queue candidate: red on its own on that base, or only together with them. Bring this pull up to date with the base and push.`;
}

/** How long a red the pull has not moved off waits before it is gated once more (#3155). */
export const REGATE_RED_MS = 30 * 60_000;

/**
 * What a `red` land decision holds: the head it was red on, `head:base`
 * as `at`, and `again` when it is the re-gate that reproduced it.
 */
interface RedState {
  readonly head: string;
  readonly at: string;
  readonly again?: true;
}

/** The red a land decision tells, read off the ledger's untyped state; undefined for any other. */
function redOf(told: Decision | undefined): RedState | undefined {
  if (told?.answer !== "red") return undefined;
  const state = told.state;
  if (typeof state !== "object" || state === null) return undefined;
  const { head, at, again } = state as Record<string, unknown>;
  if (typeof head !== "string" || typeof at !== "string") return undefined;
  return again === true ? { head, at, again } : { head, at };
}

/** `told` is a red on this `head:base`. */
function redAt(told: Decision | undefined, at: string): boolean {
  return redOf(told)?.at === at;
}

/** A red that is old enough, and not itself a re-gate, is gated once more. */
export function regateDue(red: Decision, now: number): boolean {
  if (redOf(red)?.again === true) return false;
  return now - Date.parse(red.createdAt) >= REGATE_RED_MS;
}

/**
 * How the merge queue may use the forge's check slots (#4053): its depth and
 * batch size as an admin set them, and the slots the checks service has spare. Each judged
 * batch is kept for the red-batch rate (#6427); its gates and red marks are
 * kept in the database, and a gate a roll left running adopted (#6611).
 */
function queueOptions(app: App, repo: Repo): QueueOptions {
  return {
    depth: queueDepth(app.db),
    batch: queueBatch(app.db),
    room: () => checksFor(app)?.spareSlots?.() ?? 0,
    onBatch: (repoId, red) => keepBatch(app.db, repoId, red),
    onVerdict: (repoId, verdict) => keepVerdict(app.db, repoId, verdict),
    onFlake: (repoId, reds, tip) => {
      const owner = getRepoById(app.db, repoId);
      if (owner !== undefined) recordQueueFlakes(app.db, app.bus, owner, reds, tip);
    },
    store: queueStore(app.db),
    adopt: (record, signal) => adoptGate(app, repo, record, signal),
  };
}

/** The queue's gate: the full tier on the candidate's tip, asked as its first pull. */
function gateFor(app: App, repo: Repo): GateCandidate {
  return (candidate, signal) =>
    gateCandidate(app, repo, candidate.steps[0]!.entry.pull, candidate.dir, candidate.tipOid, signal);
}

/**
 * How a green pull lands. One carrying upstream's commits lands as a merge:
 * squashed, their history would never be ours and the next check would
 * count it again. Every other pull squashes.
 */
export async function landingStrategy(
  app: App,
  repo: Repo,
  pull: Pull,
  baseOid: string,
  now: Date = new Date(),
): Promise<"merge" | "squash"> {
  // A trusted source's work lands as a true merge: its commits stay
  // ancestors of main and each author keeps their name (#8937).
  if (foldsIn(app.db, pull.id, now)) return "merge";
  return (await carriesUpstream(
    app,
    repo,
    await pullDir(app.db, app.reposRoot, repo, pull),
    pull.headOid,
    baseOid,
  ))
    ? "merge"
    : "squash";
}

/**
 * Land one gated step of the queue's candidate: only onto the base it was
 * built on, and only as the tree that was gated (`expect`). The new tip of
 * the base, or undefined when it did not land.
 */
async function landGated(
  app: App,
  repo: Repo,
  by: User,
  pull: Pull,
  review: "pass" | "lapsed",
  expect: { baseOid: string; treeOid: string },
): Promise<string | undefined> {
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
    return undefined;
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
  const strategy = await landingStrategy(app, repo, pull, expect.baseOid);
  const merged = await mergePull(app, by, repo, pull, strategy, expect);
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
      conflicted.set(pull.id, `${pull.headOid}:${expect.baseOid}`);
      bringUpToDate(app, repo, pull, merged.error.files);
    }
    return undefined;
  }
  conflicted.delete(pull.id);
  // Closed as merged into what already carried it: main did not move, so
  // there is no release to cut and nothing new was landed.
  if (merged.value.carried) return undefined;
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
  return merged.value.mergeOid;
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
