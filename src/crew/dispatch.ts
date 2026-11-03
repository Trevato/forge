/**
 * How work reaches the crew. The dispatcher listens to the outbox and
 * sweeps behind it: an issue assigned to an agent becomes a run; a person
 * who may direct the crew (`direct.ts`) speaking on an agent's pull — a
 * comment, a verdict, a line comment — becomes a follow-up; a failed deploy of an agent's pull becomes a
 * bounded follow-up. Runs are rows first (`queued`), and a worker tick
 * takes them in order up to the concurrency limit, one per issue at a
 * time. A missed wake-up costs a tick, never a run.
 */

import { TEMP_FULL } from "../checks/disk_full.ts";
import { freshPullFor } from "./fresh_pull.ts";
import { PRIORITY_REASONS, weekHold } from "./week_hold.ts";
import { weekFor } from "./week_read.ts";
import { twinNote, twinOf, type Twin } from "./twin.ts";
import { NO_MERGE } from "../checks/merged.ts";
import { resolveListConflicts } from "../actions/list-conflicts.ts";
import { markHeard } from "../core/issues.ts";
import { capacityCount, noteBooted, paceFloor } from "../core/capacity.ts";
import { tmpdir } from "node:os";
import { emailVerified } from "../core/verify.ts";
import { rmSync } from "node:fs";
import type { App } from "../app.ts";
import { transact } from "../kernel/db.ts";
import { addComment } from "../actions/issues.ts";
import { planAnotherRound } from "../actions/give_back.ts";
import { announceRun } from "../actions/runs.ts";
import { crewRole, getAgent, type Agent } from "../core/agents.ts";
import { LANDED_LEAD } from "../core/done_on_main.ts";
import type { ForgeEvent } from "../core/events.ts";
import {
  getIssue,
  getIssueById,
  addComment as insertComment,
  listComments,
  type Issue,
} from "../core/issues.ts";
import { closesFromBody, getPull, pullDir, type Pull } from "../core/pulls.ts";
import { claimedClones, sweepOrphanClones } from "./orphans.ts";
import { pruneRunFiles } from "../runs/prune.ts";
import { crewRoot, isClaimed } from "./workdir.ts";
import { resolveOpen } from "../core/decisions.ts";
import { accountActive } from "../core/accounts.ts";
import { runningLimitSentence, runningRuns } from "../settings/quotas.ts";
import { appendRunLog } from "../runs/log.ts";
import { decideAndRecord } from "./ledger.ts";
import { bugsFirst } from "../flow/bugs.ts";
import { byDials } from "./team_share.ts";
import { gateQueue } from "../flow/valve_gate.ts";
import { ARCHIVED_WHY, getRepoById, type Repo } from "../core/repos.ts";
import { listReviews } from "../core/reviews.ts";
import {
  greenHead,
  sendToReview,
} from "./review.ts";
import {
  activeRunFor,
  hasQueuedRun,
  variantGroupOf,
  automaticRunsSince,
  cancelRun,
  createRun,
  getRun,
  leaseLapsed,
  listActive,
  listQueued,
  PULL_STOPPED,
  type Run,
} from "../core/runs.ts";
import { getUserById, type User } from "../core/users.ts";
import { guestSql, lacks } from "../core/roles.ts";
import { createLog } from "../kernel/log.ts";
import { issueOfBranch, type RunReason } from "./brief.ts";
import { detectClaude } from "./claude.ts";
import { followDivergence, settleAll, settleOnPush } from "./converge.ts";
import { breakerTripped } from "./breaker.ts";
import { REPEAT_NOTE, repeatTripped } from "./repeat.ts";
import { unstickOwed } from "./stalls.ts";
import {
  CAP_NOTE,
  capNoted,
  capReached,
  HANDOVER_NOTE,
  RETRY_SUMMARY,
  handoverNote,
  handoverOf,
  type Handover,
  recordCap,
  runCapOf,
  skipsFeedback,
} from "./guard.ts";
import { noteProtection } from "../kernel/protection.ts";
import { dataInTemp, sandboxAvailable, sweepRunTmp } from "./sandbox.ts";
import { mayDirectCrew } from "./direct.ts";
import {
  AUTONOMY_TICK_MS,
  autonomyTick,
  landIfGreen,
  parkForBreaker,
  parkPull,
  settleAgentRun,
  spentToday,
} from "./autonomy.ts";
import { checksFor } from "../checks/service.ts";
import { redMain, sharedWithMain } from "../checks/red_main.ts";
import { diskRecovered, diskRed } from "../checks/disk_red.ts";
import { sharedWithPulls } from "../checks/shared_red.ts";
import type { Impact } from "../checks/impact.ts";
import {
  OUTSIDE_DIFF,
  outsideDiffCandidate,
  pullChanged,
  recheckedHead,
  recheckLine,
  redOutsideDiff,
} from "../checks/outside_diff.ts";
import { certain } from "./decide.ts";
import { readRunLog } from "../runs/log.ts";
import { whenText } from "./limits.ts";
import {
  executeAgentRun,
  workdirFor,
  type CrewOptions,
  type Pause,
  steerRun,
} from "./runner.ts";
import { STALE_AFTER_MS } from "../runs/lease.ts";
import { abortAgentRun } from "./running.ts";

const log = createLog("crew");

/** Automatic follow-ups after a failed check, before a person must speak. */
export const CHECK_FAILED_LIMIT = 2;
const TICK_MS = 5_000;

/** Whether the check run's red is a pull that does not merge into its base. */
function conflictSummary(app: App, runId: unknown): boolean {
  if (typeof runId !== "string") return false;
  return getRun(app.db, runId)?.summary.includes(NO_MERGE) === true;
}

/**
 * A pull's check could not start for a conflict: the forge keeps both sides
 * of a list-doc clash itself, else queues one bring-up-to-date run. Neither
 * is a try (`automaticRunsSince` counts failed checks only); one in flight is
 * enough.
 */
async function bringUpAfterNoMerge(app: App, repo: Repo, issue: Issue, agent: Agent): Promise<void> {
  const pull = getPull(app.db, repo.id, issue.number);
  if (!pull) return;
  if (await resolveListConflicts(app, repo, pull)) return;
  if (activeRunFor(app.db, "agent", issue.id) !== undefined) return;
  queueAgentRun(app, repo, issue, agent, "conflict", undefined, {
    notBefore: new Date().toISOString(),
    attempt: 0,
    summary: "main moved: the pull does not merge into its base",
  });
}

export interface CrewHandle {
  /** Whether a usable Claude Code was found at start. */
  readonly ready: boolean;
  readonly detail: string;
  /** Whether agents' shells are held to the sandbox here, and why not when they are not. */
  readonly sandbox: { readonly enforced: boolean; readonly reason: string };
  /**
   * Stop. Plain, what is in flight is cut short and its task queued again.
   * Draining — a release's old process, with the new one already taking
   * everything new — nothing more starts, and what is in flight is left to
   * finish and land as if nothing had happened, up to `drainMs`.
   */
  stop(options?: { drain?: boolean; drainMs?: number }): Promise<void>;
}

/**
 * How long a draining crew waits for its runs before cutting them short.
 * Short: a run cut here is queued again and resumes its own session on the
 * forge that comes up next, so little is lost, while a long drain holds a
 * whole pod's memory through a rollout and blocks the next one.
 */
const DRAIN_MS = 3 * 60_000;

const handles = new WeakMap<App, CrewHandle>();

/** The crew serving this forge, if one was started. */
export const crewFor = (app: App): CrewHandle | undefined => handles.get(app);

