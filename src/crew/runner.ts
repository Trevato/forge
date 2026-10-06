/**
 * One agent run, end to end: claim it, mint a credential that dies with
 * it, put the agent in a clone on the right branch, tell it the task, let
 * Claude Code work, then do the bookkeeping the agent should never have to
 * get right — push what it committed, open or update the pull, report on
 * the issue — and record the outcome.
 *
 * The clone lives at `<data>/crew/<agent>/<repo id>/<issue n>/` for as long
 * as the pull is open, so a follow-up resumes the same session in the same
 * tree. The remote is truth: every run starts by resetting the branch to
 * what the forge has.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app.ts";
import { addComment } from "../actions/issues.ts";
import { openPull } from "../actions/pulls.ts";
import { forkRepo } from "../actions/repos.ts";
import { announceRun } from "../actions/runs.ts";
import { previewEnv } from "../apps/data.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { crewRole, getAgent, type Agent } from "../core/agents.ts";
import { getAppByRepo, type AppRecord } from "../core/apps.ts";
import {
  getIssue,
  getIssueById,
  labelsForIssues,
  listComments,
  type Issue,
} from "../core/issues.ts";
import { getPull, listPulls, type Pull } from "../core/pulls.ts";
import {
  canWrite,
  getForkOf,
  getRepoById,
  type Repo,
} from "../core/repos.ts";
import { getUserById } from "../core/users.ts";
import {
  listReviewComments,
  listReviews,
  type Review,
} from "../core/reviews.ts";
import {
  cancelRun,
  checkSummary,
  claimRun,
  finishRun,
  lastAgentRun,
  noteRunProgress,
  type Run,
} from "../core/runs.ts";
import { createToken, deleteToken } from "../core/tokens.ts";
import { runGit } from "../git/env.ts";
import { isSafeRef } from "../git/guard.ts";
import { runGitCapture } from "../git/env.ts";
import { looksForEnv } from "../core/looks.ts";
import { aheadCount, resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { createLog, redactValues } from "../kernel/log.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { holdLease } from "../runs/lease.ts";
import { appendRunLog, readRunLog } from "../runs/log.ts";
import {
  branchFor,
  issueOfBranch,
  systemPrompt,
  taskPrompt,
  wrapUpPrompt,
  type RunReason,
} from "./brief.ts";
import { policyBrief } from "../contract/audit.ts";
import { BUDGET_REACHED, runClaude, type ClaudeOutcome } from "./claude.ts";
import {
  isRateLimited,
  limitOf,
  MAX_PAUSES,
  resumeAt,
  whenText,
} from "./limits.ts";
import { interruptedSummary } from "./interrupted.ts";
import { laterGate } from "./later.ts";
import { parkedTwice } from "./parks.ts";
import { noteLimit } from "../core/standing.ts";
import { pauseReason } from "./pacing.ts";
import {
  pickSubscription,
  PLATFORM,
  restSubscription,
  type Pick,
} from "../core/subscriptions.ts";
import {
  recordUsage,
  type UsageKind,
  type UsageOutcome,
} from "../core/usage.ts";
import { trackAgentRun, untrackAgentRun } from "./running.ts";
import { sandboxPolicy } from "./sandbox.ts";
import { grantSecrets, parseDeclaration, type Grant } from "./grant.ts";
import { historyHolds, scrubTree } from "./leak.ts";
import { workdirFor } from "./workdir.ts";
import { readersAmong, voiceOf } from "./direct.ts";
import { feedbackSince } from "./news.ts";
import { SKIP_SUMMARY, skipsFeedback } from "./guard.ts";

const log = createLog("crew");

export interface CrewOptions {
  /** The forge's public URL — what the agent is told and links to. */
  readonly forgeUrl: string;
  /** Where the forge answers on this machine — what git clones from. */
  readonly localUrl: string;
  readonly binary: string;
  readonly concurrency: number;
  /** Spend per run when the agent's own budget is 0. */
  readonly budgetUsd: number;
  readonly runTimeoutMs: number;
  /** A `CLAUDE_CONFIG_DIR` for runs, when the operator wants one. */
  readonly configDir?: string | undefined;
  /** Hosts an agent's shell may reach beyond the forge and the registry. */
  readonly allowHosts?: readonly string[] | undefined;
  /** Whether this host can enforce the shell sandbox (`sandboxAvailable`). */
  readonly sandboxEnforced?: boolean | undefined;
  /** Why it cannot, when it cannot — said once in every run's log. */
  readonly sandboxNote?: string | undefined;
}

export { crewRoot, workdirFor } from "./workdir.ts";

/** Runs with an agent listening: what a person says reaches it next. */
const steering = new Map<string, (text: string) => boolean>();

/**
 * Say something to an agent while its run goes. Written to the run's log
 * as the person's line first, so the record holds it whether or not the
 * agent gets to answer, then handed to the session as its next user turn.
 * False when the run has no session listening: queued, ended, or between
 * invocations.
 */
export function steerRun(app: App, runId: string, text: string): boolean {
  const send = steering.get(runId);
  if (send === undefined) return false;
  appendRunLog(
    app.config.dataDir,
    runId,
    `you: ${text.replace(/\s*\n\s*/g, " ")}`,
  );
  return send(text);
}

/** What a reviewer reads: the pull's diff against its base, and its pictures. */
async function reviewInputs(
  app: App,
  repo: Repo,
  pull: Pull,
  record: AppRecord | undefined,
  bare: string,
): Promise<{ reviewDiff: string; looks: string[] }> {
  const base = (await resolveOid(bare, `refs/heads/${pull.baseBranch}`)) ?? "";
  let reviewDiff = "(no diff available)";
  if (base !== "") {
    const out = await runGitCapture(
      ["diff", "--stat", "-p", `${base}...${pull.headOid}`],
      { cwd: bare },
    );
    const text = out.stdout.toString();
    reviewDiff =
      text.length > REVIEW_DIFF_MAX
        ? `${text.slice(0, REVIEW_DIFF_MAX)}\n… (cut at ${REVIEW_DIFF_MAX} bytes)`
        : text;
  }
  const looks =
    record === undefined
      ? []
      : looksForEnv(app.db, record.id, `pull-${pull.number}`)
          .filter(
            (l) =>
              l.commitOid === pull.headOid &&
              l.error === null &&
              (l.kind === "phone" || l.kind === "desktop"),
          )
          .sort(
            (a, b) =>
              (a.kind === "phone" ? -1 : 1) - (b.kind === "phone" ? -1 : 1),
          )
          .map((l) =>
            l.path.startsWith("/") ? l.path : join(app.config.dataDir, l.path),
          );
  return { reviewDiff, looks };
}

