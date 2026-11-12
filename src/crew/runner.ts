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

import { isStrangerPull } from "./stranger.ts";
import { noteMeasure } from "../core/measure.ts";
import { capacityEnv } from "../core/capacity.ts";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { App } from "../app.ts";
import { addComment } from "../actions/issues.ts";
import { resolutionBrief } from "./proposal.ts";
import { openPull } from "../actions/pulls.ts";
import {
  fillPull,
  isEarlyBody,
  pullOfBranch,
  trailerFor,
  watchForPull,
  type EarlyPull,
  type Ending,
} from "./early.ts";
import { forkRepo, sealedForkFor } from "../actions/repos.ts";
import { announceRun } from "../actions/runs.ts";
import { Stopwatch } from "../apps/timing.ts";
import { previewEnv } from "../apps/data.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { chooseModel, modelFacts } from "./model_choice.ts";
import { ownApp, ownAppUrls } from "./app_hosts.ts";
import {
  machineEnv,
  machineFor,
  machineLimits,
  reachableApps,
} from "./machines.ts";
import { repoMachines } from "./machines_read.ts";
import { authorsInRepoPull } from "./authors_pull.ts";
import { crewRole, getAgent, type Agent } from "../core/agents.ts";
import { getAppByRepo, type AppRecord } from "../core/apps.ts";
import {
  getIssue,
  getIssueById,
  labelsForIssues,
  listComments,
  type Issue,
} from "../core/issues.ts";
import { refreshPullHead } from "../core/following.ts";
import { reviewSourceNote } from "./source_held.ts";
import {
  UPSTREAM_TITLE,
  sourceFollowing,
  upstreamFollowing,
} from "../actions/upstream_follow.ts";
import { getPull, listPulls, type Pull } from "../core/pulls.ts";
import {
  canWrite,
  forkParentFor,
  getForkOf,
  getRepoById,
  type Repo,
} from "../core/repos.ts";
import { getUserById, type User } from "../core/users.ts";
import {
  listReviewComments,
  listReviews,
  type Review,
} from "../core/reviews.ts";
import {
  answerCancelled,
  cancelRun,
  checkSummary,
  claimRun,
  finishRun,
  getRun,
  lastAgentRun,
  noteRunProgress,
  setRunBase,
  overranBefore,
  type Run,
} from "../core/runs.ts";
import { mintRunToken } from "../core/run_token.ts";
import { deleteToken } from "../core/tokens.ts";
import { runGit } from "../git/env.ts";
import { installPinHook } from "./pin_hook.ts";
import { cloneWithMirror } from "./mirror.ts";
import { isSafeRef } from "../git/guard.ts";
import { runGitCapture } from "../git/env.ts";
import { looksForEnv } from "../core/looks.ts";
import { aheadCount, contentOnBase, resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { bar } from "../cloud/gate.ts";
import { declarationsOf } from "../cloud/declared.ts";
import { accountOfSecret } from "../core/cloud_account.ts";
import {
  alreadyDoneSummary,
  answeredBeforeStop,
  declineOf,
  isAnswer,
  namedCommits,
  onBase,
} from "./already.ts";
import { touchesDesign } from "./review.ts";
import { BUDGETS, budgetSummary } from "../kernel/budgets.ts";
import { createLog, redactValues } from "../kernel/log.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { holdLease } from "../runs/lease.ts";
import { appendRunLog, readRunLog } from "../runs/log.ts";
import { cancelledLine } from "../runs/cancelled.ts";
import {
  branchFor,
  issueOfBranch,
  promptVersion,
  systemPrompt,
  taskPrompt,
  wrapUpPrompt,
  type LastTry,
  type RunReason,
  type TaskInput,
} from "./brief.ts";
import { policyBrief } from "../contract/audit.ts";
import {
  isNetworkError,
  NETWORK_PAUSE_MS,
  NETWORK_RETRY_SECONDS,
  pause,
} from "./network.ts";
import { BUDGET_REACHED, runClaude, type ClaudeOutcome } from "./claude.ts";
import {
  isRateLimited,
  limitOf,
  MAX_PAUSES,
  resumeAt,
  takeLimit,
  whenText,
} from "./limits.ts";
import { clearStaleLocks, lockedOut } from "./locks.ts";
import { interruptedSummary } from "./interrupted.ts";
import { laterGate } from "./later.ts";
import { MERGES_CLEAN_NOW, mergesCleanNow } from "./clean_now.ts";
import { handedLimbs } from "./handed_limbs.ts";
import { parkedTwice } from "./parks.ts";
import { budgetLimit, budgetVerdict, cutOffBy, isOwnForge, NO_ACCOUNT_SAID, NO_KEY_SAID } from "./forge_budget.ts";
import { boxesOf, landedBoxes } from "./box_pass.ts";
import { reviewRange } from "./review_range.ts";
import { heldNow, stuckOf } from "./held.ts";
import { reserveOf } from "./reserve.ts";
import { resumeDecision } from "./resume.ts";
import { owed } from "./team_share.ts";
import { pauseReason } from "./pacing.ts";
import { grantLeft } from "../core/model_grant.ts";
import { dailyLeft, reserveCeiling } from "../core/account_ceiling.ts";
import {
  credentialEnvOf,
  hostOfApiBase,
  MIN_RUN_USD,
  pickSubscription,
  PLATFORM,
  type Pick,
} from "../core/subscriptions.ts";
import {
  recordUsage,
  type UsageKind,
  type UsageOutcome,
} from "../core/usage.ts";
import { trackAgentRun, untrackAgentRun } from "./running.ts";
import { installCacheEnv, sandboxPolicy } from "./sandbox.ts";
import { grantSecrets, parseDeclaration, type Grant } from "./grant.ts";
import { historyHolds, scrubTree } from "./leak.ts";
import {
  installCacheDir,
  installDependencies,
  installNote,
  type InstallRunner,
  removeClone,
  workdirFor,
  claimWorkdir,
} from "./workdir.ts";
import { readersAmong, voiceOf } from "./direct.ts";
import { feedbackSince } from "./news.ts";
import {
  handedOverPulls,
  RETRY_SUMMARY,
  SKIP_SUMMARY,
  skipsFeedback,
} from "./guard.ts";
import { passportEnv } from "./passport_env.ts";
import { fundedEnv } from "../spawn/funding.ts";

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
  /** Scales the wait before a network retry; tests pass 0. @default 1 */
  readonly networkRetryScale?: number | undefined;
  /** How long a review run may take. @default BUDGETS.review */
  readonly reviewBudgetMs?: number | undefined;
  /** A `CLAUDE_CONFIG_DIR` for runs, when the operator wants one. */
  readonly configDir?: string | undefined;
  /** Hosts an agent's shell may reach beyond the forge and the registry. */
  readonly allowHosts?: readonly string[] | undefined;
  /** Whether this host can enforce the shell sandbox (`sandboxAvailable`). */
  readonly sandboxEnforced?: boolean | undefined;
  /** Why it cannot, when it cannot — said once in every run's log. */
  readonly sandboxNote?: string | undefined;
  /** Milliseconds between the crew's ticks; tests pass a small one. @default 5000 */
  readonly tickMs?: number | undefined;
  /** The clock a run's timing line reads; tests pass a fake. @default Date.now */
  readonly now?: (() => number) | undefined;
  /** What runs `bun install` in a clone; tests pass a stand-in. @default bun */
  readonly installRunner?: InstallRunner | undefined;
}