export async function startCrew(
  app: App,
  options: CrewOptions,
): Promise<CrewHandle> {
  const detected = await detectClaude(options.binary);
  if (!detected.ok)
    log.warn("claude not usable; agent runs will fail", {
      error: detected.error,
    });
  else
    log.info("crew is up", {
      claude: detected.version,
      concurrency: options.concurrency,
    });
  // The shell sandbox is policy, not decoration: where the host cannot
  // hold a run to it, the runs say so instead of warning on every command.
  // The default the Capacity page shows and goes back to (`core/capacity.ts`).
  noteBooted(app.db, "crew.concurrency", String(options.concurrency));
  const sandbox = await sandboxAvailable();
  noteProtection("crew shells", sandbox);
  // Temp directories of runs a stopped forge never finished: old enough
  // that no forge beside this one (a rollout) can still be using them.
  try {
    const swept = sweepRunTmp(app.config.dataDir, options.runTimeoutMs + 60 * 60_000);
    if (swept > 0) log.info("swept leftover run temp directories", { count: swept });
  } catch (error) {
    log.warn("could not sweep run temp directories", { error: String(error) });
  }
  // The shell can be denied the machine's temp directory whole only when
  // the forge's data is not inside it (`crew/sandbox.ts`, `tempDenied`).
  if (dataInTemp(app.config.dataDir))
    log.warn(
      "the data directory is inside the temp directory: agents' shells are denied only the forge's own pieces of it, not all of it",
      { dataDir: app.config.dataDir, tmpdir: tmpdir() },
    );
  if (!sandbox.ok)
    log.warn("agent sandbox not available here; runs are unrestricted", {
      reason: sandbox.reason,
    });
  const ready: CrewOptions = {
    ...options,
    sandboxEnforced: sandbox.ok,
    ...(sandbox.ok ? {} : { sandboxNote: sandbox.reason }),
  };

  let stopped = false;
  // Runs `pump` has started and not yet seen finish. `stop()` aborts each
  // and waits for it: without this, a run `pump` fired (fire-and-forget)
  // keeps cloning, spawning and eventually calling `finishRun`/`announceRun`
  // on `app.db` after a caller who awaited `stop()` believed the crew was
  // quiet and closed it.
  const inFlight = new Map<string, Promise<void>>();
  const unsubscribe = app.bus.subscribe((event) => {
    try {
      route(app, event);
    } catch (error) {
      log.error("crew routing failed", {
        kind: event.kind,
        error: String(error),
      });
    }
  });
  // A fork whose parent moved past it is the crew's to converge.
  const unfollow = followDivergence(app);
  const unsettle = settleOnPush(app);
  // Repositories that run on their own take a turn once a minute, on the
  // same clock as the pump, so a pick becomes a run on the next tick.
  let lastAutonomy = 0;
  const timer = setInterval(() => {
    if (stopped) return;
    requeueInterrupted(app);
    recheckForDisk(app);
    if (Date.now() - lastAutonomy >= AUTONOMY_TICK_MS) {
      lastAutonomy = Date.now();
      settleAll(app).catch((error) =>
        log.error("converge sweep failed", { error: String(error) }),
      );
      autonomyTick(app).catch((error) =>
        log.error("autonomy tick failed", { error: String(error) }),
      );
    }
    pump(app, ready, inFlight);
  }, options.tickMs ?? TICK_MS);
  // Clones no open issue, pull or run claims fill the volume (#5697).
  const sweepClones = (): void => {
    sweepOrphanClones(crewRoot(app.config.dataDir), claimedClones(app.db), isClaimed)
      .then((count) => {
        if (count > 0) log.info("removed clones nothing claims", { count });
      })
      .catch((error) => log.warn("clone sweep failed", { error: String(error) }));
    const pruned = pruneRunFiles(app.config.dataDir);
    if (pruned > 0) log.info("removed old run logs", { count: pruned });
  };
  sweepClones();
  const cloneTimer = setInterval(() => !stopped && sweepClones(), 60 * 60_000);
  requeueInterrupted(app);
  sweepAssigned(app);
  pump(app, ready, inFlight);

  const handle: CrewHandle = {
    ready: detected.ok,
    sandbox: { enforced: sandbox.ok, reason: sandbox.ok ? "" : sandbox.reason },
    detail: detected.ok ? `Claude Code ${detected.version}` : detected.error,
    stop: async (options = {}) => {
      stopped = true;
      clearInterval(timer);
      clearInterval(cloneTimer);
      unsubscribe();
      unfollow();
      unsettle();
      if (options.drain === true && inFlight.size > 0) {
        // Let what is in flight finish: a run cut short is a person's
        // money spent twice. The new forge takes new work meanwhile.
        log.info("crew draining", { runs: inFlight.size });
        const done = Promise.all(inFlight.values()).then(() => "done");
        const late = new Promise<"late">((resolve) =>
          setTimeout(() => resolve("late"), options.drainMs ?? DRAIN_MS),
        );
        if ((await Promise.race([done, late])) === "done") {
          handles.delete(app);
          return;
        }
      }
      // What is in flight goes back on the queue once it has stopped: the
      // forge is restarting, not the person's request.
      const interrupted = [...inFlight.keys()]
        .map((runId) => getRun(app.db, runId))
        .filter((run): run is Run => run !== undefined);
      for (const runId of inFlight.keys()) abortAgentRun(runId);
      await Promise.all(inFlight.values());
      for (const run of interrupted)
        requeue(app, run, "stopped for a restart; queued again");
      handles.delete(app);
    },
  };
  handles.set(app, handle);
  return handle;
}

/** Tell the issue's thread why nothing started, once per twin and standing. */
function tellTwin(app: App, repo: Repo, issue: Issue, by: User, twin: Twin): void {
  const note = twinNote(twin);
  if (listComments(app.db, issue.id).some((c) => c.body === note)) return;
  addComment(app, by, repo, issue, note);
}

/** Say the hand-over on the pull's thread, once per hand-over. */
function handOver(
  app: App,
  repo: Repo,
  issue: Issue,
  by: User,
  over: Handover,
): void {
  const said = listComments(app.db, issue.id).some(
    (c) => c.body.startsWith(HANDOVER_NOTE) && c.createdAt >= over.at,
  );
  if (said) return;
  addComment(app, by, repo, issue, handoverNote(over, repo.autonomy === "autonomous"));
  log.info("handed to a person after three reviews", {
    repo: `${repo.ownerName}/${repo.name}`,
    pull: issue.number,
  });
}

/**
 * Whether a run on the direction is the planner's pass owed for an issue a
 * stall struck out since its last pass: that pass starts past the day's
 * planning cap, since unsticking is not planning (`stalls.ts`).
 */