const REVIEW_DIFF_MAX = 60 * 1024;

/** The share of a run's budget held back for finishing. */
const RESERVE = 0.15;
/** ...and never less than this: a wrap-up that cannot run a test is none. */
const RESERVE_FLOOR_USD = 0.5;

/**
 * What a run keeps for its wrap-up: fifteen percent of the budget, at
 * least fifty cents, never more than half — a budget too small to split
 * is not made worse by splitting it.
 */
export function wrapUpReserve(budgetUsd: number): number {
  return Math.min(
    Math.max(budgetUsd * RESERVE, RESERVE_FLOOR_USD),
    budgetUsd / 2,
  );
}

/**
 * How a review run ends, read from the verdicts on the pull: `ok` when the
 * reviewer passed one since the run began, or stands by one on the head it
 * was given (the same verdict sent again is the one already there);
 * `failed` when it did neither. A reviewer pushes nothing by design, so
 * what it pushed never decides it.
 */
export function settleReview(
  reviews: readonly Review[],
  reviewerId: string,
  since: string,
  headOid: string,
): { state: "ok" | "failed"; summary: string } {
  const verdict = reviews.findLast(
    (r) =>
      r.authorId === reviewerId &&
      (r.createdAt >= since || r.commitOid === headOid),
  );
  return verdict === undefined
    ? { state: "failed", summary: "reviewed: no verdict was posted" }
    : { state: "ok", summary: `reviewed: ${verdict.state.replace("_", " ")}` };
}

/**
 * Claim and execute a queued agent run. Never throws. A run the provider
 * turned away ends cancelled with a `paused:` summary and returns when its
 * task should be queued again; every other run returns nothing.
 */
export async function executeAgentRun(
  app: App,
  run: Run,
  options: CrewOptions,
): Promise<Pause | undefined> {
  // A follow-up queued behind a run that has since answered everything:
  // nothing new to act on, so nothing starts (`guard.ts`).
  if (
    run.reason === "feedback" &&
    run.attempt === 0 &&
    run.startedAt === null &&
    skipsQueued(app, run)
  ) {
    const skipped = cancelRun(app.db, run.id, SKIP_SUMMARY);
    if (skipped) announceRun(app, skipped);
    return undefined;
  }
  const claimed = claimRun(app.db, run.id);
  if (!claimed) return undefined;
  const lease = holdLease(app.db, run.id);
  const controller = new AbortController();
  trackAgentRun(run.id, controller);
  const write = (line: string): void =>
    appendRunLog(app.config.dataDir, run.id, line);
  announceRun(app, claimed);
  const started = Date.now();
  const meter: Meter = {
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    subscriptionId: null,
    kind: usageKind(app, claimed),
    reportedAt: 0,
  };
  let outcome: Outcome;
  try {
    outcome = await work(app, claimed, options, write, controller.signal, meter);
  } catch (error) {
    log.error("agent run threw", { run: run.id, error: String(error) });
    outcome = {
      state: "failed",
      summary: `the run failed: ${String(error).slice(0, 200)}`,
    };
  } finally {
    untrackAgentRun(run.id);
    steering.delete(run.id);
    lease();
  }
  // Whatever the agent left running in its clone — a server it started to
  // try something — ends with the run. The sandbox refuses it `kill`, so the
  // forge does the tidying, by the directory the process is working in.
  await reapOrphans(app, run, write);
  forgetLandedClone(app, run);
  meterUsage(app, claimed, outcome, meter, started);
  if (outcome.state === "paused") {
    write(outcome.summary);
    noteRunProgress(app.db, run.id, {
      sessionId: outcome.sessionId,
      costUsd: outcome.costUsd,
    });
    const paused = cancelRun(app.db, run.id, outcome.summary);
    if (paused) announceRun(app, paused);
    return { resumeAt: outcome.resumeAt, attempt: run.attempt + 1 };
  }
  // A run the provider or a restart cut short says so, and when it goes
  // on: interrupted, never a park (`interrupted.ts`).
  const summary =
    outcome.state === "failed"
      ? interruptedSummary(outcome.summary, outcome.resumesAt)
      : outcome.summary;
  write(
    outcome.state === "ok" ? `done: ${summary}` : `failed: ${summary}`,
  );
  const done = finishRun(app.db, run.id, {
    state: outcome.state,
    summary,
    sessionId: outcome.sessionId,
    costUsd: outcome.costUsd,
    turns: outcome.turns,
  });
  if (done) announceRun(app, done);
  return undefined;
}

/** Whether a queued follow-up would find nothing new (`news.ts`): recorded as a skip. */
function skipsQueued(app: App, run: Run): boolean {
  const repo = getRepoById(app.db, run.repoId);
  const issue =
    run.issueId === null ? undefined : getIssueById(app.db, run.issueId);
  const agent =
    run.actorId === null ? undefined : getAgent(app.db, run.actorId);
  return (
    repo !== undefined &&
    issue !== undefined &&
    agent !== undefined &&
    skipsFeedback(app.db, repo, issue, agent)
  );
}

/**
 * The clone of a pull that is no longer open — landed or closed while this
 * run worked on it — is nobody's now. The dispatcher lets a clone go the
 * moment its pull closes with no run in it; a run in flight lets go of its
 * own, here, once its git is done with the floor.
 */
function forgetLandedClone(app: App, run: Run): void {
  const repo = getRepoById(app.db, run.repoId);
  const agent =
    run.actorId === null ? undefined : getAgent(app.db, run.actorId);
  const issue =
    run.issueId === null ? undefined : getIssueById(app.db, run.issueId);
  if (!repo || !agent || !issue) return;
  const number = issueOfBranch(agent, run.branch) ?? issue.number;
  const pull =
    issue.kind === "pull"
      ? getPull(app.db, repo.id, issue.number)
      : listPulls(app.db, repo.id, { state: "closed" }).find(
          (p) => p.headBranch === run.branch,
        );
  if (pull === undefined || (pull.state === "open" && pull.mergedAt === null))
    return;
  rmSync(workdirFor(app.config.dataDir, agent, repo, number), {
    recursive: true,
    force: true,
  });
}