export { crewRoot, workdirFor } from "./workdir.ts";

/** Runs with an agent listening: what a person says reaches it next. */
const steering = new Map<string, (text: string) => boolean>();

/** A session starts listening to a run; the answer stops it. */
export function listenForSteer(
  runId: string,
  send: (text: string) => boolean,
): () => void {
  steering.set(runId, send);
  return () => {
    if (steering.get(runId) === send) steering.delete(runId);
  };
}

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

/** What a refused run says: an org is named with the page where an admin grants it; a person keeps the plain words. */
function noGrantSaid(app: App, ownerId: string, ownerName: string): string {
  const db = app.db;
  // A forge that is its owner's own, or a repository its admin owns, has no
  // one else to ask: the key is theirs to add (#11515).
  if (isOwnForge(app) || getUserById(db, ownerId)?.isAdmin === true)
    return NO_KEY_SAID;
  const org = db
    .query<{ kind: string }, [string]>("SELECT kind FROM user WHERE id = ?1")
    .get(ownerId)?.kind === "org";
  return org
    ? `the account \`${ownerName}\` has no model grant; an admin can grant one at /settings/accounts/${ownerName}`
    : NO_ACCOUNT_SAID;
}

/**
 * What a reviewer reads: the pull's diff (`review_range.ts` — a landed pull's
 * is its merge commit's), and its pictures. `landedAs` names the merge commit
 * the diff was read from, when it was.
 */