function unstickDue(app: App, repo: Repo, issue: Issue): boolean {
  if (issue.id !== repo.directionIssueId) return false;
  const last = app.db
    .query<{ at: string }, [string]>(
      `SELECT created_at AS at FROM run WHERE issue_id = ?1 AND kind = 'agent'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(issue.id);
  return unstickOwed(app.db, repo, last?.at ?? "");
}

/** Whether `spentUsd` has reached the repository's daily ceiling: the test that stops a run being queued. */
export function atCeiling(
  repo: Pick<Repo, "autonomyCeilingUsd">,
  spentUsd: number,
): boolean {
  return spentUsd >= repo.autonomyCeilingUsd;
}

/**
 * Whether this run is a job outside the agent's seat here: a build for one
 * that is not a builder (the direction issue is the planner's), a review for
 * one that is not a reviewer. On the crew the seat is the repository's; off
 * it, what the agent declares.
 */
export function outsideSeat(
  app: App,
  repo: Repo,
  issue: Issue,
  agent: Agent,
  reason: RunReason,
): boolean {
  // Every reason but a review is building work: a first go, feedback, a red check, a conflict, a converge.
  const seat =
    reason === "review"
      ? "reviewer"
      : issue.id === repo.directionIssueId
        ? "planner"
        : "builder";
  const held = crewRole(app.db, repo.id, agent.user.id);
  // A pull assigned to its reviewer is asked for a look, a builder's for a fix: only a planner is outside.
  if (reason !== "review" && issue.kind === "pull")
    return (held ?? agent.roles[0]) === "planner";
  return held === undefined ? !agent.roles.includes(seat) : held !== seat;
}

export const NOT_A_BUILDER_NOTE =
  "I am not a builder here, so I have not started on this. Assign it to a builder on the crew, or change my roles in Settings.";

/** Queue a run about an issue for an agent, unless one is already waiting. */
export function queueAgentRun(
  app: App,
  repo: Repo,
  issue: Issue,
  agent: Agent,
  reason: RunReason,
  actorId?: string,
  again?: { notBefore: string; attempt: number; summary: string },
  variantGroup?: string,
  retry = false,
  /** The run is this agent's own on the issue: another agent's run does not stand in its way (team reviews). */
  own = false,
): Run | undefined {
  // A suspended or removed owner's repositories run nothing, whoever asks.
  if (!accountActive(app.db, repo.ownerId)) return undefined;
  // Never a job outside the agent's seat: building is a builder's, reviewing a reviewer's.
  if (outsideSeat(app, repo, issue, agent, reason)) return undefined;
  // An archived repository starts nothing new; a run carrying on (`again`)
  // is one already going, and finishes. A first run
  // (`attempt` 0, as a conflict or converge run is queued) is new.
  if (repo.archivedAt !== null && (again === undefined || again.attempt === 0))
    return undefined;
  // A guest's word starts no run (a comment is still a comment); the
  // actions that start one by name refuse out loud before they get here.
  const asker = actorId === undefined ? undefined : getUserById(app.db, actorId);
  if (asker !== undefined && lacks(app.db, asker, "run_crew")) return undefined;
  // The day's ceiling gates every run the crew starts on its own, not only
  // the picks: a review, a feedback run or a conflict run past the ceiling
  // is money the person did not agree to. A person's own assignment is not
  // the crew's.
  if (
    reason !== "assigned" &&
    repo.autonomy === "autonomous" &&
    atCeiling(repo, spentToday(app.db, repo.id))
  ) {
    log.info("at the ceiling; not queued", {
      repo: `${repo.ownerName}/${repo.name}`,
      issue: issue.number,
      reason,
    });
    return undefined;
  }
  // Three failed or declined runs in an hour: parked, until a person speaks.
  if (breakerTripped(app.db, repo, issue.id)) {
    parkForBreaker(app, repo, issue, agent);
    return undefined;
  }
  // The same issue run again and again within minutes: a loop, parked once.
  if (repeatTripped(app.db, repo, issue.id)) {
    parkForBreaker(app, repo, issue, agent, REPEAT_NOTE);
    return undefined;
  }
  // A day's share of runs on one issue without a person's word: a loop,
  // parked once and asked about once (`guard.ts`). A run carrying on after
  // a pause or a restart is the same start, never a new one. The direction
  // issue has its own, larger share (`runCapOf`).
  const cap = runCapOf(repo, issue, app.config);
  if (
    again === undefined &&
    capReached(app.db, repo, issue, cap) &&
    !unstickDue(app, repo, issue)
  ) {
    if (
      !capNoted(app.db, repo, issue) &&
      parkForBreaker(app, repo, issue, agent, CAP_NOTE)
    )
      recordCap(app.db, repo, issue, cap);
    return undefined;
  }
  // Looked for and written in one write transaction: during a roll two
  // forge processes share this database, and both may react to the same
  // thing — a run checked for by one and inserted by the other would be the
  // same work twice (docs/ARCHITECTURE.md, "Two processes at once").
  let refusedAsTwin: Twin | undefined;
  const run = transact(app.db, () => {
    // A follow-up is the builder's: a reviewer's own run on the pull, still
    // running as it posts its verdict, is not the run that hears it.
    const mine = reason === "feedback" || own ? agent.user.id : undefined;
    const active = activeRunFor(app.db, "agent", issue.id, mine);
    // A follow-up with nothing new would only read the agent's own reply
    // and decline. With a run in flight the answer waits for it to end: the
    // queued run asks again as it starts (`runner.ts`).
    if (
      reason === "feedback" &&
      !retry &&
      again === undefined &&
      active === undefined &&
      skipsFeedback(app.db, repo, issue, agent)
    )
      return undefined;
    // One queued follow-up is enough: the run that eventually starts reads
    // the whole conversation since the last one, so nothing is lost. The
    // queued one may sit behind a running one, so it is looked for by itself.
    if (
      active !== undefined &&
      (reason === "assigned" ||
        hasQueuedRun(app.db, "agent", issue.id, mine))
    )
      return undefined;
    // One build run per issue: a pull opened a moment ago is that run's
    // answer, and a second build beside it is the same work twice.
    if (reason === "assigned") {
      const fresh = freshPullFor(app.db, repo.id, issue.number, [agent.user.username]);
      if (fresh !== undefined) {
        log.info("build run refused: a pull opened in the last 10 minutes", {
          repo: `${repo.ownerName}/${repo.name}`,
          issue: issue.number,
          pull: fresh.number,
        });
        return undefined;
      }
    }
    // The same title is the same work: while a twin has a run going or a
    // pull open, or its pull landed since this issue was opened, a build
    // here only repeats it. Variants are the exception: they share a title
    // on purpose, several tries in one group.
    const group = variantGroup ?? variantGroupOf(app.db, issue.id);
    if (reason === "assigned" && group === undefined) {
      const twin = twinOf(app.db, issue);
      if (twin !== undefined) {
        log.info("build run refused: a twin holds the work", {
          repo: `${repo.ownerName}/${repo.name}`,
          issue: issue.number,
          twin: twin.number,
          standing: twin.standing,
        });
        refusedAsTwin = twin;
        return undefined;
      }
    }
    return createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      actorId: agent.user.id,
      reason,
      ...(retry ? { summary: RETRY_SUMMARY } : {}),
      ...again,
      // A run queued again (a restart, a pause, the sweep) stays in the
      // group its issue was started in.
      ...(group ? { variantGroup: group } : {}),
    });
  });
  if (run !== undefined) announceRun(app, run, actorId);
  else if (refusedAsTwin !== undefined) tellTwin(app, repo, issue, agent.user, refusedAsTwin);
  return run;
}

/**
 * An issue belongs to one builder: when it is handed to a person, to
 * nobody, or to another agent, the runs of everyone else on it end — a
 * queued one is cancelled, a running one is aborted — and one line on the
 * issue says who took it.
 */
function releaseOtherRuns(
  app: App,
  repo: Repo,
  issue: Issue,
  actorId: string | null,
): void {
  const released: Run[] = [];
  for (const live of listActive(app.db, "agent")) {
    if (live.issueId !== issue.id || live.actorId === issue.assigneeId)
      continue;
    const cancelled = cancelRun(
      app.db,
      live.id,
      "the issue was reassigned; this run no longer holds it",
    );
    if (!cancelled) continue;
    announceRun(app, cancelled);
    if (live.state === "running") abortAgentRun(live.id);
    released.push(cancelled);
  }
  if (released.length === 0 || actorId === null) return;
  const holder =
    issue.assigneeId === null
      ? undefined
      : getUserById(app.db, issue.assigneeId);
  const who = holder ? `@${holder.username}` : "nobody";
  const stopped = released
    .map((r) => (r.actorId ? getUserById(app.db, r.actorId) : undefined))
    .filter((u) => u !== undefined)
    .map((u) => `@${u.username}`);
  insertComment(app.db, {
    issueId: issue.id,
    authorId: actorId,
    body: `Taken over by ${who}; stopped ${[...new Set(stopped)].join(", ") || "the earlier run"}.`,
  });
}

export function route(app: App, event: ForgeEvent): void {
  if (event.repoId === null) return;
  const number = event.payload["number"];
  const repo = getRepoById(app.db, event.repoId);
  if (!repo) return;

  switch (event.kind) {
    case "issue.assigned":
    case "pull.assigned": {
      if (typeof number !== "number") return;
      const issue = getIssue(app.db, repo.id, number);
      if (!issue) return;
      releaseOtherRuns(app, repo, issue, event.actorId);
      if (event.payload["agent"] !== true) return;
      const agent = issue.assigneeId
        ? getAgent(app.db, issue.assigneeId)
        : undefined;
      if (!agent || issue.state !== "open") return;
      // Assigned to a planner or a reviewer: said once, never silently run.
      if (outsideSeat(app, repo, issue, agent, "assigned")) {
        if (!listComments(app.db, issue.id).some((c) => c.body === NOT_A_BUILDER_NOTE))
          addComment(app, agent.user, repo, issue, NOT_A_BUILDER_NOTE);
        return;
      }
      queueAgentRun(
        app,
        repo,
        issue,
        agent,
        "assigned",
        event.actorId ?? undefined,
        undefined,
        typeof event.payload["variantGroup"] === "string"
          ? event.payload["variantGroup"]
          : undefined,
      );
      return;
    }
    case "issue.commented":
    case "pull.commented":
    case "pull.reviewed": {
      if (typeof number !== "number") return;
      if (event.payload["via"] === "origin") return;
      // The landing's own note goes to a person. Heard as the merger's word it
      // sends the builder back, whose push opens a pull that closes as already
      // on the base and writes the note again.
      const spoken = event.payload["body"];
      if (typeof spoken === "string" && spoken.startsWith(LANDED_LEAD)) return;
      const actor =
        event.actorId === null ? undefined : getUserById(app.db, event.actorId);
      if (!actor) return;
      // A run costs: an account whose email is unproven starts none by speaking.
      if (!emailVerified(app.db, actor.id)) return;
      // Agents talking is not feedback — except the crew's reviewer passing
      // a verdict on a pull, which is exactly what a person's review is.
      // Its line comments ride along with the verdict; the verdict alone
      // wakes the builder, once.
      const reviewerVerdict =
        actor.kind === "agent" &&
        event.kind === "pull.reviewed" &&
        typeof event.payload["state"] === "string" &&
        crewRole(app.db, repo.id, actor.id) === "reviewer";
      if (actor.kind === "agent" && event.kind === "pull.commented") {
        const pull = typeof number === "number" ? getIssue(app.db, repo.id, number) : undefined;
        if (pull && planAnotherRound(app, actor, repo, pull, event.payload["body"])) return;
      }
      if (actor.kind === "agent" && !reviewerVerdict) return;
      // A reader's words stay on the thread and do nothing more: on a
      // public repository anyone may comment, and a run spends the owner's
      // budget holding a write token (#619).
      if (!mayDirectCrew(app.db, repo, actor)) return;
      const issue = getIssue(app.db, repo.id, number);
      if (!issue || issue.state !== "open") return;
      if (
        event.kind === "pull.reviewed" &&
        event.payload["state"] === "approved"
      ) {
        // An approval, a person's or the reviewer's: the pull lands now,
        // not at the next sweep.
        const pull = getPull(app.db, repo.id, number);
        if (pull)
          landIfGreen(app, repo, pull).catch((error) =>
            log.warn("could not land after the review", {
              pull: number,
              error: String(error),
            }),
          );
        return;
      }
      // The crew is off: a verdict is read by people, and wakes no one.
      if (reviewerVerdict && repo.autonomy === "off") return;
      // The third changes-requested with no approval or person's word
      // between is a person's to answer: one card on the pull, and no
      // feedback run, now or for the verdicts after (`guard.ts`).
      if (reviewerVerdict && event.payload["state"] === "changes_requested") {
        const over = handoverOf(app.db, repo, issue.id);
        if (over !== undefined) {
          handOver(app, repo, issue, actor, over);
          return;
        }
      }
      const agent = agentFor(app, issue);
      if (!agent) return;
      // Said while the agent works: it hears the words now, as its next
      // turn, instead of a second run queuing up behind the first. A
      // session nobody can reach any more falls through to the queue.
      const said = event.payload["body"];
      const active = activeRunFor(app.db, "agent", issue.id, agent.user.id);
      if (
        active?.state === "running" &&
        typeof said === "string" &&
        said.trim() !== "" &&
        steerRun(
          app,
          active.id,
          `${actor.username} on #${issue.number}: ${said.trim()}`,
        )
      ) {
        // Heard now, by the run that works it: the next run's brief does
        // not tell it again (`news.ts`).
        const commentId = event.payload["commentId"];
        if (typeof commentId === "string")
          markHeard(app.db, commentId, active.id);
        return;
      }
      queueAgentRun(app, repo, issue, agent, "feedback", actor.id);
      return;
    }
    case "run.finished": {
      if (event.payload["kind"] === "agent") {
        // A builder's run that ends with nothing to show parks its issue.
        const issueId = event.payload["issueId"];
        const runId = event.payload["runId"];
        const finished =
          typeof runId === "string" ? getRun(app.db, runId) : undefined;
        if (typeof issueId === "string")
          settleAgentRun(app, repo, {
            issueId,
            state: String(event.payload["state"] ?? ""),
            summary: String(event.payload["summary"] ?? ""),
            reason: String(event.payload["reason"] ?? ""),
            actorId: finished?.actorId ?? null,
          });
        decideDeferred(app, repo);
        return;
      }
      if (
        event.payload["kind"] !== "deploy" &&
        event.payload["kind"] !== "check"
      )
        return;
      const issueId = event.payload["issueId"];
      if (typeof issueId !== "string") {
        if (event.payload["kind"] === "check")
          recheckWaiting(app, repo, event.payload["state"]);
        return;
      }
      const issue = getIssueById(app.db, issueId);
      if (!issue || issue.kind !== "pull" || issue.state !== "open") return;
      // A check's result is the outcome of the last "try again" decision.
      resolveOpen(
        app.db,
        issue.id,
        "retry",
        event.payload["state"] === "ok" ? "green" : "red",
      );
      // Green: an agent's pull goes to the crew's reviewer, and in a
      // repository that ships on green it lands (behind that review).
      if (event.payload["state"] === "ok") {
        const pull = getPull(app.db, repo.id, issue.number);
        if (!pull) return;
        if (repo.autonomy !== "autonomous") {
          if (pull.authorIsAgent && greenHead(app.db, pull))
            sendToReview(app, repo, pull).catch((error) =>
              log.error("sending to review failed", {
                pull: issue.number,
                error: String(error),
              }),
            );
          return;
        }
        landIfGreen(app, repo, pull).catch((error) =>
          log.error("landing on green failed", {
            pull: issue.number,
            error: String(error),
          }),
        );
        return;
      }
      if (event.payload["state"] !== "failed") return;
      // A preview that failed to deploy, or a check that failed: either
      // is the agent's to look at.
      const agent = agentFor(app, issue);
      if (!agent) return;
      // The builder's run is still at work on it: nothing is decided now,
      // and the failure is decided again when that run ends.
      if (builderAtWork(app, repo, issue)) {
        deferredFailures.set(issue.id, event);
        log.info("check failed while the builder's run is at work; deciding when it ends", {
          issue: issue.number,
        });
        return;
      }
      // A pull that does not merge is no failed try: the forge settles a
      // list-doc clash itself, else a bring-up-to-date run is queued. It
      // counts towards no limit and parks nothing (#7909).
      if (conflictSummary(app, event.payload["runId"])) {
        void bringUpAfterNoMerge(app, repo, issue, agent).catch((error) =>
          log.error("bringing a conflicted pull up to date failed", {
            issue: issue.number,
            error: String(error),
          }),
        );
        return;
      }
      // A red that main shares (#1971), or that three pulls share within
      // the hour (#2266), is not the pull's: no rework, no park, no
      // strike; it waits and is checked again when main is green.
      if (waitOnMain(app, repo, issue, event.payload)) return;
      // A red only on tests the diff does not reach (#7630) is checked once
      // more on the same head before a try is spent on it.
      const failedRun = typeof event.payload["runId"] === "string" ? getRun(app.db, event.payload["runId"]) : undefined;
      const outside = outsideDiffCandidate(app.db, app.config.dataDir, failedRun);
      if (outside === undefined) {
        answerRed(app, repo, issue, agent, event.payload);
        return;
      }
      void recheckOutsideDiff(app, repo, issue, event.payload, outside)
        .then((rechecked) => {
          if (!rechecked) answerRed(app, repo, issue, agent, event.payload);
        })
        .catch((error) =>
          log.error("a red outside the diff went unanswered", {
            issue: issue.number,
            error: String(error),
          }),
        );
      return;
    }
    case "pull.closed":
    case "pull.merged": {
      if (typeof number !== "number") return;
      const pull = getPull(app.db, repo.id, number);
      if (!pull) return;
      // Closed without landing: what came of the decisions about it. (A
      // merge writes its own outcome in the action, crew or no crew.)
      if (event.kind === "pull.closed") {
        resolveOpen(app.db, pull.id, "land", "closed");
        resolveOpen(app.db, pull.id, "retry", "closed");
      }
      // A run still at work on it has nothing left to land: it stops here.
      // Its clone is not pulled from under it — a run whose floor is gone
      // fails at its next git call — the runner lets the clone go itself,
      // once the run is over and the pull is not open.
      let atWork = false;
      for (const live of listActive(app.db, "agent")) {
        if (live.repoId !== repo.id) continue;
        if (live.issueId !== pull.id && live.branch !== pull.headBranch)
          continue;
        const cancelled = cancelRun(
          app.db,
          live.id,
          event.kind === "pull.merged" ? PULL_STOPPED[1] : PULL_STOPPED[0],
        );
        if (cancelled) announceRun(app, cancelled);
        if (live.state === "running") {
          abortAgentRun(live.id);
          atWork = true;
        }
      }
      if (!atWork) forgetWorkdir(app, repo, pull);
      return;
    }
    default:
      return;
  }
}