/**
 * Processes still holding files under the run's clone, after the run: the
 * agent's leftovers. `lsof +D` is the honest way to find them on macOS and
 * Linux alike; a machine without it keeps its leftovers and the log says so.
 */
async function reapOrphans(
  app: App,
  run: Run,
  write: (line: string) => void,
): Promise<void> {
  const repo = getRepoById(app.db, run.repoId);
  const agent =
    run.actorId === null ? undefined : getAgent(app.db, run.actorId);
  const issue =
    run.issueId === null ? undefined : getIssueById(app.db, run.issueId);
  if (!repo || !agent || !issue) return;
  const branch = run.branch;
  const number = issueOfBranch(agent, branch) ?? issue.number;
  const dir = workdirFor(app.config.dataDir, agent, repo, number);
  if (!existsSync(dir)) return;
  let out = "";
  try {
    const proc = Bun.spawn(["lsof", "-t", "+D", dir], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 15_000);
    out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
  } catch {
    return; // no lsof here
  }
  const pids = [...new Set(out.split(/\s+/).filter((p) => /^\d+$/.test(p)))]
    .map(Number)
    .filter((pid) => pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      write(`stopped a process the agent left running (pid ${pid})`);
    } catch {
      // Already gone.
    }
  }
}

type Outcome =
  | {
      readonly state: "ok" | "failed";
      readonly summary: string;
      /** When a run the provider cut short can go on (`interrupted.ts`). */
      readonly resumesAt?: Date | undefined;
      readonly sessionId?: string | undefined;
      readonly costUsd?: number | undefined;
      readonly turns?: number | undefined;
    }
  | {
      /** The provider turned the run away; it goes on again at `resumeAt`. */
      readonly state: "paused";
      readonly summary: string;
      readonly resumeAt: string;
      readonly sessionId: string;
      readonly costUsd: number;
    };

/**
 * What a run spent that its outcome does not carry: the tokens of every
 * model invocation it made, and the account it made them on. Filled by
 * `work` as it goes, read once the run ends.
 */
interface Meter {
  tokensIn: number;
  tokensOut: number;
  /** US dollars reported by invocations that have ended. */
  costUsd: number;
  subscriptionId: string | null;
  kind: UsageKind;
  /** When a `running` line was last written (epoch ms); 0 for never. */
  reportedAt: number;
}

/** What a run is for, as the ledger sums it: its reason, or its agent's role. */
function usageKind(app: App, run: Run): UsageKind {
  if (run.reason === "review") return "review";
  if (run.reason === "check_failed") return "check";
  if (
    run.actorId !== null &&
    crewRole(app.db, run.repoId, run.actorId) === "planner"
  )
    return "plan";
  return "build";
}

/** How often a running session's spend is written and announced, at most. */
const LIVE_MS = 2_000;

/**
 * A running session's spend so far, as its `running` line in the ledger,
 * and a `usage.delta` on the outbox so the board and the Subscriptions page
 * move within seconds. At most once per `LIVE_MS` unless `force`; the
 * event carries only the run's id — spend is the owner's fact, and a
 * reader who may see it reads it from the page.
 */
function meterLive(
  app: App,
  run: Run,
  meter: Meter,
  live: { tokensIn: number; tokensOut: number; costUsd: number },
  started: number,
  force: boolean,
): void {
  const now = Date.now();
  if (!force && now - meter.reportedAt < LIVE_MS) return;
  meter.reportedAt = now;
  try {
    recordUsage(app.db, {
      runId: run.id,
      repoId: run.repoId,
      issueId: run.issueId,
      agentId: run.actorId,
      subscriptionId: meter.subscriptionId,
      kind: meter.kind,
      tokensIn: live.tokensIn,
      tokensOut: live.tokensOut,
      costUsd: live.costUsd,
      wallMs: now - started,
      outcome: "running",
      at: new Date(now).toISOString(),
    });
    app.bus.append({
      kind: "usage.delta",
      repoId: run.repoId,
      payload: { runId: run.id },
    });
  } catch (error) {
    log.warn("live usage not recorded", { run: run.id, error: String(error) });
  }
}

/** The run's line in the usage ledger (`core/usage.ts`), written once it ends. */
function meterUsage(
  app: App,
  run: Run,
  outcome: Outcome,
  meter: Meter,
  started: number,
): void {
  const ended = new Date();
  const result: UsageOutcome = outcome.state;
  // The ledger is bookkeeping: a line it cannot write (the repository
  // deleted under the run) is logged, never the run's failure.
  try {
    recordUsage(app.db, {
    runId: run.id,
    repoId: run.repoId,
    issueId: run.issueId,
    agentId: run.actorId,
    subscriptionId: meter.subscriptionId,
    kind: meter.kind,
    tokensIn: meter.tokensIn,
    tokensOut: meter.tokensOut,
    costUsd: outcome.costUsd ?? 0,
    wallMs: ended.getTime() - started,
    outcome: result,
    at: ended.toISOString(),
    });
  } catch (error) {
    log.warn("usage not recorded", { run: run.id, error: String(error) });
  }
}

/** What a paused run hands back: when its task may start again, and the count. */
export interface Pause {
  readonly resumeAt: string;
  readonly attempt: number;
}

