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

import type { App } from "../app.ts";
import {
  addComment,
  assignIssue,
  openIssue,
  setIssueState,
} from "../actions/issues.ts";
import type { AccessError } from "../actions/access.ts";
import { mergeable, resolveOid } from "../git/merge.ts";
import { listReviews } from "../core/reviews.ts";
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
import { latestDecision, resolveOpen } from "../core/decisions.ts";
import { certain } from "./decide.ts";
import { decideAndRecord } from "./ledger.ts";
import {
  getIssue,
  getIssueById,
  MAX_TITLE,
  type Issue,
} from "../core/issues.ts";
import {
  getPull,
  closesFromBody,
  listPulls,
  openPullsClosing,
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
  checksForHead,
  listActive,
  type Run,
  cancelRun,
} from "../core/runs.ts";
import {
  agentFor,
  CHECK_FAILED_LIMIT,
  lastHumanWord,
  queueAgentRun,
} from "./dispatch.ts";
import { getUserById, type User } from "../core/users.ts";
import { createLog } from "../kernel/log.ts";

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

export type Paused = "ceiling" | "nobody" | "no crew";

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
  const paused: Paused | null =
    repo.autonomy === "off"
      ? null
      : repo.autonomyBy === null
        ? "nobody"
        : crew.length === 0
          ? "no crew"
          : spent >= repo.autonomyCeilingUsd
            ? "ceiling"
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
    resumesAt: paused === "ceiling" ? tomorrow.toISOString() : null,
  };
}