/**
 * A red that is the pull's to answer: parked once the automatic tries are
 * spent, else reworked — through the decider, when there is one.
 */
function answerRed(
  app: App,
  repo: Repo,
  issue: Issue,
  agent: Agent,
  payload: Record<string, unknown>,
): void {
  // Bounded: after a few failed checks in a row the agent stops and a
  // person must speak (docs/APPS.md, rule 7).
  const since = lastHumanWord(app, issue, agent);
  if (automaticRunsSince(app.db, issue.id, since) >= CHECK_FAILED_LIMIT) {
    const pull = getPull(app.db, repo.id, issue.number);
    if (
      pull &&
      parkPull(
        app,
        repo,
        pull,
        `the check stayed red through ${CHECK_FAILED_LIMIT} automatic tries`,
      )
    )
      return;
    log.info("check failed again; waiting for a person", {
      issue: issue.number,
    });
    return;
  }
  const runId = payload["runId"];
  // Without a decider the rule answers at once, and the rework queues
  // in the same tick the event landed — nothing waits on a promise.
  if (app.config.decider === undefined || typeof runId !== "string") {
    queueAgentRun(app, repo, issue, agent, "check_failed");
    return;
  }
  const commitOid = payload["commitOid"];
  const env = payload["env"];
  void answerFailedCheck(app, repo, issue, agent, {
    runId,
    kind: String(payload["kind"] ?? ""),
    commitOid: typeof commitOid === "string" ? commitOid : undefined,
    env: typeof env === "string" ? env : undefined,
    since,
  }).catch((error) =>
    log.error("a failed check went unanswered", {
      issue: issue.number,
      error: String(error),
    }),
  );
}