async function work(
  app: App,
  run: Run,
  options: CrewOptions,
  write: (line: string) => void,
  signal: AbortSignal,
  meter: Meter,
): Promise<Outcome> {
  const began = new Date().toISOString();
  const repo = getRepoById(app.db, run.repoId);
  const issue =
    run.issueId === null ? undefined : getIssueById(app.db, run.issueId);
  const agent =
    run.actorId === null ? undefined : getAgent(app.db, run.actorId);
  if (!repo || !issue || !agent)
    return {
      state: "failed",
      summary: "the repository, issue or agent no longer exists",
    };
  if (repo.origin !== null)
    return {
      state: "failed",
      summary: "agents do not work on mirrored repositories yet",
    };
  const reason = run.reason as RunReason;

  const pull =
    issue.kind === "pull" ? getPull(app.db, repo.id, issue.number) : undefined;
  // The crew works from forks. An agent on the crew reads the repository
  // and writes only its own copy of it: the branch lives there, and the
  // pull proposes it back. A pull whose branch lives anywhere else is not
  // the agent's to move.
  const fork = await forkFor(app, agent, repo, write);
  if (!fork.ok) return { state: "failed", summary: fork.error };
  // A reviewer reads a pull it did not write: the diff comes to it in the
  // brief, its clone is its own fork at a scratch branch, and it pushes
  // nothing. The pull's branch is not its to move, and it never tries.
  const reviewing = reason === "review";
  if (pull !== undefined && !reviewing && pull.headRepoId !== fork.value.id)
    return {
      state: "failed",
      summary:
        pull.headRepoId === repo.id
          ? `pull #${pull.number}'s branch lives in the repository itself; the crew works from forks now — close it and assign the issue again`
          : "this pull's branch lives in a fork the agent cannot push to",
    };
  // A pull the conversation outlived. Closed without a merge, the proposal
  // was declined and there is nothing to continue. Merged before the run
  // began, its branch is spent: the follow-up starts a fresh branch from the
  // default branch and lands as a pull of its own, in the same session.
  if (pull !== undefined && pull.state !== "open" && pull.mergedAt === null)
    return {
      state: "failed",
      summary: `pull #${pull.number} was closed before the run began`,
    };
  const continuing = pull !== undefined && pull.mergedAt !== null;
  const branch =
    pull !== undefined && !continuing && !reviewing
      ? pull.headBranch
      : run.branch || branchFor(agent, issue);
  if (!isSafeRef(branch))
    return { state: "failed", summary: `unsafe branch name ${branch}` };
  noteRunProgress(app.db, run.id, { branch });
  // The task spans the issue and the pull opened for it, and a pull that
  // continues a merged one: its branch names the issue the session began on.
  const taskNumber =
    pull === undefined
      ? issue.number
      : (issueOfBranch(agent, pull.headBranch) ?? issue.number);
  const dir = workdirFor(app.config.dataDir, agent, repo, taskNumber);
  write(
    `${agent.user.username} on ${repo.ownerName}/${repo.name}#${issue.number} (${reason}), branch ${branch}`,
  );

  // The credential: rw, named for the run, gone when it ends.
  const expires = new Date(
    Date.now() + options.runTimeoutMs + 10 * 60_000,
  ).toISOString();
  const token = createToken(app.db, agent.user.id, `run:${run.id}`, "rw", {
    expiresAt: expires,
  });
  const gitAuth = {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${agent.user.username}:${token.token}`).toString("base64")}`,
    // The operator's own credential helper (a keychain, usually) would try
    // to store the header's credential and fail loudly on every push. The
    // header is the credential; no helper applies.
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
  };
  const identity = {
    GIT_AUTHOR_NAME: agent.user.displayName || agent.user.username,
    GIT_AUTHOR_EMAIL: agent.user.email,
    GIT_COMMITTER_NAME: agent.user.displayName || agent.user.username,
    GIT_COMMITTER_EMAIL: agent.user.email,
  };

  let grant: Grant | undefined;
  let runTmp: string | undefined;
  try {
    // The secrets this run declared, for this run only: opened now, held for
    // redaction from this moment, dropped in the `finally` below — a crash
    // included.
    const author = getUserById(app.db, issue.authorId);
    const declared = parseDeclaration(
      agent.brief,
      author !== undefined && canWrite(app.db, repo, author) ? issue.body : "",
    );
    grant = grantSecrets(app.db, app.config.dataDir, app.bus, declared, {
      id: run.id,
      repoId: repo.id,
      ownerId: repo.ownerId,
      actorId: agent.user.id,
    });
    for (const why of declared.refused) write(`secret refused: ${why}`);
    if (grant.writeRefused.length > 0) {
      const names = grant.writeRefused.join(", ");
      write(`refused: this run needs writes and ${names} is not write allowed`);
      return {
        state: "failed",
        summary: `refused: ${names} is not write allowed (Settings → Cloud accounts)`,
      };
    }
    if (grant.names.length > 0)
      write(`secrets: holding ${grant.names.join(", ")} for this run`);
    for (const name of grant.missing) write(`secret not set: ${name}`);
    for (const host of grant.hosts) write(`egress: +${host} for this run`);
    const bare = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const forkBare = repoDir(
      app.reposRoot,
      fork.value.ownerName,
      fork.value.name,
    );
    // A run that was paused carries on in the clone it left, changes and all.
    const prepared = await prepareClone(
      app,
      options,
      repo,
      fork.value,
      branch,
      dir,
      { ...gitAuth, ...identity },
      write,
      signal,
      run.attempt > 0,
    );
    if (!prepared.ok) return { state: "failed", summary: prepared.error };

    // What the agent is told.
    // The session belongs to the task, which spans the issue and the pull
    // opened for it: a follow-up on the pull resumes the run on the issue.
    const taskIssue =
      pull === undefined ? undefined : getIssue(app.db, repo.id, taskNumber);
    const previous =
      lastAgentRun(app.db, issue.id, agent.user.id) ??
      (taskIssue === undefined
        ? undefined
        : lastAgentRun(app.db, taskIssue.id, agent.user.id));
    const since = feedbackSince(app.db, repo, issue, agent);
    const record = getAppByRepo(app.db, repo.id);
    const runtime = appsRuntime(app);
    const previewUrl =
      record && runtime && pull && !continuing
        ? runtime.urlFor(record, previewEnv(pull.number))
        : undefined;
    const policy =
      record === undefined ? undefined : await policyBrief(app, repo);
    const brief = {
      agent,
      repo,
      issue,
      pull,
      branch,
      forgeUrl: options.forgeUrl,
      isApp: record !== undefined,
      previewUrl,
      policy,
      // A review reads one head afresh: a resumed session would carry an
      // older head's diff and preview into the verdict on this one.
      resuming:
        !reviewing &&
        previous?.sessionId !== undefined &&
        previous.sessionId !== "",
      role: crewRole(app.db, repo.id, agent.user.id),
    };
    const failedCheck =
      reason === "check_failed" && pull
        ? checkSummary(
            app.db,
            pull.id,
            (await resolveOid(forkBare, `refs/heads/${branch}`)) ??
              pull.headOid,
          )
        : undefined;
    // Imported words speak as their origin author (`voiceOf`), so the
    // brief marks a stranger's as a reader's, not the connecting user's.
    const comments = listComments(app.db, issue.id, { kind: "comment" }).map(
      voiceOf,
    );
    const reviews = pull ? listReviews(app.db, pull.id).map(voiceOf) : [];
    const reviewComments = pull
      ? listReviewComments(app.db, pull.id).map(voiceOf)
      : [];
    const prompt = taskPrompt({
      ...brief,
      issue: voiceOf(brief.issue),
      reason,
      paused: run.attempt > 0,
      comments,
      labels: (labelsForIssues(app.db, [issue.id]).get(issue.id) ?? []).map(
        (label) => label.name,
      ),
      reviews,
      reviewComments,
      readers: readersAmong(
        app.db,
        repo,
        [voiceOf(issue), ...comments, ...reviews, ...reviewComments].map(
          (c) => c.authorName,
        ),
      ),
      since,
      checkSummary: failedCheck?.run?.summary,
      conflictFiles:
        reason === "conflict" || reason === "converge"
          ? run.summary
              .replace(/^(main|parent) moved: /, "")
              .split(", ")
              .filter((f) => f !== "")
          : undefined,
      following:
        reason === "converge" && repo.forkParentId !== null
          ? (() => {
              const parent = getRepoById(app.db, repo.forkParentId);
              return parent === undefined
                ? undefined
                : {
                    parent: `${parent.ownerName}/${parent.name}`,
                    branch: parent.defaultBranch,
                  };
            })()
          : undefined,
      ...(reason === "review" && pull
        ? await reviewInputs(app, repo, pull, record, bare)
        : {}),
      // A planning run is given what the crew handed over (`parks.ts`).
      ...(brief.role === "planner" && issue.id === repo.directionIssueId
        ? {
            parkedTwice: parkedTwice(app.db, [repo]),
            laterGate: laterGate(app.db, repo.id),
          }
        : {}),
      checkKind:
        failedCheck?.run?.kind === "check" ||
        failedCheck?.run?.kind === "deploy"
          ? failedCheck.run.kind
          : undefined,
      checkLog: failedCheck?.run
        ? readRunLog(
            app.config.dataDir,
            failedCheck.run.id,
            8 * 1024,
          ).lines.slice(-40)
        : undefined,
    });

    // The account this run works on: the nearest grant's, rotating; the
    // forge's own token when nothing is granted. A grant whose accounts are
    // all resting holds the run until the first wakes, without a call.
    const scope = {
      repoId: repo.id,
      ownerId: repo.ownerId,
      agentId: agent.user.id,
    };
    // What this run may spend at most; on a budgeted account the pick
    // reserves it (or what is left, if less) against the account's budget.
    const ownBudget = agent.budgetUsd > 0 ? agent.budgetUsd : options.budgetUsd;
    const picked = pickSubscription(
      app.db,
      app.config.dataDir,
      scope,
      new Date(),
      { runId: run.id, usd: ownBudget },
    );
    if (picked.kind === "resting") {
      const names = picked.names.join(", ");
      write(
        `${names}: resting (${picked.said}) until ${whenText(new Date(picked.until))}`,
      );
      if (run.attempt < MAX_PAUSES)
        return {
          state: "paused",
          summary: `paused: ${names} resting — ${picked.said}; resumes ${whenText(new Date(picked.until))}`,
          resumeAt: picked.until,
          sessionId: previous?.sessionId ?? "",
          costUsd: 0,
        };
      return {
        state: "failed",
        summary: `every subscription this repository may use is resting (${picked.said})`,
        resumesAt: new Date(picked.until),
      };
    }
    if (picked.kind === "ready") {
      write(`subscription: ${picked.subscription.name}`);
      noteRunProgress(app.db, run.id, {
        subscriptionId: picked.subscription.id,
      });
      meter.subscriptionId = picked.subscription.id;
    } else {
      write("subscription: platform (env)");
      noteRunProgress(app.db, run.id, { subscriptionId: PLATFORM });
      meter.subscriptionId = PLATFORM;
    }
    const started = Date.now();
    const env: Record<string, string> = {
      ...gitAuth,
      ...identity,
      FORGE_URL: options.forgeUrl,
      FORGE_TOKEN: token.token,
      ...credentialEnv(picked),
      ...grant.env,
      ...(options.configDir === undefined
        ? {}
        : { CLAUDE_CONFIG_DIR: options.configDir }),
    };
    // The budget in two parts: the work, and a reserve for landing it. An
    // agent cut off mid-task otherwise leaves a tree the forge commits blind
    // and a pull whose description is the error.
    const budget =
      picked.kind === "ready" && picked.capUsd !== undefined
        ? Math.min(ownBudget, picked.capUsd)
        : ownBudget;
    const reserve = wrapUpReserve(budget);
    // Asked again for every invocation (`crew/sandbox.ts`): an agent made
    // since the last one is denied from this one on.
    const hosts = grant.hosts;
    const shellPolicy = () =>
      sandboxPolicy({
        dataDir: app.config.dataDir,
        agentName: agent.user.username,
        urls: [options.localUrl, options.forgeUrl],
        extraHosts: [...(options.allowHosts ?? []), ...hosts],
        enforced: options.sandboxEnforced,
        runId: run.id,
      });
    const sandbox = shellPolicy();
    // The run's own temp directory, never the machine's shared one; it goes
    // when the run does (the `finally` below). Both names: Claude Code's
    // sandbox reads CLAUDE_CODE_TMPDIR, but its shell still binds
    // `<TMPDIR>/claude-<uid>` writable, so TMPDIR has to say the same.
    runTmp = sandbox.tmpDir;
    if (runTmp !== undefined) {
      mkdirSync(runTmp, { recursive: true });
      env["CLAUDE_CODE_TMPDIR"] = runTmp;
      env["TMPDIR"] = runTmp;
    }
    // One deadline for the run, whatever it takes to get there: the token
    // dies ten minutes after it, so a second invocation gets what is left.
    const deadline = Date.now() + options.runTimeoutMs;
    const invoke = async (
      prompt: string,
      budgetUsd: number,
      resume: string | undefined,
    ): Promise<ClaudeOutcome> => {
      const spent = redactResult(
        await runClaude({
        binary: options.binary,
        cwd: dir,
        prompt,
        appendSystemPrompt: systemPrompt(brief),
        model: agent.model || undefined,
        budgetUsd,
        resume,
        env,
        sandbox: shellPolicy(),
        timeoutMs: Math.max(deadline - Date.now(), 0),
        log: write,
        signal,
        onSteer: (send) => steering.set(run.id, send),
        onUsage: (so) =>
          meterLive(
            app,
            run,
            meter,
            {
              tokensIn: meter.tokensIn + so.tokensIn,
              tokensOut: meter.tokensOut + so.tokensOut,
              costUsd: meter.costUsd + so.costUsd,
            },
            started,
            so.costUsd > 0,
          ),
        }),
      );
      meter.tokensIn += spent.tokensIn;
      meter.tokensOut += spent.tokensOut;
      meter.costUsd += spent.costUsd;
      return spent;
    };
    write(
      `claude: budget $${budget.toFixed(2)}, $${reserve.toFixed(2)} of it kept for the wrap-up${brief.resuming ? `, resuming ${previous?.sessionId}` : ""}`,
    );
    noteRunProgress(app.db, run.id, {
      sandbox: {
        enforced: sandbox.enforced,
        note: options.sandboxNote ?? "",
      },
    });
    if (!sandbox.enforced)
      write(
        `sandbox: off here${options.sandboxNote === undefined ? "" : ` — ${options.sandboxNote}`}; the shell runs unrestricted`,
      );
    const working = budget - reserve;
    let result = await invoke(
      prompt,
      working,
      brief.resuming ? previous?.sessionId : undefined,
    );
    if (
      !result.ok &&
      brief.resuming &&
      result.turns === 0 &&
      !signal.aborted &&
      !isRateLimited(result)
    ) {
      write("the session could not be resumed; starting fresh");
      result = await invoke(prompt, working, undefined);
    }
    noteRunProgress(app.db, run.id, {
      sessionId: result.sessionId,
      costUsd: result.costUsd,
    });
    write(
      `claude: ${result.reason}, ${result.turns} turns, $${result.costUsd.toFixed(2)}`,
    );

    // The provider's refusal, not the agent's failure: the run pauses with
    // its clone and session as they are, and goes on when the limit lifts.
    // A limit that never lifts is not waited on forever.
    let limitLifts: Date | undefined;
    if (isRateLimited(result) && !signal.aborted) {
      const said = (
        result.result.split("\n").find((l) => l.trim() !== "") ?? result.reason
      ).slice(0, 160);
      // The account rests until the provider's time; another on the same
      // grant, if one is awake, takes the run straight away.
      if (picked.kind === "ready") {
        const now = new Date();
        const until = resumeAt(result.result, now);
        // Which window is full and when it resets, in the provider's own
        // words, for the account's standing (`core/standing.ts`).
        const limit = limitOf(result.result, now);
        if (limit !== undefined)
          noteLimit(app.db, picked.subscription.id, {
            window: limit.window,
            resetsAt: limit.resetsAt.toISOString(),
            observedAt: now.toISOString(),
            said,
          });
        restSubscription(
          app.db,
          picked.subscription.id,
          until.toISOString(),
          said,
        );
        // Only a look at who could take over: no reservation is made here.
        // The run pauses, and on resume it picks again with its reserve.
        const next = pickSubscription(
          app.db,
          app.config.dataDir,
          scope,
          new Date(),
        );
        if (
          next.kind === "ready" &&
          next.subscription.id !== picked.subscription.id
        ) {
          write(
            `${picked.subscription.name} rests until ${whenText(until)}; ${next.subscription.name} takes the run`,
          );
          return {
            state: "paused",
            summary: `paused: ${pauseReason(picked.subscription.name, limit, said)}; ${next.subscription.name} takes over`,
            resumeAt: new Date().toISOString(),
            sessionId: result.sessionId,
            costUsd: result.costUsd,
          };
        }
      } else {
        // The platform's token is not rested — nothing else would take the
        // run — but its window is noted, so its standing reads true.
        const now = new Date();
        const limit = limitOf(result.result, now);
        if (limit !== undefined)
          noteLimit(app.db, PLATFORM, {
            window: limit.window,
            resetsAt: limit.resetsAt.toISOString(),
            observedAt: now.toISOString(),
            said,
          });
      }
      if (run.attempt < MAX_PAUSES) {
        const at = resumeAt(result.result, new Date());
        return {
          state: "paused",
          summary: `paused: ${pauseReason(picked.kind === "ready" ? picked.subscription.name : undefined, limitOf(result.result, new Date()), said)}; resumes ${whenText(at)}`,
          resumeAt: at.toISOString(),
          sessionId: result.sessionId,
          costUsd: result.costUsd,
        };
      }
      write(`paused ${MAX_PAUSES} times already; not waiting again`);
      limitLifts = resumeAt(result.result, new Date());
    }

    // The reserve: the same session gets one more turn, to land what exists
    // rather than to keep working. Its ending is the run's ending, with the
    // whole spend; the pull says where the work stopped.
    let stoppedAt: number | undefined;
    if (
      result.reason === BUDGET_REACHED &&
      result.sessionId !== "" &&
      !signal.aborted &&
      Date.now() < deadline
    ) {
      stoppedAt = result.costUsd;
      write(`claude: wrapping up with the reserve, $${reserve.toFixed(2)}`);
      const wrapped = await invoke(wrapUpPrompt(), reserve, result.sessionId);
      write(
        `claude: ${wrapped.reason}, ${wrapped.turns} turns, $${wrapped.costUsd.toFixed(2)}`,
      );
      result = {
        ...wrapped,
        sessionId: wrapped.sessionId || result.sessionId,
        costUsd: result.costUsd + wrapped.costUsd,
        turns: result.turns + wrapped.turns,
      };
      noteRunProgress(app.db, run.id, { costUsd: result.costUsd });
    }
    if (signal.aborted)
      return {
        state: "failed",
        summary: "cancelled",
        sessionId: result.sessionId,
        costUsd: result.costUsd,
        turns: result.turns,
      };

    // The decline contract: an agent that should not do the task says so
    // instead of guessing, and nothing it touched becomes a proposal.
    const declined = /^\s*DECLINED\b/i.test(result.result);
    if (declined) {
      const why = result.result.replace(/^\s*DECLINED:?\s*/i, "").trim();
      write(`declined: ${why.split("\n")[0] ?? ""}`);
      // The reason lives on the run record (its summary) and the ledger
      // line, never as a comment: a comment on an assigned issue is the
      // thing that starts the next run.
      return {
        state: "failed",
        summary: `declined: ${(why.split("\n")[0] ?? "").slice(0, 200)}`,
        sessionId: result.sessionId,
        costUsd: result.costUsd,
        turns: result.turns,
      };
    }

    // A reviewer's work is its verdict, posted through the API; it pushes
    // nothing and has nothing to land. The run is judged by whether the
    // verdict is there, not by what the session said about itself.
    if (reviewing && pull !== undefined) {
      const settled = settleReview(
        listReviews(app.db, pull.id),
        agent.user.id,
        began,
        pull.headOid,
      );
      write(settled.summary);
      return {
        ...settled,
        sessionId: result.sessionId,
        costUsd: result.costUsd,
        turns: result.turns,
      };
    }

    // Bookkeeping the agent does not have to get right.
    const landed = await landWork(
      app,
      options,
      repo,
      agent,
      issue,
      continuing ? undefined : pull,
      fork.value,
      branch,
      dir,
      forkBare,
      bare,
      { ...gitAuth, ...identity },
      result.result,
      stoppedAt === undefined
        ? undefined
        : `Budget reached at $${stoppedAt.toFixed(2)}; this is where it stopped.`,
      write,
      Object.values(grant.env),
    );
    return {
      state: result.ok || landed.pushed ? "ok" : "failed",
      summary: landed.summary + (result.ok ? "" : ` (${result.reason})`),
      resumesAt: limitLifts,
      sessionId: result.sessionId,
      costUsd: result.costUsd,
      turns: result.turns,
    };
  } finally {
    grant?.release();
    deleteToken(app.db, agent.user.id, token.id);
    if (runTmp !== undefined) rmSync(runTmp, { recursive: true, force: true });
  }
}