export async function reviewInputs(
  app: App,
  repo: Repo,
  pull: Pull,
  record: AppRecord | undefined,
  bare: string,
): Promise<{
  reviewDiff: string;
  looks: string[];
  design: boolean;
  landedAs?: string;
}> {
  const range = await reviewRange(bare, pull);
  let reviewDiff = "(no diff available)";
  let design = false;
  if (range !== undefined) {
    const names = await runGitCapture(
      ["diff", "--name-only", range.from, range.to],
      { cwd: bare },
    );
    design = touchesDesign(
      names.stdout
        .toString()
        .split("\n")
        .filter((n) => n !== ""),
    );
    const out = await runGitCapture(
      ["diff", "--stat", "-p", range.from, range.to],
      { cwd: bare },
    );
    const text = out.stdout.toString();
    if (out.code === 0)
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
  return {
    reviewDiff,
    looks,
    design,
    ...(range?.landed === true && reviewDiff !== "(no diff available)"
      ? { landedAs: range.to }
      : {}),
  };
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

/** How far a run got, for the timing line an early return would cut short. */
interface Ran {
  claimed: boolean;
  inHarness: boolean;
  inWrapUp: boolean;
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
  const watch = new Stopwatch(options.now ?? Date.now);
  const began = { claimed: false, inHarness: false, inWrapUp: false };
  try {
    return await runClaimed(app, run, options, watch, began);
  } finally {
    // The log's last line, on every path that started: where the time went
    // (and after it, for a run a person cancelled, who did).
    // A step an early return cut short still owns the time it held.
    if (began.inHarness) watch.lap("harness");
    if (began.inWrapUp) watch.lap("wrap-up");
    if (began.claimed) {
      appendRunLog(
        app.config.dataDir,
        run.id,
        watch.line("run ended", "the run started"),
      );
      // A run a person cancelled says so, and who, after it (#11229).
      const cancelled = cancelledLine(getRun(app.db, run.id));
      if (cancelled !== undefined) appendRunLog(app.config.dataDir, run.id, cancelled);
    }
  }
}

async function runClaimed(
  app: App,
  run: Run,
  options: CrewOptions,
  watch: Stopwatch,
  began: Ran,
): Promise<Pause | undefined> {
  // A follow-up queued behind a run that has since answered everything:
  // nothing new to act on, so nothing starts (`guard.ts`).
  if (
    run.reason === "feedback" &&
    run.attempt === 0 &&
    run.startedAt === null &&
    run.summary !== RETRY_SUMMARY &&
    skipsQueued(app, run)
  ) {
    const skipped = cancelRun(app.db, run.id, SKIP_SUMMARY);
    if (skipped) announceRun(app, skipped);
    return undefined;
  }
  const claimed = claimRun(app.db, run.id);
  if (!claimed) return undefined;
  began.claimed = true;
  const lease = holdLease(app.db, run.id);
  // A resolve run keeps the head it started from, to tell a push from none.
  const startedAt =
    run.reason === "resolve" ? await pullHeadOf(app, run, false) : undefined;
  if (startedAt !== undefined) setRunBase(app.db, run.id, startedAt);
  const controller = new AbortController();
  trackAgentRun(run.id, controller);
  const write = (line: string): void =>
    appendRunLog(app.config.dataDir, run.id, line);
  announceRun(app, claimed);
  const started = Date.now();
  // A reviewer past its budget is stopped, whatever it is doing.
  let overran = false;
  const clock =
    claimed.reason === "review"
      ? setTimeout(() => {
          overran = true;
          controller.abort();
        }, options.reviewBudgetMs ?? BUDGETS.review)
      : undefined;
  const meter: Meter = {
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    subscriptionId: null,
    kind: usageKind(app, claimed),
    reportedAt: 0,
    stop: () => controller.abort(),
  };
  let outcome: Outcome;
  try {
    outcome = await work(
      app,
      claimed,
      options,
      write,
      controller.signal,
      meter,
      watch,
      began,
    );
  } catch (error) {
    log.error("agent run threw", { run: run.id, error: String(error) });
    outcome = {
      state: "failed",
      summary: `the run failed: ${String(error).slice(0, 200)}`,
    };
  } finally {
    clearTimeout(clock);
    untrackAgentRun(run.id);
    steering.delete(run.id);
    lease();
  }
  // Whatever the agent left running in its clone — a server it started to
  // try something — ends with the run. The sandbox refuses it `kill`, so the
  // forge does the tidying, by the directory the process is working in.
  await reapOrphans(app, run, write);
  await forgetLandedClone(app, run);
  meterUsage(app, claimed, outcome, meter, started);
  if (overran) {
    const summary = budgetSummary(
      "a review run",
      Date.now() - started,
      options.reviewBudgetMs ?? BUDGETS.review,
    );
    write(summary);
    if (!overranBefore(app.db, claimed)) {
      const again = cancelRun(app.db, run.id, summary);
      if (again) announceRun(app, again);
      return {
        resumeAt: new Date().toISOString(),
        attempt: run.attempt + 1,
        summary: `${summary}; queued again`,
      };
    }
    const failed = finishRun(app.db, run.id, { state: "failed", summary });
    if (failed) announceRun(app, failed);
    return undefined;
  }
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
  write(outcome.state === "ok" ? `done: ${summary}` : `failed: ${summary}`);
  // A proposed resolution is the head it left the pull at: kept, so the page
  // never calls a later push the crew's commit.
  const left =
    run.reason === "resolve" && outcome.state === "ok"
      ? await headLeftBy(app, run, startedAt)
      : undefined;
  const done = finishRun(app.db, run.id, {
    state: outcome.state,
    summary,
    sessionId: outcome.sessionId,
    costUsd: outcome.costUsd,
    turns: outcome.turns,
    contextTokens: outcome.contextTokens,
    pushed: outcome.pushed,
    commitOid: left,
  });
  if (done) announceRun(app, done);
  else if (isAnswer(outcome.summary)) {
    // Its pull closed under it, but it had found the work done: say so.
    const answered = answerCancelled(app.db, run.id, {
      state: outcome.state,
      summary,
    });
    if (answered) announceRun(app, answered);
  }
  return undefined;
}

/** The head the run left, if it moved since `startedAt`; none if it pushed nothing. */
async function headLeftBy(
  app: App,
  run: Run,
  startedAt: string | undefined,
): Promise<string | undefined> {
  const head = await pullHeadOf(app, run, true);
  return head === startedAt ? undefined : head;
}

/** The head of the run's pull, fetched fresh when `refresh` is set. */
async function pullHeadOf(
  app: App,
  run: Run,
  refresh: boolean,
): Promise<string | undefined> {
  const repo = getRepoById(app.db, run.repoId);
  const issue =
    run.issueId === null ? undefined : getIssueById(app.db, run.issueId);
  if (repo === undefined || issue === undefined || issue.kind !== "pull")
    return undefined;
  const pull = getPull(app.db, repo.id, issue.number);
  if (pull === undefined) return undefined;
  if (!refresh) return pull.headOid;
  // A fork's push reaches the pull's row by a fetch; take it now, not later.
  // A push's own follow-up may have taken the head already, after this row
  // was read: ask the row again rather than trust the copy in hand.
  return (
    (await refreshPullHead(app, repo, pull)) ??
    getPull(app.db, repo.id, issue.number)?.headOid ??
    pull.headOid
  );
}

/** What a retried follow-up is told: the latest verdict asking for changes, and the last builder run's final answer. */
function lastTryOf(
  app: App,
  pullId: string,
  run: Run,
  reviews: readonly { state: string; authorName: string; body: string }[],
): LastTry | undefined {
  const verdict = reviews.findLast((r) => r.state === "changes_requested");
  if (verdict === undefined) return undefined;
  const answer = app.db
    .query<{ summary: string }, [string, string]>(
      `SELECT summary FROM run WHERE issue_id = ?1 AND kind = 'agent' AND reason != 'review'
          AND id <> ?2 AND summary NOT LIKE 'skipped: %'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(pullId, run.id);
  return {
    reviewer: verdict.authorName,
    verdict: verdict.body,
    answer: answer?.summary ?? "",
  };
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
async function forgetLandedClone(app: App, run: Run): Promise<void> {
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
      : listPulls(app.db, repo.id, { sealed: true, state: "closed" }).find(
          (p) => p.headBranch === run.branch,
        );
  if (pull === undefined || (pull.state === "open" && pull.mergedAt === null))
    return;
  // The run is over, so a clone that will not go is not the run's failure.
  // It stays on disk (nothing sweeps a closed pull's leftover later); the
  // warning names it, and a person can remove the directory.
  const dir = workdirFor(app.config.dataDir, agent, repo, number);
  try {
    await removeClone(dir);
  } catch (error) {
    log.warn("a landed pull's clone would not go and is left on disk", {
      run: run.id,
      dir,
      error: String(error),
    });
  }
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
      /** The context the session held at its end, in tokens (`resume.ts` reads it). */
      readonly contextTokens?: number | undefined;
      /** Whether the run moved its branch; undefined when it cannot say. */
      readonly pushed?: boolean | undefined;
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
  /** Ends the run. */
  stop: () => void;
  /** Set when the run spends an owner's capped grant: whose. */
  grantOwner?: string;
  /** Set on every run: whose daily ceiling it counts against. */
  ceilingOwner?: string;
  /** Why the run was stopped by its grant's cap, when it was. */
  stoppedFor?: string;
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

/** Said on a run stopped at its grant's cap. */
const GRANT_SPENT =
  "This month's model grant is spent: the run stopped at the cap; an admin can raise it";

/** Said on a run stopped at its account's daily ceiling. */
const DAILY_SPENT =
  "This account's daily ceiling is spent: the run stopped; an admin can raise it";

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
    // The cap is checked on each spend tick, not only at the start.
    if (meter.grantOwner !== undefined && meter.stoppedFor === undefined) {
      const left = grantLeft(app.db, meter.grantOwner, new Date(now));
      if (left !== undefined && left <= 0) {
        meter.stoppedFor = GRANT_SPENT;
        meter.stop();
      }
    }
    if (meter.ceilingOwner !== undefined && meter.stoppedFor === undefined) {
      const left = dailyLeft(app.db, meter.ceilingOwner, new Date(now));
      if (left !== undefined && left <= 0) {
        meter.stoppedFor = DAILY_SPENT;
        meter.stop();
      }
    }
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
  /** What the queued task says while it waits, when not the provider's limit. */
  readonly summary?: string | undefined;
}

/** The file names a conflict or converge run's summary carries, after "main|parent|upstream moved: ". */
export function conflictFilesOf(summary: string): string[] {
  return summary
    .replace(/^(main|parent|upstream) moved: /, "")
    .split(", ")
    .filter((f) => f !== "");
}

/**
 * What a converge brief says the repository follows: the outside upstream
 * for an issue titled "Upstream: …", else a forge parent the agent may read.
 */
export function convergeFollowing(
  app: App,
  repo: Repo,
  issue: Issue,
  user: User,
): TaskInput["following"] {
  if (issue.title.startsWith(UPSTREAM_TITLE)) {
    const upstream =
      sourceFollowing(app, issue.id) ?? upstreamFollowing(app, repo.id);
    if (upstream !== undefined) return upstream;
  }
  // Only a parent the agent may read is put in its brief.
  const parent = forkParentFor(app.db, repo, user);
  return parent === undefined
    ? undefined
    : {
        parent: `${parent.ownerName}/${parent.name}`,
        branch: parent.defaultBranch,
      };
}

/** The paragraphs a pull description opens with, or nothing when there are none. */
function pullNote(...parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((part): part is string => part !== undefined);
  return present.length === 0 ? undefined : present.join("\n\n");
}

async function work(
  app: App,
  run: Run,
  options: CrewOptions,
  write: (line: string) => void,
  signal: AbortSignal,
  meter: Meter,
  watch: Stopwatch,
  ran: Ran,
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
  // A sealed report's work lives where only the base's writers and crew
  // can read it, never in the agent's public fork (`core/sealed.ts`).
  const fork = await forkFor(
    app,
    agent,
    repo,
    write,
    issue.sealed || pull?.sealed === true,
  );
  if (!fork.ok) return { state: "failed", summary: fork.error };
  // A reviewer reads a pull it did not write: the diff comes to it in the
  // brief, its clone is its own fork at a scratch branch, and it pushes
  // nothing. The pull's branch is not its to move, and it never tries.
  const reviewing = reason === "review";
  // A person's such pull is theirs to push, and stays open (#7572).
  if (pull !== undefined && !reviewing && pull.headRepoId === repo.id)
    return {
      state: "failed",
      summary: authorsInRepoPull(pull)
        ? `pull #${pull.number}'s branch lives in the repository itself and only its author, a person, can push it; the crew leaves it with them`
        : `pull #${pull.number}'s branch lives in the repository itself; the crew works from forks now — close it and assign the issue again`,
    };
  // A pull whose branch lives in someone else's fork is not the agent's to
  // push to, and the run no longer fails for it: like a merged pull's
  // follow-up, it starts a fresh branch in the agent's own fork and lands as
  // a pull of its own.
  const foreign =
    pull !== undefined && !reviewing && pull.headRepoId !== fork.value.id
      ? pull
      : undefined;
  if (foreign)
    write(
      `pull #${foreign.number}'s branch lives in another fork: starting a fresh branch in the agent's own, with the diff in the brief`,
    );
  // A pull the conversation outlived. Closed without a merge, the proposal
  // was declined and there is nothing to continue. Merged before the run
  // began, its branch is spent: the follow-up starts a fresh branch from the
  // default branch and lands as a pull of its own, in the same session.
  if (pull !== undefined && pull.state !== "open" && pull.mergedAt === null)
    return {
      state: "failed",
      summary: `pull #${pull.number} was closed before the run began`,
    };
  const continuing =
    pull !== undefined && (pull.mergedAt !== null || foreign !== undefined);
  const pullStands = pull !== undefined && !continuing;
  // A bring-up-to-date run whose pull merges clean by now — main moved
  // again, or the clash was settled — has nothing for an agent (`clean_now.ts`).
  if (
    reason === "conflict" &&
    pull !== undefined &&
    pullStands &&
    (await mergesCleanNow(app, repo, pull))
  ) {
    write(MERGES_CLEAN_NOW);
    return {
      state: "ok",
      summary: MERGES_CLEAN_NOW,
      costUsd: 0,
      turns: 0,
      pushed: false,
    };
  }
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
  write(
    `${agent.user.username} on ${repo.ownerName}/${repo.name}#${issue.number} (${reason}), branch ${branch}`,
  );

  // The credential: rw, named for the run, bound to this repository and the
  // fork it pushes to (`http/run_gate.ts`), gone when it ends.
  const expires = new Date(
    Date.now() + options.runTimeoutMs + 10 * 60_000,
  ).toISOString();
  const token = mintRunToken(
    app.db,
    agent.user.id,
    run.id,
    { repoId: repo.id, forkId: fork.value.id },
    expires,
  );
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
  let early: EarlyPull | undefined;
  // A paused run resumes: its pull keeps saying "In progress".
  let pausing = false;
  let ending: Ending | undefined;
  // The clone is claimed last, right before the `try` whose `finally` frees
  // it: a throw anywhere above would otherwise hold it for the life of the
  // process, and every later run on the issue would work beside it.
  const workdir = claimWorkdir(
    workdirFor(app.config.dataDir, agent, repo, taskNumber),
    run.id,
  );
  const dir = workdir.dir;
  try {
    if (workdir.own)
      write(`another run holds the issue's clone; working in ${dir}`);
    // The secrets this run declared, for this run only: opened now, held for
    // redaction from this moment, dropped in the `finally` below — a crash
    // included.
    const author = getUserById(app.db, issue.authorId);
    const asked = parseDeclaration(
      agent.brief,
      author !== undefined && canWrite(app.db, repo, author) ? issue.body : "",
    );
    // A cloud credential goes to a run only through the gate: the repository's
    // cloud.json must declare the vendor, and either way a row is audited.
    const hasCloud = asked.names.some((n) => accountOfSecret(n) !== undefined);
    const declared = bar(
      app.db,
      asked,
      run.id,
      hasCloud ? await declarationsOf(app.reposRoot, repo) : [],
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
    watch.lap("clone");
    if (!prepared.ok) return { state: "failed", summary: prepared.error };
    // Dependencies before the agent starts, so the type check has its types;
    // a failure is logged and the run goes on.
    const deps = await installDependencies(
      dir,
      installCacheDir(app.config.dataDir, repo.id),
      options.installRunner,
    );
    const note = installNote(deps);
    if (note !== undefined) write(note);

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
    const resumption = resumeDecision(previous, (options.now ?? Date.now)());
    const since = feedbackSince(app.db, repo, issue, agent);
    const record = getAppByRepo(app.db, repo.id);
    const runtime = appsRuntime(app);
    const previewUrl =
      record && runtime && pull && !continuing
        ? runtime.urlFor(record, previewEnv(pull.number))
        : undefined;
    const policy =
      record === undefined ? undefined : await policyBrief(app, repo);
    // The machine this seat runs in, from the default branch's forge.json.
    const role = crewRole(app.db, repo.id, agent.user.id);
    const machine = machineFor(await repoMachines(app, repo), role);
    const brief = {
      agent,
      repo,
      machine,
      issue,
      pull,
      branch,
      forgeUrl: options.forgeUrl,
      isApp: record !== undefined,
      previewUrl,
      ownApp: ownApp(app, repo),
      policy,
      // A review reads one head afresh: a resumed session would carry an
      // older head's diff and preview into the verdict on this one. Any
      // other follow-up resumes only while it is cheap to (`resume.ts`).
      resuming: !reviewing && resumption.resume,
      role,
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
      stranger:
        reason === "review" && pull !== undefined
          ? isStrangerPull(app.db, repo, pull)
          : undefined,
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
      lastTry:
        reason === "feedback" && run.summary === RETRY_SUMMARY
          ? lastTryOf(app, issue.id, run, reviews)
          : undefined,
      checkSummary: failedCheck?.run?.summary,
      foreignPull: foreign
        ? {
            branch: foreign.headBranch,
            diff: (await reviewInputs(app, repo, foreign, undefined, bare))
              .reviewDiff,
          }
        : undefined,
      resolution:
        reason === "resolve" && pull
          ? await resolutionBrief(app, repo, pull)
          : undefined,
      conflictFiles:
        reason === "conflict" || reason === "converge"
          ? conflictFilesOf(run.summary)
          : undefined,
      following:
        reason === "converge"
          ? convergeFollowing(app, repo, issue, agent.user)
          : undefined,
      ...(reason === "review" && pull
        ? {
            ...(await reviewInputs(app, repo, pull, record, bare)),
            sourceNote: await reviewSourceNote(app, repo, pull, bare),
            boxes: boxesOf(app, repo, pull),
            retry:
              app.db
                .query<{ n: number }, [string, string, string]>(
                  `SELECT COUNT(*) AS n FROM run WHERE issue_id = ?1 AND kind = 'agent'
                   AND reason = 'review' AND state = 'failed' AND id <> ?2
                   AND created_at < ?3`,
                )
                .get(issue.id, run.id, run.createdAt)!.n > 0,
          }
        : {}),
      // A planning run is given what the crew handed over (`parks.ts`),
      // what holds the ready list when nothing on it can start (`held.ts`),
      // and the standing reserve it keeps (`reserve.ts`).
      ...(brief.role === "planner" && issue.id === repo.directionIssueId
        ? {
            parkedTwice: [
              ...parkedTwice(app.db, [repo]),
              ...handedOverPulls(app.db, repo),
            ],
            limbs: handedLimbs(app, repo),
            laterGate: laterGate(app.db, repo.id),
            ...(() => {
              const held = heldNow(app, repo);
              return {
                landed: landedBoxes(held.by.landed),
                stuck: stuckOf(held),
                reserve: reserveOf(held.startable.length, repo.autonomySlots),
              };
            })(),
            owed: owed(app.db, repo.id),
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
    const ownBudget =
      agent.budgetUsd > 0
        ? agent.budgetUsd
        : isOwnForge(app)
          ? budgetLimit(app.db, "run")
          : options.budgetUsd;
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
    // The forge's own token is for admin-owned repositories only; anyone
    // else's run waits for a grant rather than spend what is not theirs.
    // The owner's capped monthly grant (`core/model_grant.ts`) is the one
    // way past it: the forge's token, up to what is left of the month.
    const grantCap =
      picked.kind === "none"
        ? grantLeft(app.db, repo.ownerId, new Date())
        : undefined;
    if (
      picked.kind === "none" &&
      (grantCap === undefined || grantCap < MIN_RUN_USD)
    ) {
      const said =
        grantCap === undefined
          ? noGrantSaid(app, repo.ownerId, repo.ownerName)
          : "This month's model grant is spent: an admin can raise it";
      write(said);
      return { state: "failed", summary: said };
    }
    // What this run would spend before the account's ceilings: its own
    // budget, under the subscription's reservation or the grant's rest.
    const wanted =
      picked.kind === "ready" && picked.capUsd !== undefined
        ? Math.min(ownBudget, picked.capUsd)
        : grantCap !== undefined
          ? Math.min(ownBudget, grantCap)
          : ownBudget;
    // The account's own ceilings, daily and per run, apart from the forge's:
    // a run past either does not start and spends nothing. What it may
    // spend is reserved against the day now, so a run started beside it is
    // handed only what is left.
    const ceiling = reserveCeiling(
      app.db,
      repo.ownerId,
      { id: run.id, wantUsd: wanted },
      MIN_RUN_USD,
      new Date(),
    );
    if (!ceiling.ok) {
      write(ceiling.said);
      return { state: "failed", summary: ceiling.said };
    }
    // The owner's own limits on a forge that is theirs (`forge_budget.ts`).
    const own = budgetVerdict(app, ceiling.capUsd ?? wanted, new Date(), run.id);
    if (own !== undefined && !own.ok) {
      write(own.said);
      return { state: "failed", summary: own.said };
    }
    meter.ceilingOwner = repo.ownerId;
    if (picked.kind === "ready") {
      write(`subscription: ${picked.subscription.name}`);
      noteRunProgress(app.db, run.id, {
        subscriptionId: picked.subscription.id,
      });
      meter.subscriptionId = picked.subscription.id;
    } else {
      if (grantCap !== undefined) {
        meter.grantOwner = repo.ownerId;
        write(`model grant: $${grantCap.toFixed(2)} left this month`);
      }
      write("subscription: platform (env)");
      noteRunProgress(app.db, run.id, { subscriptionId: PLATFORM });
      meter.subscriptionId = PLATFORM;
    }
    const started = Date.now();
    const env: Record<string, string> = {
      // The shard count an admin set (`core/capacity.ts`), for the checks an
      // agent runs in its clone; never the pod's environment.
      ...capacityEnv(app.db),
      ...gitAuth,
      ...identity,
      FORGE_URL: options.forgeUrl,
      FORGE_TOKEN: token.token,
      ...passportEnv(app.config.dataDir),
      ...credentialEnv(picked, app.config.dataDir),
      ...grant.env,
      ...machineEnv(machine),
      ...(options.configDir === undefined
        ? {}
        : { CLAUDE_CONFIG_DIR: options.configDir }),
    };
    // The budget in two parts: the work, and a reserve for landing it. An
    // agent cut off mid-task otherwise leaves a tree the forge commits blind
    // and a pull whose description is the error.
    const budget = Math.min(ceiling.capUsd ?? Infinity, wanted, own?.ok === true ? own.capUsd : Infinity);
    const reserve = wrapUpReserve(budget);
    // Asked again for every invocation (`crew/sandbox.ts`): an agent made
    // since the last one is denied from this one on.
    const hosts = grant.hosts;
    const gatewayHost =
      picked.kind === "ready" ? hostOfApiBase(picked.apiBase) : undefined;
    const shellPolicy = () =>
      sandboxPolicy({
        dataDir: app.config.dataDir,
        agentName: agent.user.username,
        urls: [options.localUrl, options.forgeUrl],
        appUrls: reachableApps(machine, ownAppUrls(ownApp(app, repo))),
        extraHosts: [
          ...(options.allowHosts ?? []),
          ...hosts,
          ...(gatewayHost === undefined ? [] : [gatewayHost]),
        ],
        enforced: options.sandboxEnforced,
        runId: run.id,
        repoId: repo.id,
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
    // Bun's install cache is the repository's, shared by its runs, so a
    // package is downloaded once rather than by every clone.
    installCacheEnv(sandbox, env);
    // The sandbox refuses a unix socket's bind; the forge's own servers take
    // a loopback port instead (`git/hook-address.ts`), so `bun test` runs.
    if (sandbox.enforced) env["FORGE_TEST_SOCKET"] = "port";
    // One deadline for the run, whatever it takes to get there: the token
    // dies ten minutes after it, so a second invocation gets what is left.
    const deadline = Date.now() + options.runTimeoutMs;
    // The agent's own model, unless the work asks for Opus (#7570). A
    // planner's plain pass runs on Sonnet; one handed work the crew could
    // not finish runs on Opus (`model_choice.ts`).
    const handed =
      brief.role === "planner" &&
      (parkedTwice(app.db, [repo]).length > 0 ||
        handedOverPulls(app.db, repo).length > 0 ||
        handedLimbs(app, repo).length > 0);
    const facts = modelFacts(
      app.db,
      repo,
      taskIssue === undefined ? [issue] : [issue, taskIssue],
      agent.model,
      brief.role,
      reviewing,
      handed,
    );
    const chosen = chooseModel(facts);
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
          model: chosen.model || undefined,
          budgetUsd,
          resume,
          env,
          sandbox: shellPolicy(),
          limits: machineLimits(machine),
          label: `crew:${agent.user.username}`,
          timeoutMs: Math.max(deadline - Date.now(), 0),
          log: write,
          signal,
          onSteer: (send) => {
            listenForSteer(run.id, send);
          },
          onMeasure: (m) =>
            noteMeasure(app.db, meter.subscriptionId ?? PLATFORM, m),
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
    if (!reviewing && resumption.why !== "") write(resumption.why);
    noteRunProgress(app.db, run.id, {
      model: chosen.model,
      modelReason: chosen.reason,
      promptVersion: promptVersion(agent, brief.role),
      sandbox: {
        enforced: sandbox.enforced,
        note: options.sandboxNote ?? "",
      },
    });
    if (!sandbox.enforced)
      write(
        `sandbox: off here${options.sandboxNote === undefined ? "" : ` — ${options.sandboxNote}`}; the shell runs unrestricted`,
      );
    watch.lap("brief");
    ran.inHarness = true;
    const working = budget - reserve;
    if (!reviewing)
      early = watchForPull({
        app,
        repo,
        agent,
        issue,
        run,
        fork: fork.value,
        branch,
        forkBare,
        bare,
        forgeUrl: options.forgeUrl,
        write,
        variantGroup: run.variantGroup,
        continuing: pullStands,
        onOpened: () =>
          write(
            watch.line(
              "first push",
              "the run started",
              "harness to first push",
            ),
          ),
      });
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
    // A dropped connection says nothing about the work: ask again before the
    // run is judged. `next` names the prompt and session for each new ask,
    // given what the last one left; the main turn and the wrap-up share this.
    const retrying = async (
      first: typeof result,
      budgetUsd: number,
      what: string,
      next: (last: typeof result) => {
        prompt: string;
        sessionId: string | undefined;
      },
    ): Promise<typeof result> => {
      let current = first;
      for (const seconds of NETWORK_RETRY_SECONDS) {
        if (!isNetworkError(current) || signal.aborted) break;
        write(`network error; retrying${what} in ${seconds}s`);
        await pause(seconds * 1000 * (options.networkRetryScale ?? 1), signal);
        if (signal.aborted || Date.now() >= deadline) break;
        const ask = next(current);
        const again = await invoke(ask.prompt, budgetUsd, ask.sessionId);
        current = {
          ...again,
          sessionId: again.sessionId || current.sessionId,
          costUsd: current.costUsd + again.costUsd,
          turns: current.turns + again.turns,
          contextTokens: again.contextTokens || current.contextTokens,
        };
      }
      return current;
    };
    // Still unreachable after the retries: an outage, not a verdict. The run
    // pauses with its clone and session and asks again later, as it does for
    // a provider limit, rather than ending as "no changes pushed".
    const outagePause = (
      last: typeof result,
      costUsd: number,
    ): Outcome | undefined => {
      if (
        !isNetworkError(last) ||
        signal.aborted ||
        Date.now() >= deadline ||
        run.attempt >= MAX_PAUSES
      )
        return undefined;
      pausing = true;
      const at = new Date(Date.now() + NETWORK_PAUSE_MS);
      write(`network still down; paused, resumes ${whenText(at)}`);
      return {
        state: "paused",
        summary: `paused: network error, resumes ${whenText(at)}`,
        resumeAt: at.toISOString(),
        sessionId: last.sessionId,
        costUsd,
      };
    };
    result = await retrying(result, working, "", (last) =>
      last.sessionId === ""
        ? { prompt, sessionId: undefined }
        : { prompt: "Continue where you stopped.", sessionId: last.sessionId },
    );
    await early?.stop();
    const down = outagePause(result, result.costUsd);
    if (down !== undefined) return down;
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
      const now = new Date();
      // The account rests until the provider's time; another on the same
      // grant, if one is awake, takes the run straight away.
      const { until, limit, said } = takeLimit(
        app.db,
        picked.kind === "ready" ? picked.subscription.id : undefined,
        result.result,
        result.reason,
        now,
      );
      if (picked.kind === "ready") {
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
          pausing = true;
          return {
            state: "paused",
            summary: `paused: ${pauseReason(picked.subscription.name, limit, said)}; ${next.subscription.name} takes over`,
            resumeAt: new Date().toISOString(),
            sessionId: result.sessionId,
            costUsd: result.costUsd,
          };
        }
      }
      if (run.attempt < MAX_PAUSES) {
        const at = resumeAt(result.result, new Date());
        pausing = true;
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

    watch.lap("harness");
    ran.inHarness = false;
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
      ran.inWrapUp = true;
      write(`claude: wrapping up with the reserve, $${reserve.toFixed(2)}`);
      const wrapped = await retrying(
        await invoke(wrapUpPrompt(), reserve, result.sessionId),
        reserve,
        " the wrap-up",
        (last) => ({
          prompt: wrapUpPrompt(),
          sessionId: last.sessionId || result.sessionId,
        }),
      );
      // Still unreachable after the retries: the work is not judged on a
      // wrap-up that never got through; the run pauses as the main turn does.
      const wrapDown = outagePause(wrapped, result.costUsd + wrapped.costUsd);
      if (wrapDown !== undefined) return wrapDown;
      write(
        `claude: ${wrapped.reason}, ${wrapped.turns} turns, $${wrapped.costUsd.toFixed(2)}`,
      );
      result = {
        ...wrapped,
        sessionId: wrapped.sessionId || result.sessionId,
        costUsd: result.costUsd + wrapped.costUsd,
        turns: result.turns + wrapped.turns,
        contextTokens: wrapped.contextTokens || result.contextTokens,
      };
      noteRunProgress(app.db, run.id, { costUsd: result.costUsd });
      watch.lap("wrap-up");
      ran.inWrapUp = false;
    }
    // A run whose pull closed under it may still have reached its answer: an
    // already-done decline is kept (`answerCancelled`). One the meter stopped is not.
    if (signal.aborted && !answeredBeforeStop(meter.stoppedFor, result.result))
      return {
        state: "failed",
        summary: meter.stoppedFor ?? "cancelled",
        sessionId: result.sessionId,
        costUsd: result.costUsd,
        turns: result.turns,
        contextTokens: result.contextTokens,
      };

    // The decline contract: an agent that should not do the task says so
    // instead of guessing, and nothing it touched becomes a proposal.
    const why = declineOf(result.result);
    if (why !== undefined) {
      write(`declined: ${why.split("\n")[0] ?? ""}`);
      ending = { kind: "declined", sentence: why.split("\n")[0] ?? "" };
      // Done on the base already, by a commit that is there: its own
      // outcome, not a park (`already.ts`). A claim without one is an
      // ordinary decline.
      const done = await onBase(
        bare,
        repo.defaultBranch,
        namedCommits(why.split("\n")[0] ?? ""),
      );
      if (done.length > 0)
        return {
          state: "ok",
          summary: alreadyDoneSummary(done),
          sessionId: result.sessionId,
          costUsd: result.costUsd,
          turns: result.turns,
          contextTokens: result.contextTokens,
          pushed: false,
        };
      // The reason lives on the run record (its summary) and the ledger
      // line, never as a comment: a comment on an assigned issue is the
      // thing that starts the next run.
      return {
        state: "failed",
        summary: `declined: ${(why.split("\n")[0] ?? "").slice(0, 200)}`,
        sessionId: result.sessionId,
        costUsd: result.costUsd,
        turns: result.turns,
        contextTokens: result.contextTokens,
        pushed: false,
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
        contextTokens: result.contextTokens,
        pushed: false,
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
      pullNote(
        foreign
          ? `A fresh start: pull #${foreign.number}'s branch \`${foreign.headBranch}\` lives in another fork, which the crew cannot push to, so this work began from \`${repo.defaultBranch}\` and does not carry that branch's commits.`
          : undefined,
        stoppedAt === undefined
          ? undefined
          : `Budget reached at $${stoppedAt.toFixed(2)}; this is where it stopped.`,
      ),
      write,
      Object.values(grant.env),
      run.variantGroup,
    );
    // An outage that outlasted every pause is named as one, not as a push
    // that found nothing: the board and the sentinel read the difference.
    const outage = !landed.pushed && isNetworkError(result);
    return {
      state: result.ok || landed.pushed ? "ok" : "failed",
      summary: outage
        ? `network unreachable after ${MAX_PAUSES} pauses; nothing to land (${result.reason})`
        : landed.summary +
          (result.ok ? "" : ` (${result.reason})`) +
          cutOffBy(app.db, own, stoppedAt !== undefined),
      resumesAt: limitLifts,
      sessionId: result.sessionId,
      costUsd: result.costUsd,
      turns: result.turns,
      contextTokens: result.contextTokens,
      pushed: landed.pushed,
    };
  } finally {
    await early?.stop();
    if (!pausing) early?.settle(ending);
    grant?.release();
    await workdir.release();
    deleteToken(app.db, agent.user.id, token.id);
    if (runTmp !== undefined) rmSync(runTmp, { recursive: true, force: true });
  }
}

/**
 * The agent's fork of the repository it is working on, made on first use.
 * One fork per agent per repository; a name already taken by something
 * else of the agent's gets the owner's name in front.
 */
export async function forkFor(
  app: App,
  agent: Agent,
  repo: Repo,
  write: (line: string) => void,
  /** The task is a sealed report: its work goes in a private repository (`core/sealed.ts`). */
  sealed = false,
): Promise<Result<Repo, string>> {
  if (sealed) {
    const made = await sealedForkFor(app, agent.user, repo);
    if (!made.ok)
      return err(
        `could not make a private place for ${repo.ownerName}/${repo.name}'s sealed work: ${made.error}`,
      );
    return ok(made.value);
  }
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

/** Whether `dir` is empty, or a work tree git can read: its `.git` resolves. */
async function readsAsClone(
  dir: string,
  env: Record<string, string>,
): Promise<boolean> {
  if (readdirSync(dir).length === 0) return true;
  if (!existsSync(join(dir, ".git"))) return false;
  // Its own `.git`, named: never a repository above it that git would find.
  const top = await runGit(
    ["--git-dir", join(dir, ".git"), "rev-parse", "--git-dir"],
    { cwd: dir, env },
  );
  return top.ok;
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
  fresh = false,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Two addresses for one forge. The forge itself clones and fetches over
  // `localUrl`, on this machine. The agent's remotes carry `forgeUrl`, the
  // forge as the agent is told it: inside the shell sandbox, `localhost` is
  // the sandbox's own and reaches nothing, while a named host goes out
  // through the sandbox's proxy — so a remote on the local address would
  // leave `git push` nowhere to go, and the only way to push would be to
  // leave the sandbox, which is not a way.
  const url = `${options.localUrl}/${repo.ownerName}/${repo.name}.git`;
  const forkUrl = `${options.localUrl}/${fork.ownerName}/${fork.name}.git`;
  const agentUrl = `${options.forgeUrl}/${repo.ownerName}/${repo.name}.git`;
  const agentForkUrl = `${options.forgeUrl}/${fork.ownerName}/${fork.name}.git`;
  if (signal.aborted) return { ok: false, error: "cancelled" };
  // A kept clone git no longer reads as one — a clone a network blip cut
  // short — is moved aside, never reused, and cloned afresh (#6263).
  if (existsSync(dir) && !(await readsAsClone(dir, env))) {
    const aside = `${dir}.broken-${Date.now()}`;
    renameSync(dir, aside);
    write(
      `the kept clone is not a git repository; moved aside to ${aside}, cloning afresh`,
    );
    return prepareClone(
      app,
      options,
      repo,
      fork,
      branch,
      dir,
      env,
      write,
      signal,
      false,
      true,
    );
  }
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    write(`cloning ${repo.ownerName}/${repo.name}`);
    const cloned = await cloneWithMirror({
      dataDir: app.config.dataDir,
      repoId: repo.id,
      url,
      dir,
      env,
      signal,
    });
    if (!cloned.ok)
      return {
        ok: false,
        error: `clone failed: ${cloned.error.stderr.slice(0, 200)}`,
      };
  } else {
    // A kept clone may carry the locks of a run the forge cut off. This run
    // owns the clone now, so a lock a minute old is nobody's.
    clearStaleLocks(dir, write);
    const fetched = await runGit(
      [
        "fetch",
        "--quiet",
        "--prune",
        url,
        `+refs/heads/*:refs/remotes/origin/*`,
      ],
      { cwd: dir, env, timeoutMs: 2 * 60_000 },
    );
    if (!fetched.ok)
      return {
        ok: false,
        error: `fetch failed: ${fetched.error.stderr.slice(0, 200)}`,
      };
    // The remotes are the agent's, set again on every visit — a clone from
    // before the forge changed where they point (a kept clone resumed after
    // a release) would otherwise push to an address that is no longer the
    // forge's for the sandbox.
    await runGit(["config", "remote.origin.url", agentUrl], { cwd: dir, env });
    await runGit(["config", "remote.origin.pushurl", agentForkUrl], {
      cwd: dir,
      env,
    });
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
  await runGit(["config", "remote.origin.url", agentUrl], { cwd: dir, env });
  await runGit(["config", "remote.origin.pushurl", agentForkUrl], {
    cwd: dir,
    env,
  });
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
  if (!checked.ok && !fresh && lockedOut(checked.error.stderr)) {
    // A lock too young to clear, or one the sweep missed: start over once
    // from a fresh clone rather than failing the follow-up.
    // Only when nothing would be lost: a cut-off run may hold commits that
    // were never pushed, and those live nowhere else.
    const unpushed = await runGit(
      ["rev-list", "--branches", "--not", "--remotes=origin"],
      { cwd: dir, env },
    );
    if (!unpushed.ok || unpushed.value.trim() !== "")
      return {
        ok: false,
        error:
          "checkout blocked by a git lock, and the kept clone holds commits that were never pushed; left as it is",
      };
    write("checkout blocked by a git lock; cloning afresh");
    rmSync(dir, { recursive: true, force: true });
    return prepareClone(
      app,
      options,
      repo,
      fork,
      branch,
      dir,
      env,
      write,
      signal,
      false,
      true,
    );
  }
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
  // What a run leaves in its tree that is never the work: the temp
  // directory a sandboxed shell keeps beside the code (`.tmp/`), with a
  // test's data in it, and `node_modules/`. The wrap-up
  // commits leftovers with `git add -A`, so the clone says so once, in its
  // own exclude file — the repository's `.gitignore` is the repository's.
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
  writeFileSync(join(dir, ".git", "info", "exclude"), CLONE_EXCLUDES);
  // A push that adds a migration commits its pin first (#6938).
  installPinHook(dir);
  write(
    remote === undefined
      ? `branch ${branch} from ${repo.defaultBranch}`
      : `branch ${branch} at ${remote.slice(0, 7)}`,
  );
  return { ok: true };
}

/** Never the work, in any repository the crew clones: git's own exclude syntax. */
export const CLONE_EXCLUDES = [
  "# written by the forge for every crew clone",
  ".tmp/",
  "node_modules/",
  "",
].join("\n");

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
  variantGroup: string | null = null,
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
      // The forge pushes for the agent over its own local address — the
      // clone's `origin` carries the public one, for the agent inside the
      // sandbox (`prepareClone`), and this push is the forge's, not the
      // agent's. The branch already tracks `origin`, set there.
      const pushed = await runGit(
        [
          "push",
          "--quiet",
          // The clone's hooks are the agent's sandbox's, never the forge's.
          "--no-verify",
          `${options.localUrl}/${fork.ownerName}/${fork.name}.git`,
          `${branch}:${branch}`,
        ],
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
      ? (await contentOnBase(forkBare, base, remote))
        ? 0
        : await aheadCount(forkBare, base, remote)
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

  const existing = pull ?? pullOfBranch(app, repo, fork, branch);
  if (existing !== undefined) {
    // A pull this run opened at its first push is still the run's opening.
    const openedByRun = isEarlyBody(existing.body);
    fillPull(app, agent, repo, existing, issue, report);
    if (report !== "") addComment(app, agent.user, repo, existing, report);
    return {
      pushed: true,
      summary: `${openedByRun ? "opened" : "updated"} pull #${existing.number} (${remote?.slice(0, 7)})${committedForIt ? ", committing its leftover changes" : ""}`,
    };
  }
  // No pull to update and yet the task is one: the pull it continues was
  // merged, and this one follows it rather than closing it.
  const trailer = trailerFor(issue);
  const body = `${report === "" ? "" : `${report}\n\n`}${trailer}`;
  const opened = await openPull(app, agent.user, repo, {
    title: issue.title,
    body,
    baseBranch: repo.defaultBranch,
    headBranch: branch,
    headRepo: fork,
    ...(variantGroup === null ? {} : { variantGroup }),
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
 * under the variable Claude Code reads it from (plus a gateway base URL when
 * the account has one), or — with nothing granted — whatever the forge
 * itself was started with.
 */
export function credentialEnv(picked: Pick, dataDir?: string): Record<string, string> {
  if (picked.kind === "ready") return credentialEnvOf(picked);
  // A forge its parent funds (#10484): with no account of its own, the crew calls the model through the parent.
  // "none" reaches here only under an owner's grant (an org's, #10991), which is the forge's account too.
  const lent = (picked.kind === "env" || picked.kind === "none") && dataDir !== undefined ? fundedEnv(dataDir) : undefined;
  if (lent !== undefined) return lent;
  const own: Record<string, string> = {};
  for (const name of [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
  ]) {
    const value = process.env[name];
    if (value !== undefined) own[name] = value;
  }
  return own;
}