/**
 * The re-check of a red outside the diff, when the diff says it is one:
 * whether it was asked for (or the head moved on and the red is history).
 * `false` is today's answer: the red is the pull's.
 */
async function recheckOutsideDiff(
  app: App,
  repo: Repo,
  issue: Issue,
  payload: Record<string, unknown>,
  outside: { impact: Impact; failing: string[] },
): Promise<boolean> {
  const { commitOid, env } = payload;
  const checks = checksFor(app);
  const pull = getPull(app.db, repo.id, issue.number);
  if (checks === undefined || !pull || typeof commitOid !== "string" || typeof env !== "string")
    return false;
  const dir = await pullDir(app.db, app.reposRoot, repo, pull);
  const changed = await pullChanged(dir, pull, commitOid);
  const files = changed && redOutsideDiff(outside.failing, changed, outside.impact);
  if (files === undefined) return false;
  const now = getPull(app.db, repo.id, issue.number);
  // A push since then made a newer check; this red is history.
  if (!now || now.state !== "open" || now.headOid !== commitOid) return true;
  if (recheckedHead(app.db, issue.id, commitOid)) return false;
  const run = await checks.request(repo, env, commitOid, OUTSIDE_DIFF, issue.id);
  if (run === undefined) return false;
  if (run.reason === OUTSIDE_DIFF) appendRunLog(app.config.dataDir, run.id, recheckLine(files));
  log.info("check failed only outside the diff; checking the head once more", {
    issue: issue.number,
    files: files.join(", "),
  });
  return true;
}

/**
 * Failures that arrived while the builder's run was still at work on the
 * pull, by pull. Memory only: a restart forgets them, and the pull's next
 * push or a person's ask checks it again.
 */
const deferredFailures = new Map<string, ForgeEvent>();

/** Whether a build run on the pull's issue, or on an issue it closes, is queued or running. */
function builderAtWork(app: App, repo: Repo, pull: Issue): boolean {
  if (activeRunFor(app.db, "agent", pull.id) !== undefined) return true;
  const row = getPull(app.db, repo.id, pull.number);
  if (!row) return false;
  for (const number of closesFromBody(row.body)) {
    const about = getIssue(app.db, repo.id, number);
    if (about && activeRunFor(app.db, "agent", about.id) !== undefined)
      return true;
  }
  return false;
}

/** A run ended: decide again on the failures that waited for it, when they still stand. */
function decideDeferred(app: App, repo: Repo): void {
  for (const [issueId, event] of [...deferredFailures]) {
    if (event.repoId !== repo.id) continue;
    const issue = getIssueById(app.db, issueId);
    if (!issue || issue.state !== "open") {
      deferredFailures.delete(issueId);
      continue;
    }
    if (builderAtWork(app, repo, issue)) continue;
    deferredFailures.delete(issueId);
    const pull = getPull(app.db, repo.id, issue.number);
    const oid = event.payload["commitOid"];
    // A push since then made a newer check; this one is history.
    if (!pull || (typeof oid === "string" && oid !== pull.headOid)) continue;
    route(app, event);
  }
}

/**
 * Pulls whose check failed only on what main fails, or on what the lane
 * fails across pulls (`checks/shared_red.ts`), per repository, with
 * the head that was checked. Memory only: a restart forgets them, and the
 * pull's next push or a person's ask checks it again.
 */