/**
 * The agent's fork of the repository it is working on, made on first use.
 * One fork per agent per repository; a name already taken by something
 * else of the agent's gets the owner's name in front.
 */
async function forkFor(
  app: App,
  agent: Agent,
  repo: Repo,
  write: (line: string) => void,
): Promise<Result<Repo, string>> {
  const existing = getForkOf(app.db, agent.user.id, repo.id);
  if (existing !== undefined) return ok(existing);
  let made = await forkRepo(app, agent.user, repo);
  if (!made.ok && made.error === "name_taken")
    made = await forkRepo(
      app,
      agent.user,
      repo,
      `${repo.ownerName}-${repo.name}`,
    );
  if (!made.ok)
    return err(
      `could not fork ${repo.ownerName}/${repo.name} for ${agent.user.username}: ${String(made.error)}`,
    );
  write(
    `forked ${repo.ownerName}/${repo.name} as ${made.value.ownerName}/${made.value.name}`,
  );
  return ok(made.value);
}

/**
 * A clone on `branch`, matching what the forge holds. The clone is the
 * triangle git was built for: it fetches from the repository and pushes to
 * the agent's fork, so a plain `git push` lands where the agent may write
 * and nowhere else.
 */
async function prepareClone(
  app: App,
  options: CrewOptions,
  repo: Repo,
  fork: Repo,
  branch: string,
  dir: string,
  env: Record<string, string>,
  write: (line: string) => void,
  signal: AbortSignal,
  keep = false,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = `${options.localUrl}/${repo.ownerName}/${repo.name}.git`;
  const forkUrl = `${options.localUrl}/${fork.ownerName}/${fork.name}.git`;
  if (signal.aborted) return { ok: false, error: "cancelled" };
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    write(`cloning ${repo.ownerName}/${repo.name}`);
    const cloned = await runGit(["clone", "--quiet", "--", url, dir], {
      env,
      timeoutMs: 5 * 60_000,
    });
    if (!cloned.ok)
      return {
        ok: false,
        error: `clone failed: ${cloned.error.stderr.slice(0, 200)}`,
      };
  } else {
    const fetched = await runGit(["fetch", "--quiet", "--prune", "origin"], {
      cwd: dir,
      env,
      timeoutMs: 2 * 60_000,
    });
    if (!fetched.ok)
      return {
        ok: false,
        error: `fetch failed: ${fetched.error.stderr.slice(0, 200)}`,
      };
    // A paused run resumes in the tree it left — its uncommitted work is
    // part of the session that is about to continue — so long as the clone
    // is still on its branch.
    if (keep) {
      const head = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: dir,
        env,
      });
      if (head.ok && head.value.trim() === branch) {
        write(`clone kept as it was left, on ${branch}`);
        return { ok: true };
      }
    }
  }
  await runGit(["config", "remote.origin.pushurl", forkUrl], { cwd: dir, env });
  // The branch, if it exists, lives in the fork; its tracking ref is fetched
  // from there so the checkout starts at what the agent last pushed.
  const forkBare = repoDir(app.reposRoot, fork.ownerName, fork.name);
  const remote = await resolveOid(forkBare, `refs/heads/${branch}`);
  if (remote !== undefined) {
    const fetched = await runGit(
      [
        "fetch",
        "--quiet",
        forkUrl,
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      { cwd: dir, env, timeoutMs: 2 * 60_000 },
    );
    if (!fetched.ok)
      return {
        ok: false,
        error: `fetch from the fork failed: ${fetched.error.stderr.slice(0, 200)}`,
      };
  }
  const start =
    remote === undefined ? `origin/${repo.defaultBranch}` : `origin/${branch}`;
  // A leftover from a cut-off run is discarded: the remote is truth.
  await runGit(["reset", "--quiet", "--hard"], { cwd: dir, env });
  await runGit(["clean", "-fdq"], { cwd: dir, env });
  const checked = await runGit(["checkout", "--quiet", "-B", branch, start], {
    cwd: dir,
    env,
  });
  if (!checked.ok)
    return {
      ok: false,
      error: `checkout failed: ${checked.error.stderr.slice(0, 200)}`,
    };
  // The branch tracks its remote from the start, set here where git config
  // is writable: inside the sandbox `.git/config` is not, so a plain
  // `git push` must already know where to go.
  await runGit(["config", `branch.${branch}.remote`, "origin"], {
    cwd: dir,
    env,
  });
  await runGit(["config", `branch.${branch}.merge`, `refs/heads/${branch}`], {
    cwd: dir,
    env,
  });
  write(
    remote === undefined
      ? `branch ${branch} from ${repo.defaultBranch}`
      : `branch ${branch} at ${remote.slice(0, 7)}`,
  );
  return { ok: true };
}