export type Drove = "off" | "paused" | "full" | "picked" | "planned" | "idle";

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
  if (slotted.length >= repo.autonomySlots) {
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
  const proposed = openPullsClosing(app.db, repo.id);
  const ready = readyNow(graph).filter(
    (r) =>
      r.issue.id !== repo.directionIssueId &&
      !busyIssues.has(r.issue.id) &&
      !proposed.has(r.issue.number) &&
      (r.issue.assigneeId === null || !planners.has(r.issue.assigneeId)) &&
      !stalled(app, r.issue) &&
      parkedCount(app, r.issue.id) < 2,
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
  if (lastPlan !== null && lastPlan !== undefined) {
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
function stalled(app: App, issue: Issue): boolean {
  const last = app.db
    .query<{ state: string; summary: string; created_at: string }, [string]>(
      `SELECT state, summary, created_at FROM run WHERE issue_id = ?1 AND kind = 'agent'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(issue.id);
  if (last === null || last === undefined) return false;
  if (last.state === "queued" || last.state === "running") return true;
  if (/opened pull #|updated pull #/.test(last.summary)) return false;
  // A word since then — a person's, or the planner's when it re-planned
  // a parked issue — is what un-stalls it.
  const spoken = app.db
    .query<
      { n: number },
      [string, string]
    >("SELECT COUNT(*) AS n FROM comment WHERE issue_id = ?1 AND created_at > ?2")
    .get(issue.id, last.created_at);
  return (spoken?.n ?? 0) === 0;
}

/** How many times the crew has parked work on this issue. */
export function parkedCount(app: App, issueId: string): number {
  const row = app.db
    .query<
      { n: number },
      [string]
    >("SELECT COUNT(*) AS n FROM comment WHERE issue_id = ?1 AND body LIKE 'Parked by the crew%'")
    .get(issueId);
  return row?.n ?? 0;
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
 * rather than left stalled: one fresh try later, then the planner's.
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
  if (run.reason === "review") return false;
  if (/opened pull #|updated pull #/.test(run.summary)) return false;
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
function ensureDirectionIssue(
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
}

/**
 * Which ready issue next. The rule takes the top of the ready list (the
 * critical path); the decider, when there is one, chooses among the first
 * few with the direction in hand. Recorded, so a pick can be judged later.
 */
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
      ready: few.map((r) => ({
        number: r.issue.number,
        title: r.issue.title,
        body: r.issue.body.slice(0, 400),
        holdsUp: r.holdsUp,
      })),
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

/**
 * Ship a green pull, or show it to a person first. The rule ships; the
 * decider may say show when the change looks large, off-direction, or
 * touches money, sign-in or data. One answer per head: the same head is
 * not asked about twice.
 */
export async function shipOrShow(
  app: App,
  repo: Repo,
  pull: Pull,
  checks: readonly Run[],
): Promise<"ship" | "show"> {
  if (app.config.decider === undefined) return "ship";
  const earlier = latestDecision(app.db, pull.id, "land");
  if (
    earlier !== undefined &&
    typeof earlier.state === "object" &&
    earlier.state !== null &&
    (earlier.state as { head?: unknown }).head === pull.headOid
  )
    return earlier.answer === "show" ? "show" : "ship";
  const options = ["ship", "show"];
  const decided = await decideAndRecord(
    app,
    { kind: "land", repo, issue: pull },
    {
      direction: repo.autonomyDirection,
      head: pull.headOid,
      pull: {
        number: pull.number,
        title: pull.title,
        body: pull.body.slice(0, 1200),
      },
      checks: checks.map((c) => ({ kind: c.kind, summary: c.summary })),
    },
    {
      land: {
        options,
        about:
          "The check is green. Land this pull now, or have a person look first?",
        describe: {
          ship: "Land it now: the change is within the direction and the kind a crew lands on its own.",
          show: "Show a person first: the change is large, off the direction, or touches money, sign-in, data, or what people see first.",
        },
      },
    },
    () => ({ land: certain(options, "ship") }),
  );
  if (decided.answers.land.choice === "show")
    log.info("green; shown to a person first", {
      repo: `${repo.ownerName}/${repo.name}`,
      pull: pull.number,
      by: decided.by,
      p: decided.answers.land.p.toFixed(2),
    });
  return decided.answers.land.choice === "show" ? "show" : "ship";
}

/**
 * The reviewer's pass. When the decider would rather not land a pull
 * unseen, the crew's reviewer looks first: one review run per head, then
 * its verdict decides — approved lands, changes requested go back to the
 * builder as feedback (dispatch handles that review like a person's). A
 * crew with no reviewer lands it.
 */
export async function reviewFirst(
  app: App,
  repo: Repo,
  pull: Pull,
): Promise<"ship" | "wait"> {
  const reviewer = listCrewRoles(app.db, repo.id).find(
    (c) => c.role === "reviewer",
  )?.agent;
  if (reviewer === undefined) return "ship";
  const verdicts = listReviews(app.db, pull.id)
    .filter(
      (r) => r.authorId === reviewer.user.id && r.commitOid === pull.headOid,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const last = verdicts.at(-1);
  if (last?.state === "approved") {
    // A review run still waiting for a head that is already approved has
    // nothing left to do.
    const pending = activeRunFor(app.db, "agent", pull.id);
    if (pending?.reason === "review" && pending.state === "queued")
      cancelRun(app.db, pending.id, "approved before the run started");
    return "ship";
  }
  if (last?.state === "changes_requested") return "wait";
  // A reviewer that could not run — the run failed before a verdict — is
  // not asked again for this head: autonomous lands, and the log says so.
  // One pass per head. A review run that already ended for this head —
  // with a verdict the forge could not match, or none at all — is not run
  // again: the reviewer had its look, and autonomous lands. Three review
  // runs on one pull, whatever their heads, is the reviewer's whole say.
  const passes = app.db
    .query<
      { state: string; summary: string },
      [string]
    >("SELECT state, summary FROM run WHERE issue_id = ?1 AND kind = 'agent' AND reason = 'review' AND state IN ('ok','failed','cancelled') ORDER BY created_at DESC")
    .all(pull.id);
  const forHead = passes.find(
    (p) =>
      p.summary.startsWith(`review at ${pull.headOid.slice(0, 7)}`) ||
      p.state === "failed" ||
      p.state === "cancelled",
  );
  if (forHead !== undefined || passes.length >= 3) {
    log.info("the reviewer had its look; landing", {
      repo: `${repo.ownerName}/${repo.name}`,
      pull: pull.number,
      why: forHead?.summary ?? `${passes.length} review runs`,
    });
    return "ship";
  }
  // Two rounds of changes are the reviewer's say; after that it lands,
  // and what is left is the reviewer's to open as an issue.
  const rounds = listReviews(app.db, pull.id).filter(
    (r) => r.authorId === reviewer.user.id && r.state === "changes_requested",
  ).length;
  if (rounds >= 2) return "ship";
  if (activeRunFor(app.db, "agent", pull.id) !== undefined) return "wait";
  const issue = getIssueById(app.db, pull.id);
  if (!issue) return "wait";
  const queued = queueAgentRun(
    app,
    repo,
    issue,
    reviewer,
    "review",
    undefined,
    {
      notBefore: new Date().toISOString(),
      attempt: 0,
      summary: `review at ${pull.headOid.slice(0, 7)}`,
    },
  );
  if (queued)
    log.info("green; the reviewer looks first", {
      repo: `${repo.ownerName}/${repo.name}`,
      pull: pull.number,
      reviewer: reviewer.user.username,
    });
  return "wait";
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
  const by = getUserById(app.db, repo.autonomyBy);
  if (!by) return false;
  const checks = checksForHead(app.db, pull.id, pull.headOid);
  if (checks.length === 0) return false;
  if (checks.some((c) => c.state !== "ok")) return false;
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
  // Ship, or look first: the decider reads the pull against the direction.
  // A rule ships everything green; the decider is what makes "autonomous"
  // mean judgement rather than a conveyor belt — and the look is the crew's
  // own reviewer, not a person. Without a reviewer, it lands.
  if ((await shipOrShow(app, repo, pull, checks)) === "show") {
    if ((await reviewFirst(app, repo, pull)) === "wait") return false;
  }
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