const waitingOnMain = new Map<string, Map<string, { env: string; commitOid: string }>>();

/** Whether a failed check is main's red or the lane's, shared: if so, the pull is noted as waiting. */
function waitOnMain(
  app: App,
  repo: Repo,
  issue: Issue,
  payload: Record<string, unknown>,
): boolean {
  const { runId, commitOid, env } = payload;
  if (payload["kind"] !== "check" || typeof runId !== "string") return false;
  const run = getRun(app.db, runId);
  // The check machine's disk was full when it failed (#5453): the machine's red.
  if (diskRed(run)) {
    if (typeof commitOid === "string" && typeof env === "string") {
      const waiting = waitingOnDisk.get(app.db) ?? new Map();
      waiting.set(issue.id, { env, commitOid, repo });
      waitingOnDisk.set(app.db, waiting);
    }
    log.info("check failed while the check machine's disk was full; waiting for the disk", {
      issue: issue.number,
    });
    return true;
  }
  const main = sharedWithMain(redMain(app.db, repo.id), run);
  if (!main && !sharedWithPulls(app.db, run)) return false;
  if (typeof commitOid === "string" && typeof env === "string") {
    const waiting = waitingOnMain.get(repo.id) ?? new Map();
    waiting.set(issue.id, { env, commitOid });
    waitingOnMain.set(repo.id, waiting);
  }
  log.info(
    main
      ? "check failed only what main fails; waiting for main to be green"
      : "check failed only what other pulls fail this hour; waiting for main to be green",
    { issue: issue.number },
  );
  return true;
}

/** Pulls whose check failed on a full disk, per forge (database), so one forge's recheck never drops another's; memory only. */
const waitingOnDisk = new WeakMap<object, Map<string, { env: string; commitOid: string; repo: Repo }>>();

/** Once the disk is back above its floor, the pulls that waited for it are checked again. */
export function recheckForDisk(app: App): void {
  const waiting = waitingOnDisk.get(app.db);
  if (waiting === undefined || waiting.size === 0 || !diskRecovered(app.config.dataDir)) return;
  const checks = checksFor(app);
  if (checks === undefined) return;
  waitingOnDisk.delete(app.db);
  for (const [issueId, head] of waiting) {
    const issue = getIssueById(app.db, issueId);
    const pull = issue ? getPull(app.db, head.repo.id, issue.number) : undefined;
    if (!pull || pull.state !== "open" || pull.headOid !== head.commitOid) continue;
    void checks
      .request(head.repo, head.env, head.commitOid, "retry", issueId)
      .catch((error) =>
        log.warn("a pull waiting for the disk could not be checked again", { issue: issue?.number, error: String(error) }),
      );
  }
}

/** Main's check finished: when it passed, the pulls that waited are checked again. */
function recheckWaiting(app: App, repo: Repo, state: unknown): void {
  const waiting = waitingOnMain.get(repo.id);
  if (state !== "ok" || waiting === undefined) return;
  waitingOnMain.delete(repo.id);
  const checks = checksFor(app);
  if (checks === undefined) return;
  for (const [issueId, head] of waiting) {
    const issue = getIssueById(app.db, issueId);
    const pull = issue ? getPull(app.db, repo.id, issue.number) : undefined;
    if (!pull || pull.state !== "open" || pull.headOid !== head.commitOid) continue;
    void checks
      .request(repo, head.env, head.commitOid, "retry", issueId)
      .catch((error) =>
        log.warn("a waiting pull could not be checked again", { issue: issue?.number, error: String(error) }),
      );
  }
}

/** Checks already run again once for a head; a second red is real. */
const retriedChecks = new Set<string>();

/** What a failed check led to, once the crew had read it. */
export type CheckAnswer = "reran" | "reworked" | "parked" | "waiting";

/**
 * A failed check, answered. The cause is established *before* the pull is
 * parked, because the two questions are one decision (`judgeFailedCheck`):
 *
 * - the environment's fault — a timeout, a flaky runner, a full disk — and
 *   the check runs again, once for that commit, without spending the
 *   agent's tries. A stop on that would throw away a change nobody has
 *   found fault with.
 * - otherwise the agent reworks it. The try limit (`CHECK_FAILED_LIMIT`) is
 *   what parks a pull: one red, or one model's guess, never does.
 */
export async function answerFailedCheck(
  app: App,
  repo: Repo,
  issue: Issue,
  agent: Agent,
  failed: {
    readonly runId: string;
    readonly kind: string;
    readonly commitOid?: string | undefined;
    readonly env?: string | undefined;
    /** When a person last spoke: what the tries are counted from. */
    readonly since: string;
  },
): Promise<CheckAnswer> {
  const judged = await judgeFailedCheck(
    app,
    repo,
    issue,
    failed.runId,
    failed.since,
  );
  const head = `${issue.id}:${failed.commitOid ?? ""}`;
  const checks = checksFor(app);
  if (
    judged.cause === "environment" &&
    failed.kind === "check" &&
    checks !== undefined &&
    failed.commitOid !== undefined &&
    failed.env !== undefined &&
    !retriedChecks.has(head)
  ) {
    retriedChecks.add(head);
    log.info("check looked like the environment's fault; running it again", {
      issue: issue.number,
      retry: judged.retry,
    });
    await checks
      .request(repo, failed.env, failed.commitOid, "retry", issue.id)
      .catch((error) =>
        log.warn("the check could not be run again", {
          issue: issue.number,
          error: String(error),
        }),
      );
    return "reran";
  }
  queueAgentRun(app, repo, issue, agent, "check_failed");
  return "reworked";
}

export function agentFor(app: App, issue: Issue): Agent | undefined {
  if (issue.assigneeId !== null) {
    const assigned = getAgent(app.db, issue.assigneeId);
    if (assigned) return assigned;
    // A person holds it: nothing the agent's name is on starts a run.
    return undefined;
  }
  return issue.kind === "pull" ? getAgent(app.db, issue.authorId) : undefined;
}

/** What the crew makes of a red check: whose fault, and whether to try again. */
export interface CheckJudgement {
  /** Whether another automatic try by the agent is worth its cost. */
  readonly retry: "again" | "stop";
  /** Whose fault the failure is, from the tail of the check's log. */
  readonly cause: "change" | "environment" | "base";
  /** The failing test's own name, when the run's output named one. */
  readonly failingTest: string | undefined;
}

const RETRY_OPTIONS = ["again", "stop"];
const CAUSE_OPTIONS = ["change", "environment", "base"];

/**
 * Whose fault the failure is, and whether to try again — asked together,
 * of one log tail, in one round trip, because the answers are only useful
 * together: a `stop` on a flaky runner throws away a change that is fine,
 * and an `again` on a broken environment reworks code that is not at
 * fault. The rule says the change's fault and another try, up to the
 * limit; the decider reads the failure, the log's tail and the count and
 * may know better. `retry` is the answer the ledger keeps (the next
 * check's result is its outcome); `cause` rides along.
 */
