/**
 * How work reaches the crew. The dispatcher listens to the outbox and
 * sweeps behind it: an issue assigned to an agent becomes a run; a person
 * speaking on an agent's pull — a comment, a verdict, a line comment —
 * becomes a follow-up; a failed deploy of an agent's pull becomes a
 * bounded follow-up. Runs are rows first (`queued`), and a worker tick
 * takes them in order up to the concurrency limit, one per issue at a
 * time. A missed wake-up costs a tick, never a run.
 */

import { rmSync } from "node:fs";
import type { App } from "../app.ts";
import { announceRun } from "../actions/runs.ts";
import { crewRole, getAgent, type Agent } from "../core/agents.ts";
import type { ForgeEvent } from "../core/events.ts";
import {
  getIssue,
  getIssueById,
  addComment as insertComment,
  listComments,
  type Issue,
} from "../core/issues.ts";
import { getPull, type Pull } from "../core/pulls.ts";
import { resolveOpen } from "../core/decisions.ts";
import { decideAndRecord } from "./ledger.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import { listReviews } from "../core/reviews.ts";
import {
  activeRunFor,
  hasQueuedRun,
  automaticRunsSince,
  cancelRun,
  createRun,
  getRun,
  leaseLapsed,
  listActive,
  listQueued,
  type Run,
} from "../core/runs.ts";
import { getUserById } from "../core/users.ts";
import { createLog } from "../kernel/log.ts";
import { issueOfBranch, type RunReason } from "./brief.ts";
import { detectClaude } from "./claude.ts";
import { followDivergence } from "./converge.ts";
import { breakerTripped } from "./breaker.ts";
import { sandboxAvailable } from "./sandbox.ts";
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
  const sandbox = await sandboxAvailable();
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
  // Repositories that run on their own take a turn once a minute, on the
  // same clock as the pump, so a pick becomes a run on the next tick.
  let lastAutonomy = 0;
  const timer = setInterval(() => {
    if (stopped) return;
    requeueInterrupted(app);
    if (Date.now() - lastAutonomy >= AUTONOMY_TICK_MS) {
      lastAutonomy = Date.now();
      autonomyTick(app).catch((error) =>
        log.error("autonomy tick failed", { error: String(error) }),
      );
    }
    pump(app, ready, inFlight);
  }, TICK_MS);
  requeueInterrupted(app);
  sweep(app);
  pump(app, ready, inFlight);

  const handle: CrewHandle = {
    ready: detected.ok,
    sandbox: { enforced: sandbox.ok, reason: sandbox.ok ? "" : sandbox.reason },
    detail: detected.ok ? `Claude Code ${detected.version}` : detected.error,
    stop: async (options = {}) => {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
      unfollow();
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

/** Queue a run about an issue for an agent, unless one is already waiting. */
export function queueAgentRun(
  app: App,
  repo: Repo,
  issue: Issue,
  agent: Agent,
  reason: RunReason,
  actorId?: string,
  again?: { notBefore: string; attempt: number; summary: string },
): Run | undefined {
  // The day's ceiling gates every run the crew starts on its own, not only
  // the picks: a review, a feedback run or a conflict run past the ceiling
  // is money the person did not agree to. A person's own assignment is not
  // the crew's.
  if (
    reason !== "assigned" &&
    repo.autonomy === "autonomous" &&
    spentToday(app.db, repo.id) >= repo.autonomyCeilingUsd
  ) {
    log.info("at the ceiling; not queued", {
      repo: `${repo.ownerName}/${repo.name}`,
      issue: issue.number,
      reason,
    });
    return undefined;
  }
  // Three failed or declined runs in an hour: parked, until a person speaks.
  if (breakerTripped(app.db, issue.id)) {
    parkForBreaker(app, repo, issue, agent);
    return undefined;
  }
  const active = activeRunFor(app.db, "agent", issue.id);
  // One queued follow-up is enough: the run that eventually starts reads
  // the whole conversation since the last one, so nothing is lost. The
  // queued one may sit behind a running one, so it is looked for by itself.
  if (
    active !== undefined &&
    (reason === "assigned" || hasQueuedRun(app.db, "agent", issue.id))
  )
    return undefined;
  const run = createRun(app.db, {
    repoId: repo.id,
    kind: "agent",
    issueId: issue.id,
    actorId: agent.user.id,
    reason,
    ...again,
  });
  announceRun(app, run, actorId);
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

function route(app: App, event: ForgeEvent): void {
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
      queueAgentRun(
        app,
        repo,
        issue,
        agent,
        "assigned",
        event.actorId ?? undefined,
      );
      return;
    }
    case "issue.commented":
    case "pull.commented":
    case "pull.reviewed": {
      if (typeof number !== "number") return;
      if (event.payload["via"] === "origin") return;
      const actor =
        event.actorId === null ? undefined : getUserById(app.db, event.actorId);
      if (!actor) return;
      // Agents talking is not feedback — except the crew's reviewer passing
      // a verdict on a pull, which is exactly what a person's review is.
      const reviewerVerdict =
        actor.kind === "agent" &&
        event.kind === "pull.reviewed" &&
        crewRole(app.db, repo.id, actor.id) === "reviewer";
      if (actor.kind === "agent" && !reviewerVerdict) return;
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
      const agent = agentFor(app, issue);
      if (!agent) return;
      // Said while the agent works: it hears the words now, as its next
      // turn, instead of a second run queuing up behind the first. A
      // session nobody can reach any more falls through to the queue.
      const said = event.payload["body"];
      const active = activeRunFor(app.db, "agent", issue.id);
      if (
        active?.state === "running" &&
        typeof said === "string" &&
        said.trim() !== "" &&
        steerRun(
          app,
          active.id,
          `${actor.username} on #${issue.number}: ${said.trim()}`,
        )
      )
        return;
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
        return;
      }
      if (
        event.payload["kind"] !== "deploy" &&
        event.payload["kind"] !== "check"
      )
        return;
      const issueId = event.payload["issueId"];
      if (typeof issueId !== "string") return;
      const issue = getIssueById(app.db, issueId);
      if (!issue || issue.kind !== "pull" || issue.state !== "open") return;
      // A check's result is the outcome of the last "try again" decision.
      resolveOpen(
        app.db,
        issue.id,
        "retry",
        event.payload["state"] === "ok" ? "green" : "red",
      );
      // Green, in a repository that ships on green: land it.
      if (event.payload["state"] === "ok") {
        if (repo.autonomy !== "autonomous") return;
        const pull = getPull(app.db, repo.id, issue.number);
        if (!pull) return;
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
      const runId = event.payload["runId"];
      // Without a decider the rule answers at once, and the rework queues
      // in the same tick the event landed — nothing waits on a promise.
      if (app.config.decider === undefined || typeof runId !== "string") {
        queueAgentRun(app, repo, issue, agent, "check_failed");
        return;
      }
      const commitOid = event.payload["commitOid"];
      const env = event.payload["env"];
      void answerFailedCheck(app, repo, issue, agent, {
        runId,
        kind: String(event.payload["kind"] ?? ""),
        commitOid: typeof commitOid === "string" ? commitOid : undefined,
        env: typeof env === "string" ? env : undefined,
        since,
      }).catch((error) =>
        log.error("a failed check went unanswered", {
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
          event.kind === "pull.merged" ? "the pull landed" : "the pull closed",
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
 * - `stop` — the pull is parked, with a reason that says which of the two
 *   it was, so the next reader (and the planner) can tell a change that
 *   failed from a change that was unlucky. The re-run is bounded by
 *   `retriedChecks`: a permanently broken runner parks on the second red.
 * - `again` — the agent reworks it, as ever.
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
  if (judged.retry === "stop") {
    // The decider's stop is the crew's stop: parked, never waiting, in a
    // repository on its own.
    const pull = getPull(app.db, repo.id, issue.number);
    if (
      pull &&
      parkPull(app, repo, pull, parkedReason(judged, failed.kind, head))
    )
      return "parked";
    log.info("check failed; waiting for a person", { issue: issue.number });
    return "waiting";
  }
  queueAgentRun(app, repo, issue, agent, "check_failed");
  return "reworked";
}

/**
 * Why a parked pull was parked, in the two cases a reader must tell apart:
 * a change that failed, and a change that was unlucky. It names what
 * failed too — a preview that would not boot is not a red test.
 */
function parkedReason(
  judged: CheckJudgement,
  kind: string,
  head: string,
): string {
  const what = kind === "deploy" ? "the preview's deploy" : "the check";
  if (judged.cause !== "environment") {
    const named =
      judged.failingTest === undefined ? "" : ` ("${judged.failingTest}")`;
    return `${what} failed${named} and the decider saw no point in another try`;
  }
  return retriedChecks.has(head)
    ? `${what} failed in the place it ran, not in the change, and failed the same way when it was run again`
    : `${what} failed in the place it ran, not in the change, and it could not be run again`;
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
  if (app.config.decider === undefined)
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
  const retry = decided.answers.retry.choice === "stop" ? "stop" : "again";
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
      summary: `paused on the provider's limit; resumes ${whenText(new Date(pause.resumeAt))}`,
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
function taskOf(
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
    run.reason === "converge" ||
    run.reason === "review"
      ? run.reason
      : "assigned";
  return { issue, repo, agent, reason };
}

/**
 * The sweep behind the wake-up: an open issue assigned to an agent that
 * has never had a run (assigned while the crew was off) gets one now.
 */
function sweep(app: App): void {
  const rows = app.db
    .query<{ id: string; repo_id: string }, []>(
      `SELECT issue.id, issue.repo_id FROM issue
       JOIN user ON user.id = issue.assignee_id AND user.is_agent = 1
       WHERE issue.state = 'open'
         -- A pull an agent opened starts assigned to it; that is its own
         -- work landing, not a task waiting for a run.
         AND NOT (issue.kind = 'pull' AND issue.author_id = issue.assignee_id)
         AND NOT EXISTS (SELECT 1 FROM run WHERE run.issue_id = issue.id AND run.kind = 'agent')
       ORDER BY issue.id LIMIT 100`,
    )
    .all();
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
  let slots = options.concurrency - runningIssues.size;
  for (const queued of listQueued(app.db, "agent", 50)) {
    if (slots <= 0) break;
    if (queued.issueId !== null && runningIssues.has(queued.issueId)) continue;
    const fresh = getRun(app.db, queued.id);
    if (!fresh || fresh.state !== "queued") continue;
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