/**
 * After the agent stops: push what it committed if it did not, open the
 * pull if there is none, and report on the conversation — the agent's
 * last message, and the forge's note under it when there is one.
 */
async function landWork(
  app: App,
  options: CrewOptions,
  repo: Repo,
  agent: Agent,
  issue: Issue,
  pull: Pull | undefined,
  fork: Repo,
  branch: string,
  dir: string,
  forkBare: string,
  bare: string,
  env: Record<string, string>,
  message: string,
  note: string | undefined,
  write: (line: string) => void,
  granted: readonly string[] = [],
): Promise<{ pushed: boolean; summary: string }> {
  // A model may echo a granted value into a file; the tree is scrubbed
  // before the forge commits it, and the agent's own commits are searched
  // before anything is pushed.
  const scrubbed = await scrubTree(dir, granted, env);
  if (scrubbed.length > 0)
    write(`scrubbed a granted secret value from ${scrubbed.join(", ")}`);
  // Work left in the tree is committed on the agent's behalf: a proposal a
  // person can read beats an edit nobody sees. The summary says it happened.
  const status = await runGit(["status", "--porcelain"], { cwd: dir, env });
  let committedForIt = false;
  if (status.ok && status.value.trim() !== "") {
    const subject =
      message
        .split("\n")
        .find((l) => l.trim() !== "")
        ?.trim() ?? issue.title;
    await runGit(["add", "-A"], { cwd: dir, env });
    const commit = await runGit(
      [
        "commit",
        "--quiet",
        "-m",
        subject.slice(0, 200),
        "-m",
        `Work by @${agent.user.username} on #${issue.number}, committed by the forge.`,
      ],
      { cwd: dir, env },
    );
    committedForIt = commit.ok;
    write(
      commit.ok
        ? "committed the agent's uncommitted changes"
        : `could not commit leftover changes: ${commit.error.stderr.slice(0, 200)}`,
    );
  }
  const head = await runGit(["rev-parse", "--verify", "HEAD"], {
    cwd: dir,
    env,
  });
  const local = head.ok ? head.value.trim() : undefined;
  // The branch is the fork's; the base it is measured against is the
  // repository's own default branch.
  let remote = await resolveOid(forkBare, `refs/heads/${branch}`);
  const base = await resolveOid(bare, `refs/heads/${repo.defaultBranch}`);
  if (local !== undefined && local !== remote) {
    // Ahead of what the forge holds: the branch if it exists there, the
    // default branch otherwise — a fresh branch at the base tip is nothing.
    const against = remote ?? base;
    const ahead =
      against === undefined ? 1 : await aheadCount(dir, against, local);
    if (
      ahead > 0 &&
      (await historyHolds(
        dir,
        against === undefined ? "HEAD" : `${against}..HEAD`,
        granted,
        env,
      ))
    ) {
      write("refused: a granted secret value is in the commits; not pushed");
      return {
        pushed: false,
        summary:
          "refused to push: a secret this run held is in its commits; nothing pushed",
      };
    }
    if (ahead > 0) {
      write(
        `pushing ${branch} (${ahead} commit${ahead === 1 ? "" : "s"} the agent did not push)`,
      );
      const pushed = await runGit(
        ["push", "--quiet", "-u", "origin", `${branch}:${branch}`],
        { cwd: dir, env, timeoutMs: 2 * 60_000 },
      );
      if (!pushed.ok)
        write(`push refused: ${pushed.error.stderr.slice(0, 300)}`);
      remote = await resolveOid(forkBare, `refs/heads/${branch}`);
    }
  }
  // Counted in the fork, which sees the repository's objects through its
  // alternates and its own on top.
  const proposed =
    remote !== undefined && base !== undefined
      ? await aheadCount(forkBare, base, remote)
      : 0;
  const report = [message.trim(), note]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("\n\n");

  if (proposed === 0) {
    write(
      "nothing to propose: the branch has no commits beyond the default branch",
    );
    if (report !== "" && pull === undefined)
      addComment(app, agent.user, repo, issue, report);
    else if (report !== "" && pull !== undefined)
      addComment(app, agent.user, repo, pull, report);
    const first = report.split("\n").find((l) => l.trim() !== "") ?? "";
    return {
      pushed: false,
      summary:
        first === ""
          ? "no changes pushed"
          : `no changes pushed: ${first.slice(0, 200)}`,
    };
  }

  const existing =
    pull ??
    listPulls(app.db, repo.id, { state: "open", limit: 200 }).find(
      (p) => p.headRepoId === fork.id && p.headBranch === branch,
    );
  if (existing !== undefined) {
    if (report !== "") addComment(app, agent.user, repo, existing, report);
    return {
      pushed: true,
      summary: `updated pull #${existing.number} (${remote?.slice(0, 7)})${committedForIt ? ", committing its leftover changes" : ""}`,
    };
  }
  // No pull to update and yet the task is one: the pull it continues was
  // merged, and this one follows it rather than closing it.
  const trailer =
    issue.kind === "pull"
      ? `Continues #${issue.number}`
      : `Closes #${issue.number}`;
  const body = `${report === "" ? "" : `${report}\n\n`}${trailer}`;
  const opened = await openPull(app, agent.user, repo, {
    title: issue.title,
    body,
    baseBranch: repo.defaultBranch,
    headBranch: branch,
    headRepo: fork,
  });
  if (!opened.ok) {
    write(`could not open the pull: ${JSON.stringify(opened.error)}`);
    return {
      pushed: true,
      summary: `pushed ${branch} but could not open a pull (${String(opened.error)})`,
    };
  }
  write(`opened pull #${opened.value.number}`);
  return {
    pushed: true,
    summary: `opened pull #${opened.value.number}${committedForIt ? ", committing its leftover changes" : ""}`,
  };
}

/** What the agent said, with every held secret value taken out of it. */
function redactResult<T extends { result: string }>(r: T): T {
  return { ...r, result: redactValues(r.result) };
}

/**
 * The credential a run's environment carries: the picked account's token
 * under the variable Claude Code reads it from, or — with nothing granted —
 * whatever the forge itself was started with.
 */
function credentialEnv(picked: Pick): Record<string, string> {
  if (picked.kind === "ready") return { [picked.envName]: picked.token };
  const own: Record<string, string> = {};
  for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    const value = process.env[name];
    if (value !== undefined) own[name] = value;
  }
  return own;
}