export async function judgeFailedCheck(
  app: App,
  repo: Repo,
  issue: Issue,
  runId: string,
  since: string,
): Promise<CheckJudgement> {
  const run = getRun(app.db, runId);
  const failingTest = run?.checkDetail?.names[0];
  // A shard that ran out of temp space is the machine's, whatever a decider
  // might guess: the check runs again without spending the agent's tries.
  if (run?.checkDetail?.environment === TEMP_FULL)
    return { retry: "again", cause: "environment", failingTest };
  if (app.config.decider === undefined)
    return { retry: "again", cause: "change", failingTest };
  // A pull that does not merge is the change's, whatever a decider might
  // guess: the builder is handed it to rebase.
  if (run?.summary.includes(NO_MERGE))
    return { retry: "again", cause: "change", failingTest };
  const tail = readRunLog(app.config.dataDir, runId, 8 * 1024).lines.slice(-25);
  const decided = await decideAndRecord(
    app,
    { kind: "retry", repo, issue },
    {
      direction: repo.autonomyDirection,
      pull: { number: issue.number, title: issue.title },
      tries: automaticRunsSince(app.db, issue.id, since),
      limit: CHECK_FAILED_LIMIT,
      check: {
        kind: run?.kind ?? "check",
        summary: run?.summary ?? "",
        // What the check's own output said, parsed once when it finished
        // (`checks/bun-test.ts`): one red name beside 274 green ones reads
        // very differently from a suite that is red all through, and that
        // difference is most of what `cause` turns on.
        ...(run?.checkDetail == null ? {} : { failing: run.checkDetail }),
      },
      log: tail,
    },
    {
      retry: {
        options: RETRY_OPTIONS,
        about:
          "The check failed. Is another automatic try by the agent worth its cost, or should a person look?",
        describe: {
          again:
            "Try again: the failure reads as something the agent can fix from the log.",
          stop: "Stop: the failure repeats an earlier one, or is beyond what another run would fix.",
        },
      },
      cause: {
        options: CAUSE_OPTIONS,
        about:
          "Why the repository's check failed, judging from the end of its log.",
        describe: {
          change:
            "The code under test is wrong: a failing assertion, a type error, a bug the change introduced.",
          environment:
            "The place it ran failed, not the code: a timeout, a network error, a missing tool, a flaky runner, a full disk.",
          base: "The base branch itself is broken; the change is not what fails.",
        },
      },
    },
    () => ({
      retry: certain(RETRY_OPTIONS, "again"),
      cause: certain(CAUSE_OPTIONS, "change"),
    }),
  );
  // A stop is a pull closed on a person's behalf: it takes the same
  // confidence as a cause. Below it the builder gets its one more try.
  const retry =
    decided.answers.retry.choice === "stop" && decided.answers.retry.p >= 0.7
      ? "stop"
      : "again";
  // The change is what a half-sure answer means: an environment called
  // that way on a hunch is how a broken change escapes a rework.
  const cause =
    decided.answers.cause.p >= 0.7
      ? (decided.answers.cause.choice as CheckJudgement["cause"])
      : "change";
  if (retry === "stop")
    log.info("check failed; the decider stopped here for a person", {
      issue: issue.number,
      by: decided.by,
      p: decided.answers.retry.p.toFixed(2),
      cause,
    });
  return { retry, cause, failingTest };
}

/** When a person last said anything on the conversation, or its start. */
export function lastHumanWord(app: App, issue: Issue, agent: Agent): string {
  let latest = issue.createdAt;
  for (const c of listComments(app.db, issue.id)) {
    if (c.authorName !== agent.user.username && c.createdAt > latest)
      latest = c.createdAt;
  }
  for (const r of listReviews(app.db, issue.id)) {
    if (r.authorName !== agent.user.username && r.createdAt > latest)
      latest = r.createdAt;
  }
  return latest;
}

function forgetWorkdir(app: App, repo: Repo, pull: Pull): void {
  const agent = agentFor(app, pull);
  if (!agent) return;
  const number = issueOfBranch(agent, pull.headBranch) ?? pull.number;
  rmSync(workdirFor(app.config.dataDir, agent, repo, number), {
    recursive: true,
    force: true,
  });
}

/**
 * A run a dead forge left `running` was cut off with it: its lease has
 * lapsed. Each ends here as cancelled, and the same task goes back on the
 * queue under the same reason — the run that starts reads the whole
 * conversation, so nothing a person said is lost. A run whose lease is
 * fresh is being worked by a forge still alive beside this one — the old
 * process of a release, finishing — and is left to it: that forge queues
 * the task again itself when it stops. Runs at boot and on every tick: a
 * forge that fell and was back within the lease sees its runs lapse later.
 */
function requeueInterrupted(app: App): void {
  for (const run of listActive(app.db, "agent")) {
    if (run.state === "running" && leaseLapsed(run, STALE_AFTER_MS))
      requeue(app, run, "interrupted by a restart; queued again");
  }
}

/** End a run that cannot go on, and put its task back on the queue. */
function requeue(app: App, run: Run, why: string): void {
  cancelRun(app.db, run.id, why);
  const task = taskOf(app, run);
  if (task === undefined) return;
  // The run that starts carries on in the clone this one left, in the
  // same session — an interruption is a pause, not a fresh start.
  queueAgentRun(
    app,
    task.repo,
    task.issue,
    task.agent,
    task.reason,
    undefined,
    {
      notBefore: new Date().toISOString(),
      attempt: run.attempt + 1,
      summary: `${why}; carries on where it stopped`,
    },
  );
  log.info("run queued again", { run: run.id, reason: task.reason, why });
}

/**
 * A paused run's task goes back on the queue for the moment the provider
 * said its limit lifts; the run that starts then resumes the session in
 * the clone the paused one left.
 */
function resumeLater(app: App, run: Run, pause: Pause): void {
  const task = taskOf(app, run);
  if (task === undefined) return;
  const queued = queueAgentRun(
    app,
    task.repo,
    task.issue,
    task.agent,
    task.reason,
    undefined,
    {
      notBefore: pause.resumeAt,
      attempt: pause.attempt,
      summary:
        pause.summary ??
        `paused on the provider's limit; resumes ${whenText(new Date(pause.resumeAt))}`,
    },
  );
  log.info("run paused", {
    run: run.id,
    until: pause.resumeAt,
    attempt: pause.attempt,
    queued: queued?.id,
  });
}

/** The still-open task a run was about, and the reason to queue it under again. */
export function taskOf(
  app: App,
  run: Run,
): { issue: Issue; repo: Repo; agent: Agent; reason: RunReason } | undefined {
  if (run.issueId === null) return undefined;
  const issue = getIssueById(app.db, run.issueId);
  const repo = getRepoById(app.db, run.repoId);
  const agent = run.actorId ? getAgent(app.db, run.actorId) : undefined;
  if (!issue || !repo || !agent || issue.state !== "open") return undefined;
  const reason: RunReason =
    run.reason === "feedback" ||
    run.reason === "check_failed" ||
    run.reason === "conflict" ||
    run.reason === "resolve" ||
    run.reason === "converge" ||
    run.reason === "review"
      ? run.reason
      : "assigned";
  return { issue, repo, agent, reason };
}

/**
 * Who last assigned it: the newest `issue.assigned` or `pull.assigned`. The
 * `+ 0` drops the column's affinity so the event expression index
 * (`event_repo_kind_number_at`) answers it, never a scan of `event`. `INDEXED BY` makes
 * the plan a promise: if that index is dropped or renamed this query fails to prepare
 * (test/stall-scans.test.ts catches it) instead of quietly scanning.
 */
const ASSIGNER_SQL = `(SELECT e.actor_id FROM event e INDEXED BY event_repo_kind_number_at
                WHERE e.repo_id = issue.repo_id AND e.kind = issue.kind || '.assigned'
                  AND json_extract(e.payload, '$.number') = issue.number + 0
                ORDER BY e.id DESC LIMIT 1)`;

export const SWEEP_ASSIGNED_SQL = `SELECT issue.id, issue.repo_id FROM user
       CROSS JOIN issue ON issue.assignee_id = user.id AND issue.state = 'open'
       WHERE user.is_agent = 1
         -- A pull an agent opened starts assigned to it; that is its own
         -- work landing, not a task waiting for a run.
         AND NOT (issue.kind = 'pull' AND issue.author_id = issue.assignee_id)
         AND NOT EXISTS (SELECT 1 FROM run WHERE run.issue_id = issue.id AND run.kind = 'agent')
         -- In the query, not after it: a guest's issues never take one of
         -- the hundred places, however many of them wait.
         AND NOT ${guestSql(ASSIGNER_SQL)}
       ORDER BY issue.id LIMIT 100`;

