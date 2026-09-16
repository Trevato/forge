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
import { assignIssue, openIssue } from "../actions/issues.ts";
import { mergePull } from "../actions/pulls.ts";
import { listCrewRoles, type Agent, type CrewRole } from "../core/agents.ts";
import { readyNow, repoGraph } from "../core/dependencies.ts";
import { getIssueById, type Issue } from "../core/issues.ts";
import {
  getPull,
  listPulls,
  openPullsClosing,
  type Pull,
} from "../core/pulls.ts";
import {
  getRepoById,
  listAutonomousRepos,
  setDirectionIssue,
  type Repo,
} from "../core/repos.ts";
import { checksForHead, listActive } from "../core/runs.ts";
import { getUserById, type User } from "../core/users.ts";
import { createLog } from "../kernel/log.ts";

const log = createLog("autonomy");

export const AUTONOMY_TICK_MS = 60_000;
/** A planner is not asked again sooner than this unless the map changed. */
const REPLAN_AFTER_MS = 6 * 60 * 60_000;

export type Paused = "ceiling" | "nobody" | "no crew";

export interface AutonomyStatus {
  readonly autonomy: Repo["autonomy"];
  readonly spentTodayUsd: number;
  readonly ceilingUsd: number;
  readonly slots: number;
  /** Agent runs queued or running here now. */
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

function activeRuns(app: App, repoId: string) {
  return listActive(app.db, "agent").filter((r) => r.repoId === repoId);
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
    active: activeRuns(app, repo.id).length,
    paused,
    resumesAt: paused === "ceiling" ? tomorrow.toISOString() : null,
  };
}

/**
 * Which builder takes an issue. The issue's own assignee when it is a
 * builder here; otherwise the builder with the least in flight, then by
 * name. One function, one fixed answer space: the place a faster or wiser
 * decider plugs in later.
 */
export function pickBuilder(
  issue: Issue,
  builders: readonly Agent[],
  inFlight: ReadonlyMap<string, number>,
): Agent | undefined {
  if (builders.length === 0) return undefined;
  const own = builders.find((b) => b.user.id === issue.assigneeId);
  if (own) return own;
  return [...builders].sort(
    (a, b) =>
      (inFlight.get(a.user.id) ?? 0) - (inFlight.get(b.user.id) ?? 0) ||
      a.user.username.localeCompare(b.user.username),
  )[0];
}

export type Drove = "off" | "paused" | "full" | "picked" | "planned" | "idle";

/**
 * One turn of the loop for one repository. Returns what it did, for the
 * log and for tests; the effects are an assignment (which the crew turns
 * into a run) or a planner given the direction.
 */
export function driveRepo(app: App, repo: Repo, now = new Date()): Drove {
  if (repo.autonomy === "off") return "off";
  const status = autonomyStatus(app, repo, now);
  if (status.paused !== null) return "paused";
  const by = getUserById(app.db, repo.autonomyBy!);
  if (!by) return "paused";
  const crew = listCrewRoles(app.db, repo.id);
  const builders = crew.filter((c) => c.role === "builder").map((c) => c.agent);
  const planner = crew.find((c) => c.role === "planner")?.agent;
  const active = activeRuns(app, repo.id);
  if (active.length >= repo.autonomySlots) return "full";

  const busyIssues = new Set(active.map((r) => r.issueId));
  const inFlight = new Map<string, number>();
  for (const r of active)
    if (r.actorId !== null)
      inFlight.set(r.actorId, (inFlight.get(r.actorId) ?? 0) + 1);
  const planners = new Set(
    crew.filter((c) => c.role !== "builder").map((c) => c.agent.user.id),
  );
  const graph = repoGraph(app.db, repo.id);
  const proposed = openPullsClosing(app.db, repo.id);
  const ready = readyNow(graph).filter(
    (r) =>
      r.issue.id !== repo.directionIssueId &&
      !busyIssues.has(r.issue.id) &&
      !proposed.has(r.issue.number) &&
      (r.issue.assigneeId === null || !planners.has(r.issue.assigneeId)) &&
      !stalled(app, r.issue),
  );
  const next = ready[0];
  if (next !== undefined) {
    const builder = pickBuilder(next.issue, builders, inFlight);
    if (!builder) return "paused";
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
    });
    return "picked";
  }

  // Nothing is ready. When nothing is in flight either, the map has run dry:
  // the planner is given the direction, not more often than the interval.
  if (active.length > 0 || planner === undefined) return "idle";
  if (repo.autonomyDirection.trim() === "") return "idle";
  const direction = ensureDirectionIssue(app, by, repo);
  if (!direction) return "idle";
  const lastPlan = app.db
    .query<{ state: string; created_at: string }, [string]>(
      `SELECT state, created_at FROM run WHERE issue_id = ?1 AND kind = 'agent'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(direction.id);
  if (lastPlan !== null && lastPlan !== undefined) {
    if (lastPlan.state === "queued" || lastPlan.state === "running")
      return "idle";
    if (
      now.getTime() - new Date(lastPlan.created_at).getTime() <
      REPLAN_AFTER_MS
    )
      return "idle";
  } else if (direction.assigneeId === planner.user.id) {
    // Asked already; the crew has not picked it up yet.
    return "idle";
  }
  // Asking again is an assignment again: clear it first so the event fires.
  if (direction.assigneeId !== null) {
    const cleared = assignIssue(app, by, repo, direction, null);
    if (!cleared.ok) return "idle";
  }
  const current = getIssueById(app.db, direction.id) ?? direction;
  const assigned = assignIssue(app, by, repo, current, planner.user);
  if (!assigned.ok) return "idle";
  log.info("map ran dry; planner asked", {
    repo: `${repo.ownerName}/${repo.name}`,
    planner: planner.user.username,
  });
  return "planned";
}

/**
 * An issue a builder already ran on and left without a pull — declined, or
 * cut short — is not picked again by the clock: running it again blind is
 * the loop autonomy refuses. It waits for a person's word, which is a
 * feedback run like any other.
 */
function stalled(app: App, issue: Issue): boolean {
  const last = app.db
    .query<{ state: string; summary: string }, [string]>(
      `SELECT state, summary FROM run WHERE issue_id = ?1 AND kind = 'agent'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(issue.id);
  if (last === null || last === undefined) return false;
  if (last.state === "queued" || last.state === "running") return true;
  return !/opened pull #|updated pull #/.test(last.summary);
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
    title: `Direction: ${repo.autonomyDirection.trim().slice(0, 120)}`,
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
      const did = driveRepo(app, getRepoById(app.db, repo.id) ?? repo, now);
      if (did === "picked" || did === "planned")
        log.info("tick", { repo: `${repo.ownerName}/${repo.name}`, did });
    } catch (error) {
      log.error("autonomy tick failed", {
        repo: `${repo.ownerName}/${repo.name}`,
        error: String(error),
      });
    }
  }
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
  const merged = await mergePull(app, by, repo, pull, "squash");
  if (!merged.ok) {
    log.info("green but not landed", {
      repo: `${repo.ownerName}/${repo.name}`,
      pull: pull.number,
      why: String(merged.error),
    });
    return false;
  }
  log.info("landed on green", {
    repo: `${repo.ownerName}/${repo.name}`,
    pull: pull.number,
  });
  return true;
}

export function roleOf(app: App, repo: Repo, agent: Agent): CrewRole {
  return (
    listCrewRoles(app.db, repo.id).find(
      (c) => c.agent.user.id === agent.user.id,
    )?.role ?? "builder"
  );
}

export { getPull };