/**
 * The sweep behind the wake-up: an open issue assigned to an agent that
 * has never had a run (assigned while the crew was off) gets one now —
 * unless the person who last assigned it is a guest. The assignment is
 * theirs to pay for, and an issue a guest assigned before the guard existed
 * would otherwise start the run the guard refuses them. An assignment with
 * no event (made by the crew itself) is the crew's, as before.
 */
export function sweepAssigned(app: App): void {
  const rows = app.db.query<{ id: string; repo_id: string }, []>(SWEEP_ASSIGNED_SQL).all();
  for (const row of rows) {
    const issue = getIssueById(app.db, row.id);
    const repo = getRepoById(app.db, row.repo_id);
    const agent = issue?.assigneeId
      ? getAgent(app.db, issue.assigneeId)
      : undefined;
    if (issue && repo && agent)
      queueAgentRun(app, repo, issue, agent, "assigned");
  }
}

/**
 * Whether the run's newest assignment was a person's (`assignIssue` marks it
 * `person`; the tick's own pick says `pick`). An assignment event without
 * either mark was written before the marks existed and counts as a pick.
 */
export function assignedByPerson(app: App, run: Run): boolean {
  if (run.issueId === null) return false;
  const row = app.db
    .query<{ person: number | null }, [string]>(
      `SELECT json_extract(e.payload, '$.person') AS person FROM event e INDEXED BY event_repo_kind_number_at
         JOIN issue ON issue.repo_id = e.repo_id AND e.kind = issue.kind || '.assigned'
          AND json_extract(e.payload, '$.number') = issue.number + 0
        WHERE issue.id = ? ORDER BY e.id DESC LIMIT 1`,
    )
    .get(run.issueId);
  return row?.person === 1;
}

/**
 * A review, or work a person assigned: the runs the pace leaves a floor for.
 * `memo` holds the answer per run for one pump pass, so the events are read
 * once for each run, and only for `assigned` ones.
 */
export function isPriorityRun(app: App, run: Run, memo?: Map<string, boolean>): boolean {
  if (!PRIORITY_REASONS.includes(run.reason)) return false;
  if (run.reason !== "assigned") return true;
  const known = memo?.get(run.id);
  if (known !== undefined) return known;
  const person = assignedByPerson(app, run);
  memo?.set(run.id, person);
  return person;
}

/** Per app, the runs already told why they wait, so the log says it once. */
const notedBy = new WeakMap<App, Set<string>>();

/**
 * The order queued agent runs are started in: the team dials first, then bugs
 * ahead of everything (#8709), then the valves a person turned. A bug outranks the dials by policy: the clock
 * is a promise, the dials a share of the rest.
 */
export function startOrder(app: App): ReturnType<typeof gateQueue> {
  return gateQueue(app.db, bugsFirst(app.db, byDials(app.db, listQueued(app.db, "agent", 50))));
}

/** Take queued runs, oldest first, up to the limit — one per issue at a time. */
function pump(
  app: App,
  options: CrewOptions,
  inFlight: Map<string, Promise<void>>,
): void {
  const active = listActive(app.db, "agent");
  const runningIssues = new Set(
    active.filter((r) => r.state === "running").map((r) => r.issueId),
  );
  // Read on every pump (`core/capacity.ts`): an admin's change is the next
  // pick's, not the next boot's. `options.concurrency` is the boot default.
  let slots =
    capacityCount(app.db, "crew.concurrency", options.concurrency) -
    runningIssues.size;
  const started: string[] = [];
  const goingIn = new Map<string, number>();
  const priorityIn = new Map<string, number>();
  const priorityMemo = new Map<string, boolean>();
  const noted = notedBy.get(app) ?? new Set<string>();
  notedBy.set(app, noted);
  // Builder starts go to teams in proportion to their dials (`team_share.ts`),
  // then through the valves a person turned (`flow/valve_gate.ts`).
  const gated = startOrder(app);
  for (const shut of gated.held) {
    if (noted.has(shut.id)) continue;
    noted.add(shut.id);
    appendRunLog(app.config.dataDir, shut.id, "queued, not started: its repository's valve is shut (/flow)");
  }
  for (const queued of gated.order) {
    if (queued.issueId !== null && runningIssues.has(queued.issueId)) continue;
    const fresh = getRun(app.db, queued.id);
    if (!fresh || fresh.state !== "queued") continue;
    // A fresh run queued before Archive is cancelled, not started, and
    // stays cancelled through Wake. One carrying on after a pause or a
    // restart (attempt > 0) is already going, and finishes.
    const home = getRepoById(app.db, fresh.repoId);
    if (fresh.attempt === 0 && home !== undefined && home.archivedAt !== null) {
      const cancelled = cancelRun(app.db, fresh.id, ARCHIVED_WHY);
      if (cancelled) {
        appendRunLog(app.config.dataDir, fresh.id, ARCHIVED_WHY);
        announceRun(app, cancelled);
      }
      continue;
    }
    if (slots <= 0) break;
    // The week's pace holds every path that starts a run in an autonomous
    // repository: assigned, review, feedback and check runs as much as picks (#8873).
    if (home !== undefined && home.autonomy === "autonomous") {
      const going = (goingIn.get(home.id) ?? 0) + active.filter((r) => r.state === "running" && r.repoId === home.id).length;
      const priorityGoing =
        (priorityIn.get(home.id) ?? 0) +
        active.filter((r) => r.state === "running" && r.repoId === home.id && isPriorityRun(app, r, priorityMemo)).length;
      const held = weekHold(weekFor(app, home, new Date()), home.autonomySlots, going - priorityGoing, isPriorityRun(app, fresh, priorityMemo) ? fresh.reason : "pick", priorityGoing, paceFloor(app.db));
      if (held !== null) {
        if (!noted.has(fresh.id)) {
          noted.add(fresh.id);
          appendRunLog(app.config.dataDir, fresh.id, held);
        }
        continue;
      }
    }
    // An account at its concurrent-runs limit keeps this run queued, with
    // the count in its log once, until one of its runs ends.
    const owner = getRepoById(app.db, fresh.repoId)?.ownerId;
    const full =
      owner === undefined
        ? undefined
        : runningLimitSentence(app.db, "runs", "concurrent runs", owner, () =>
            runningRuns(app.db, "agent", owner, [...inFlight.keys(), ...started]),
          );
    if (full !== undefined) {
      if (!noted.has(fresh.id)) {
        noted.add(fresh.id);
        appendRunLog(app.config.dataDir, fresh.id, `queued, not started: ${full}`);
      }
      continue;
    }
    started.push(fresh.id);
    goingIn.set(fresh.repoId, (goingIn.get(fresh.repoId) ?? 0) + 1);
    if (isPriorityRun(app, fresh, priorityMemo)) priorityIn.set(fresh.repoId, (priorityIn.get(fresh.repoId) ?? 0) + 1);
    noted.delete(fresh.id);
    slots--;
    if (queued.issueId !== null) runningIssues.add(queued.issueId);
    const running = executeAgentRun(app, fresh, options)
      .then((pause) => {
        if (pause !== undefined) resumeLater(app, fresh, pause);
      })
      .catch((error) =>
        log.error("agent run failed to execute", {
          run: queued.id,
          error: String(error),
        }),
      )
      .finally(() => inFlight.delete(queued.id));
    inFlight.set(queued.id, running);
  }
}
