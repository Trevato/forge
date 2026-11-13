/**
 * A repository's own check, run by the forge. `check` in `forge.json` names
 * a command; every push a pull or the default branch takes runs it against
 * that commit, in a fresh export of the tree, and the result is a run of
 * kind `check` beside the pull — the same place a preview's deploy reports,
 * read by the same code. A failing check on an agent's pull goes back to
 * the agent, as a failed preview does.
 *
 * This is the forge's own CI, and deliberately small: one command, one
 * checkout, one verdict, the log kept. Anything a repository wants checked
 * is that command's business.
 */

import { pullDir, runDir } from "../core/pulls.ts";
import { cellHides } from "../spawn/hosted-mark.ts";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { App } from "../app.ts";
import { releaseOnGreen } from "../actions/holds.ts";
import { activeCrewRuns, crewHoldsCore, forgeCpus, holdClock } from "../core/one_core.ts";
import { announceRun } from "../actions/runs.ts";
import { announceShard } from "./shard_event.ts";
import type { ForgeEvent } from "../core/events.ts";
import { getPull, listPulls, type Pull } from "../core/pulls.ts";
import { isContributionFork } from "../core/contribute.ts";
import { issueMayRun } from "../core/pull_trust.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import {
  cancelRun,
  getRun,
  leaseLapsed,
  cancelRunsForPull,
  checksForHead,
  claimRun,
  createRun,
  finishRun,
  listActive,
  noteRunProgress,
  overranBefore,
  setRunBase,
  setRunCombined,
  vanishedBefore,
  VANISHED_SUMMARY,
  infraBefore,
  INFRA_SUMMARY,
  CPU_STOP_SUMMARY,
  DISK_USED_SUMMARY,
  requeueCheck,
  REQUEUED_SUMMARY,
  sweepAbandonedChecks,
  type Run,
} from "../core/runs.ts";
import { Gate, runGit } from "../git/env.ts";
import { resolveOid } from "../git/merge.ts";
import { mergeForCheck } from "./merged.ts";
import { readCombined } from "../git/combined.ts";
import { approvedOnce } from "./approved_first.ts";
import { checkOnApproval } from "./approval.ts";
import { checkKey, provenBy, recordProven } from "./proven.ts";
import { beginGate, endGate, gateHolding } from "./gate_record.ts";
import { giveHistory } from "./history.ts";
import { readLearned } from "./learned.ts";
import { keepCache, restoreCache } from "./cache.ts";
import { MAX_FILED, clearedFiles, fileOrderDependent } from "./order_dependent.ts";
import { parseBunTestFailure } from "./bun-test.ts";
import { clearedIn } from "./base_red.ts";
import { recordCrashFlakes, passedAlone, recordFlakes, rerunCommand, rerunnable, pullOwnsRed } from "./flake.ts";
import { diskRecovered, withDisk } from "./disk_red.ts";
import { scratchEnv } from "./disk_full.ts";
import { ASKED, redMain, unheld } from "./red_main.ts";
import { proposeRevert } from "./revert_red.ts";
import { rebasesFirst } from "./finishing_first.ts";
import { IMPACT_FILE, keepImpact, seedImpact } from "./impact-store.ts";
import { afterVerify, closeOnGreen } from "./culprit.ts";
import { redDetail, reportGreen, reportRed } from "./report.ts";
import {
  bisectOrigin,
  failedFiles,
  inVerifyLane,
  onlyEnv,
  passedFiles,
  VERIFY_ENV,
  VERIFY_EVERY_MS,
  VERIFY_REASON,
  VERIFY_SWEEP_MS,
  verifyDue,
} from "./verify.ts";
import { getIssueById } from "../core/issues.ts";
import { BUDGETS, budgetSummary } from "../kernel/budgets.ts";
import { transact } from "../kernel/db.ts";
import { createLog } from "../kernel/log.ts";
import { holdLease, STALE_AFTER_MS } from "../runs/lease.ts";
import { appendRunLog } from "../runs/log.ts";
import { memoryHold } from "../runs/memory_hold.ts";
import { cancelledLine } from "../runs/cancelled.ts";
import { trackRun, untrackRun } from "../runs/stoppable.ts";
import { runningLimitSentence, runningRuns } from "../settings/quotas.ts";
import { exportTree, readFileAt } from "../apps/checkout.ts";
import { CHECK_TIMEOUT_MAX, parseCheck } from "../apps/manifest.ts";
import { workerCpus } from "../core/capacity.ts";
import { accountActive } from "../core/accounts.ts";
import { childEnv, killedStep, runStep } from "../apps/process.ts";
import { requeueCpuStop } from "./cpu_stop.ts";
import { isUsedRefusal, usedRefusal } from "../apps/disk_guard.ts";
import { noteReached } from "../apps/egress_report.ts";
import {
  capacityCount,
  noteBooted,
  capacityEnv,
  cpuLimit,
  egressSetting,
} from "../core/capacity.ts";
import {
  cellsAvailable,
  limitWarnings,
  resolveLimits,
  STEP_HOSTS,
  stoppedForCpu,
  type CellSpec,
} from "../apps/contain.ts";
import { summariseCheckFailure } from "./summary.ts";
import type { Result } from "../kernel/result.ts";
import { placementFromEnv, type Placement } from "./placement.ts";
import { JOB_VANISHED, runJobStep } from "./job_step.ts";
import {
  cellInstall,
  checkInstallCache,
  meteredInstall,
  installWithRetry,
  prefillInstallCache,
  withLock,
} from "./install.ts";
import { evictSoon, lend } from "./install_evict.ts";
import { checkStage, type GateStage } from "./gate_reason.ts";
import { extraGates, GATE_DEADLINE_MS, gateQueued, gateRunId, gatesInFlight, watchGates } from "./queue.ts";
import type { JobOptions } from "../cluster/jobs.ts";
import type { CheckDetail } from "../core/runs.ts";
import { settleLandedRuns } from "../crew/interrupted.ts";
import { during } from "../perf/jobs.ts";

const log = createLog("checks");

/** A gate this forge would not start, for it is stopping. */
const INTERRUPTED = "this forge is stopping";

export interface ChecksOptions {
  /** How many checks may run at once. @default 1 */
  readonly concurrency?: number | undefined;
  /** How full this forge's memory is, 0 to 1: its cgroup's unless a test says otherwise. */
  readonly pressure?: (() => number | undefined) | undefined;
  /** The forge's public URL, told to the check as `FORGE_URL`. */
  readonly forgeUrl: string;
  /** The parent's gate, for a hosted child: its checks take their turn in the parent's lane. */
  readonly gate?: Gate | undefined;
  /** Whose checks these are, written first in each run's log (a hosted child's name). */
  readonly label?: string | undefined;
  /** How long a check may run before it is killed. @default BUDGETS.gate */
  readonly budgetMs?: number | undefined;
  /**
   * How long a red main holds a pull's check (`checks/red_main.ts`). @default 0,
   * nothing held; the forge says `RED_HOLD_MS`.
   */
  readonly redHoldMs?: number | undefined;
  /**
   * How long main's check after a land waits before it may start, so the
   * steps of one candidate supersede each other while queued. @default 0,
   * none; the forge says `LAND_SETTLE_MS`.
   */
  readonly landSettleMs?: number | undefined;
  /**
   * How long `stop` lets checks already running finish before it cuts them
   * off and queues them again (#1796). Nothing new starts meanwhile.
   * @default 0
   */
  readonly drainMs?: number | undefined;
  /**
   * Where a check's commands run (`checks/placement.ts`). @default from the
   * environment: `process`.
   */
  readonly placement?: Placement | undefined;
  /** The kube client a `job` placement speaks through; tests stand one in. */
  readonly job?: JobOptions | undefined;
  /** How long a transient install failure waits for its retry. @default INSTALL_RETRY_MS */
  readonly installRetryMs?: number | undefined;
  /** Runs the check step itself; tests stand one in for a stop the cell's watch makes (#11617). @default runStep */
  readonly checkStep?: typeof runStep | undefined;
  /**
   * How often the default branch is verified after landing at most
   * (`checks/verify.ts`). Unset, no timer asks; `verifyDue` still holds
   * to `VERIFY_EVERY_MS`. The forge sets it to `VERIFY_EVERY_MS`.
   */
  readonly verifyEveryMs?: number | undefined;
  /** Test seam: how often the queue is looked at. @default TICK_MS */
  readonly tickMs?: number | undefined;
  /** The forge's CPU count; a 1-CPU forge holds pull checks for a crew run. @default forgeCpus */
  readonly cpus?: (() => number) | undefined;
  /** Crew runs working now. @default the running agent runs */
  readonly activeCrewRuns?: (() => number) | undefined;
  /** Test seams: how long a held pull check waits at most, and the clock it is judged by. */
  readonly holdMaxMs?: number | undefined;
  readonly holdNow?: (() => number) | undefined;
}

/** A gate's answer from the lane: `interrupted` is no verdict (#3155). */
export interface GateDone {
  ok: boolean;
  error: string;
  lines: string[];
  interrupted?: boolean;
  stage?: GateStage;
}

export interface ChecksHandle {
  /** Ask for a check of one commit; the answer is the run, or nothing when the commit declares no check. */
  request(
    repo: Repo,
    env: string,
    commitOid: string,
    reason: string,
    issueId?: string,
    actorId?: string,
  ): Promise<Run | undefined>;
  /**
   * The full tier on a merge, before it is made (#1198): `commitOid` is the
   * merge of the pull with its base, run in a clone of its own. Nothing is
   * queued and no run is written; the answer is the verdict. `interrupted`
   * is a gate that did not finish for a reason that is not the code — this
   * forge stopping, or the cluster losing its Job — and is no verdict (#3155).
   * `signal` aborting (the queue's deadline, #3430) cuts it off the same way.
   */
  gate(repo: Repo, pull: Pull, commitOid: string, signal?: AbortSignal): Promise<GateDone>;
  /**
   * The gate of `commitOid` this forge is running now, to wait on rather
   * than start again (#6611); undefined when none is.
   */
  adopt?(commitOid: string): Promise<GateDone> | undefined;
  /**
   * Stop checking. Checks under way get `drainMs` to finish unless `drain`
   * is false (a person's Ctrl-C): then they are cut off and queued again now.
   */
  stop(options?: { drain?: boolean }): Promise<void>;
  /**
   * Check slots free now for a merge-queue gate beyond a line's first
   * (#4053): what neither a running check nor such a gate holds, less
   * `PULL_RESERVE` kept for pull checks.
   */
  spareSlots(): number;
  /** The gate checks take their turn at; a hosted child's checks share it. */
  readonly lane: Gate;
  /**
   * Ask for every verification after landing that is due now
   * (`checks/verify.ts`); the answer is the runs asked for. The forge's
   * own timer calls it when `verifyEveryMs` is set.
   */
  verifyDue(now?: number): Promise<Run[]>;
}

/**
 * Check slots the merge queue's extra gates never take (#4053): pull checks
 * always have at least these, however long the queue.
 */
export const PULL_RESERVE = 2;

/**
 * How long main's check after a land waits to start (#4061). The merge queue
 * lands a candidate's steps seconds apart, and only its tip was gated: a
 * step's check that started at once ran the full suite on a commit the next
 * step replaced, up to seven of them filling the lane for nine minutes. A
 * step's check that waits is superseded by the next while still queued, and
 * the tip's is proven green by the gate.
 */
export const LAND_SETTLE_MS = 30_000;

/** The longest a failed test is given to pass alone, in seconds. */
const RERUN_TIMEOUT_S = 300;

/** How often queued checks another forge left are looked for. */
const TICK_MS = 5_000;

/**
 * How long a queued check may wait before it outranks a newer one however
 * fresh: the bound that keeps `pickNext` from starving a pull nobody has
 * pushed to in a while. Half the lane's budget (#4061): at the budget
 * itself, every check the newest-first order passed over waited exactly
 * long enough to make the lane a cause, even when the lane kept up.
 */
export const STARVATION_MS = BUDGETS.laneWait / 2;

/**
 * Whether a pull's check must pass over the free slots left (`free`): while
 * a merge-queue gate is about to start (`gateQueued`), the last one is the
 * gate's.
 */
export function holdsLastSlot(free: number, gateWaits: boolean): boolean {
  return gateWaits && free <= 1;
}

/**
 * Which queued check takes a slot when one frees: the one requested most
 * recently, so a push's own check is never stuck behind pulls that queued
 * hours earlier — unless something has already waited `STARVATION_MS` or
 * more, in which case the longest-waiting check goes first regardless of
 * how fresh the rest are. Checks of approved pulls (`approved`) go before
 * the rest, newest first among themselves (#6396): a check that is the last
 * thing between a pull and landing is not held up by a new pull's. Ties
 * (down to the same instant) fall back to id order, which is itself
 * creation order (`kernel/id.ts`).
 */
export function pickNext(
  queued: readonly Run[],
  now: number = Date.now(),
  approved: (run: Run) => boolean = () => false,
): Run | undefined {
  if (queued.length === 0) return undefined;
  const newer = (a: Run, b: Run): boolean =>
    a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);
  let oldest = queued[0]!;
  let newest: Run | undefined;
  let newestApproved: Run | undefined;
  for (const run of queued) {
    if (newer(oldest, run)) oldest = run;
    if (newest === undefined || newer(run, newest)) newest = run;
    if (approved(run) && (newestApproved === undefined || newer(run, newestApproved)))
      newestApproved = run;
  }
  if (now - Date.parse(oldest.createdAt) >= STARVATION_MS) return oldest;
  return newestApproved ?? newest;
}

/**
 * Settle the checks a dead forge left running, and say so on the bus: a
 * check whose commit still heads an open pull is queued again for whichever
 * checks service is up to run, so the change keeps reading *working*.
 * Called on boot and on the way by whichever forge is alive. A cancelled
 * check is not announced, as a superseded one is not: `run.finished` reads
 * as a verdict on the change, and the forge dying is none.
 */
export function requeueAbandonedChecks(app: App, staleMs: number): number {
  const swept = sweepAbandonedChecks(app.db, staleMs);
  for (const { cancelled, again } of swept.requeued) {
    appendRunLog(app.config.dataDir, cancelled.id, REQUEUED_SUMMARY);
    announceRun(app, again, again.actorId ?? undefined);
  }
  for (const run of swept.cancelled)
    appendRunLog(app.config.dataDir, run.id, run.summary);
  for (const run of swept.failed) {
    appendRunLog(app.config.dataDir, run.id, run.summary);
    announceRun(app, run);
  }
  // On the same timer: what a dead or lapsed run left on the disk. Removing
  // a checkout is thousands of unlinks: off the loop, never in front of /healthz (#7688).
  sweepSoon(app);
  return swept.requeued.length + swept.failed.length + swept.cancelled.length;
}

/**
 * Remove a run's directory even when the cell left read-only files in it (a
 * bun cache is): `rmSync` cannot unlink inside a directory without write
 * permission, so permissions are restored and the removal tried again. A
 * removal that still fails is logged, never swallowed.
 */
export async function removeRunDir(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
    return;
  } catch {
    /* fall through to restore permissions */
  }
  const open = async (p: string): Promise<void> => {
    try {
      if ((await lstat(p)).isSymbolicLink()) return;
      if ((await lstat(p)).isDirectory()) {
        await chmod(p, 0o700);
        for (const n of await readdir(p)) await open(join(p, n));
      }
    } catch {
      /* gone, or not ours: the retry says */
    }
  };
  await open(path);
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    log.error("could not remove a run directory", { path, error: String(error) });
  }
}

/** The sweep of the checkouts under way, if any: one at a time. */
let sweeping: Promise<void> | undefined;

/**
 * Sweep the checkouts in the background and answer when done. A sweep
 * already running is the one answered, not doubled; a failure is logged.
 */
export function sweepSoon(app: App, now: number = Date.now()): Promise<void> {
  sweeping ??= sweepCheckouts(app, now)
    .catch((error) => log.error("could not sweep the checkouts", { error: String(error) }))
    .finally(() => {
      sweeping = undefined;
    });
  return sweeping;
}

/** Where a check's checkout lives while it runs. */
const checksRoot = (dataDir: string): string => join(dataDir, "checks");

/** A gate's checkout (`gateRunId`): it has no run, only its `check_gate` row. */
const GATE_DIR = /^gate-([0-9a-f]{12})$/;

/** Whether a gate's checkout, this forge's or a peer's during a roll, is younger than a gate may run. */
function gateMayBeRunning(path: string, now: number): boolean {
  try {
    return now - lstatSync(path).mtimeMs < GATE_DEADLINE_MS;
  } catch {
    return false;
  }
}

/**
 * Remove the checkouts nobody is using: one whose run is not running with a
 * live lease, or has no run at all. A forge booting during a roll shares this
 * directory and database with the old one, whose checks are still running in
 * theirs; those are left alone. A gate writes no run: its checkout is left
 * while it is younger than a gate's deadline, and past that while its
 * `check_gate` row is open, for as long as a check may run.
 */
export async function sweepCheckouts(app: App, now: number = Date.now()): Promise<void> {
  const root = checksRoot(app.config.dataDir);
  if (!existsSync(root)) return;
  const since = new Date(now - CHECK_TIMEOUT_MAX * 1000);
  for (const name of readdirSync(root)) {
    // A gate has no run row: its checkout is spared until no gate could still be using it.
    if (name.startsWith("gate-") && gateMayBeRunning(join(root, name), now)) continue;
    // `<id>.home` is the home of run `<id>`: it lives and dies with it.
    const id = name.endsWith(".home") ? name.slice(0, -5) : name;
    const gate = GATE_DIR.exec(id);
    if (gate !== null) {
      if (!gateHolding(app.db, gate[1]!, since)) await removeRunDir(join(root, name));
      continue;
    }
    const run = getRun(app.db, id);
    const live =
      run !== undefined &&
      run.state === "running" &&
      !leaseLapsed(run, STALE_AFTER_MS, now);
    if (!live) await removeRunDir(join(root, name));
  }
}

/**
 * Under the free floor, give back what no check is using before taking more
 * (#6945): checkouts leaked by a crash sat on the disk until the next boot
 * while every check failed red on it. Answers whether it swept.
 */
export async function reclaimIfFull(app: App, now: number = Date.now()): Promise<boolean> {
  if (diskRecovered(app.config.dataDir)) return false;
  await sweepCheckouts(app, now);
  return true;
}

const handles = new WeakMap<App, ChecksHandle>();

/** The checks service of this forge, if one was started. */
export const checksFor = (app: App): ChecksHandle | undefined =>
  handles.get(app);

/** A test's stand-in checks service: what `checksFor` answers for this app. */
export function provideChecksForTest(app: App, handle: ChecksHandle): void {
  handles.set(app, handle);
}

export function startChecks(app: App, options: ChecksOptions): ChecksHandle {
  // Read on every pick (`core/capacity.ts`): an admin's change is honoured
  // by the next check, not the next boot. `concurrency` is the boot default.
  const booted = options.concurrency ?? 1;
  noteBooted(app.db, "checks.concurrency", String(booted));
  const capacity = (): number =>
    capacityCount(app.db, "checks.concurrency", booted);
  const gate = options.gate ?? new Gate(capacity());
  const placement = options.placement ?? placementFromEnv();
  /**
   * Full gates on land in flight: not slots in the queue, but stopped with
   * it — after the drain, as a check is. By commit, so a merge queue that
   * carries on adopts one rather than gate the same tip again (#6611).
   */
  const gates = new Map<AbortController, { commitOid: string; done: Promise<GateDone> }>();
  const inFlight = new Map<
    string,
    { promise: Promise<void>; abort: AbortController }
  >();
  /** Checks already told why they wait, so the log says it once. */
  const waiting = new Set<string>();
  /** Queued checks a full disk holds that have said so once (#11799); apart from `waiting`, so neither line hides the other. */
  const diskWaiting = new Set<string>();
  const memoryWaiting = new Set<string>();
  /** The verification-lane run in flight, which holds no check slot. */
  let verifying: string | undefined;
  const slotted = (): number => inFlight.size - (verifying === undefined ? 0 : 1);
  const settle = options.landSettleMs ?? 0;
  let stopped = false;

  sweepSoon(app);

  async function request(
    repo: Repo,
    env: string,
    commitOid: string,
    reason: string,
    issueId?: string,
    actorId?: string,
    notBefore?: string,
  ): Promise<Run | undefined> {
    // A suspended or removed owner's code is not run, not even to check it.
    if (stopped || !accountActive(app.db, repo.ownerId)) return undefined;
    // A guest's fork runs nothing: its code runs only as a pull a person approved.
    if (isContributionFork(app.db, repo.id)) return undefined;
    // A pull from someone who cannot write runs nothing until a writer
    // approves this exact head (`core/pull_trust.ts`).
    if (!issueMayRun(app.db, repo, issueId, commitOid)) {
      log.info("check waits for a writer's approval", {
        repo: `${repo.ownerName}/${repo.name}`,
        env,
        commit: commitOid.slice(0, 7),
      });
      return undefined;
    }
    // A sealed pull's commit is where its work is, never in the base (`pullDir`).
    const bare = await runDir(app.db, app.reposRoot, repo, issueId);
    const [forgeJson, packageJson] = await Promise.all([
      readFileAt(bare, commitOid, "forge.json"),
      readFileAt(bare, commitOid, "package.json"),
    ]);
    const declared = parseCheck(forgeJson, packageJson);
    if (declared.ok && declared.value === undefined) return undefined;
    // Main is verified after landing only where it says how (#7786).
    if (env === VERIFY_ENV && (!declared.ok || declared.value?.verify == null)) return undefined;
    // One check per environment at a time: a newer commit supersedes what
    // is still waiting, and the same commit is not checked twice. Looked for
    // and written in one write transaction, so a second forge process over
    // this database (a roll) cannot queue the same check beside it.
    const superseded: Run[] = [];
    const { run, fresh } = transact(app.db, () => {
      for (const active of listActive(app.db, "check")) {
        if (active.repoId !== repo.id || active.env !== env) continue;
        // A person asking for a check a red main holds queues it as theirs,
        // which runs (`checks/red_main.ts`); any other repeat is the same check.
        if (
          active.commitOid === commitOid &&
          !(reason === ASKED && active.state === "queued" && active.reason !== ASKED)
        )
          return { run: active, fresh: false };
        // A pull's running check is for a head nobody will land either:
        // it is stopped too, below, once the row says so.
        if (active.state === "queued" || issueId !== undefined) {
          const gone = cancelRun(
            app.db,
            active.id,
            `superseded by ${commitOid.slice(0, 7)}`,
          );
          if (gone && active.state === "running") superseded.push(gone);
        }
      }
      const created = createRun(app.db, {
        repoId: repo.id,
        kind: "check",
        env,
        commitOid,
        reason,
        ...(issueId === undefined ? {} : { issueId }),
        ...(actorId === undefined ? {} : { actorId }),
        ...(notBefore === undefined ? {} : { notBefore }),
      });
      return { run: created, fresh: true };
    });
    // The row is cancelled, so the check's own end finishes nothing and
    // announces nothing; the abort is what frees its slot and its checkout.
    for (const old of superseded) inFlight.get(old.id)?.abort.abort();
    if (!fresh) return run;
    announceRun(app, run, actorId);
    schedule();
    return run;
  }

  /** Run a queued check here, whichever forge queued it. */
  function start(run: Run, repo: Repo): void {
    if (inFlight.has(run.id)) return;
    waiting.delete(run.id);
    diskWaiting.delete(run.id);
    memoryWaiting.delete(run.id);
    const abort = new AbortController();
    const low = inVerifyLane(run.env);
    if (low) verifying = run.id;
    // A person's cancel (`cancelRepoRun`) reaches it through this.
    trackRun(run.id, abort);
    const promise = execute(run, repo, abort.signal, !low)
      .catch((error) =>
        log.error("check failed to execute", {
          run: run.id,
          error: String(error),
        }),
      )
      .finally(() => {
        untrackRun(run.id, abort);
        inFlight.delete(run.id);
        if (verifying === run.id) verifying = undefined;
        // The slot this run held is free again: give it to whichever queued
        // check now deserves it most, not whoever asked first.
        schedule();
      });
    inFlight.set(run.id, { promise, abort });
  }

  /**
   * An account at its concurrent-checks limit (`settings/quotas.ts`) keeps
   * the check queued, the count in its log once, until one of its own ends.
   */
  function atLimit(run: Run): boolean {
    const owner = getRepoById(app.db, run.repoId)?.ownerId;
    if (owner === undefined) return false;
    const full = runningLimitSentence(app.db, "checks", "concurrent checks", owner, () =>
      runningRuns(app.db, "check", owner, inFlight.keys()),
    );
    if (full === undefined) return false;
    if (!waiting.has(run.id)) {
      waiting.add(run.id);
      appendRunLog(app.config.dataDir, run.id, `queued, not started: ${full}`);
    }
    return true;
  }

  /**
   * Fill every free slot with the queued check `pickNext` says deserves it —
   * one the forge before this one never reached, one a forge stopping
   * beside this one handed back, or simply the newest push once a slot
   * opens up. Claiming is what decides between two forges, so calling this
   * from both never runs the same check twice.
   */
  /** `pickNext` among `queued`, passing over any whose account is at its limit. */
  function startable(queued: readonly Run[]): Run | undefined {
    // At 80% used no check starts (#11799): they stay queued, one line each, and the tick asks again.
    const full = usedRefusal(app.config.dataDir);
    if (full !== undefined) {
      for (const run of queued)
        if (!diskWaiting.has(run.id)) {
          diskWaiting.add(run.id);
          appendRunLog(app.config.dataDir, run.id, `queued, ${full}`);
        }
      return undefined;
    }
    // A child near its memory limit runs one check at a time (`runs/memory_hold.ts`).
    const tight = memoryHold(slotted(), options.pressure);
    if (tight !== undefined) {
      for (const run of queued)
        if (!memoryWaiting.has(run.id)) {
          memoryWaiting.add(run.id);
          appendRunLog(app.config.dataDir, run.id, `queued, ${tight}`);
        }
      return undefined;
    }
    let rest = queued;
    const isApproved = approvedOnce(app.db);
    let next = pickNext(rest, Date.now(), isApproved);
    while (next !== undefined && atLimit(next)) {
      const held = next;
      rest = rest.filter((run) => run !== held);
      next = pickNext(rest, Date.now(), isApproved);
    }
    return next;
  }

  const pullHold = holdClock(options.holdMaxMs);

  function schedule(): void {
    if (stopped) return;
    const limit = capacity();
    if (options.gate === undefined) gate.resize(limit);
    // On one CPU a pull's check waits while a crew run works, for at most
    // `holdMaxMs`; the verify lane, a rebase's check and a main check are the
    // pipeline and never wait (#11599).
    const crewHolds = crewHoldsCore((options.cpus ?? forgeCpus)(), options.activeCrewRuns ?? (() => activeCrewRuns(app.db)));
    // The clock counts one continuous hold: it starts again once no crew run
    // holds, and forgets checks that are no longer queued.
    if (!crewHolds) pullHold.reset();
    else pullHold.keep(new Set(listActive(app.db, "check").filter((run) => run.state === "queued").map((run) => run.id)));
    startVerify();
    // Every merge-queue gate in flight holds a slot, a line's first too (#6376).
    while (slotted() < limit - gatesInFlight()) {
      // A pull's check waits while its main is red (`checks/red_main.ts`).
      const queued = unheld(
        listActive(app.db, "check").filter(
          (run) =>
            run.state === "queued" &&
            !inFlight.has(run.id) &&
            !inVerifyLane(run.env) &&
            (run.notBefore === null || Date.parse(run.notBefore) <= Date.now()),
        ),
        (repoId) => redMain(app.db, repoId),
        options.redHoldMs ?? 0,
      );
      // The limit is asked at the point of starting, one pick at a time:
      // a started check is in flight before the next is asked about, so a
      // burst of one account's checks cannot pass together. A rebase's
      // check goes before any other (`finishing_first.ts`, #6140).
      const { rebases, rest: others } = rebasesFirst(app.db, queued);
      // While a gate is about to start, the last free slot is its: a pull's
      // check waits for it, a rebase's and a main check do not.
      const held = holdsLastSlot(limit - gatesInFlight() - slotted(), gateQueued());
      const waiting = crewHolds
        ? others.filter((run) => run.issueId === null || !pullHold.held(run.id, (options.holdNow ?? Date.now)()))
        : others;
      const next = startable(rebases) ?? startable(held ? waiting.filter((run) => run.issueId === null) : waiting);
      if (!next) return;
      const repo = getRepoById(app.db, next.repoId);
      if (!repo) return;
      pullHold.release(next.id);
      start(next, repo);
    }
  }

  /**
   * The verification lane (#7786): one run at a time, forge-wide, beside
   * the check slots rather than in one, so no landing and no pull's check
   * ever waits for it. A bisection step goes before a new verification.
   */
  function startVerify(): void {
    if (verifying !== undefined) return;
    const queued = listActive(app.db, "check").filter(
      (run) => run.state === "queued" && inVerifyLane(run.env) && !inFlight.has(run.id),
    );
    const next =
      queued.find((run) => bisectOrigin(run.reason) !== undefined) ?? queued[0];
    if (next === undefined) return;
    const repo = getRepoById(app.db, next.repoId);
    if (repo !== undefined) start(next, repo);
  }

  /** Every verification due now: main moved since the last, and that one is old enough. */
  async function askVerifications(now = Date.now()): Promise<Run[]> {
    const everyMs = options.verifyEveryMs ?? VERIFY_EVERY_MS;
    const since = new Date(now - 24 * 3_600_000).toISOString();
    // The newest default-branch check of each repository that had one today.
    const tips = app.db
      .query<{ repo_id: string; commit_oid: string }, [string]>(
        `SELECT r.repo_id, r.commit_oid FROM run r JOIN repo ON repo.id = r.repo_id
          WHERE r.id IN (SELECT MAX(x.id) FROM run x JOIN repo y ON y.id = x.repo_id
                          WHERE x.kind = 'check' AND x.issue_id IS NULL
                            AND x.env = y.default_branch AND x.created_at >= ?1
                          GROUP BY x.repo_id)`,
      )
      .all(since);
    const asked: Run[] = [];
    for (const tip of tips) {
      const last = app.db
        .query<{ commit_oid: string; created_at: string }, [string]>(
          `SELECT commit_oid, created_at FROM run
            WHERE repo_id = ?1 AND kind = 'check' AND env = '${VERIFY_ENV}'
            ORDER BY id DESC LIMIT 1`,
        )
        .get(tip.repo_id);
      const active = listActive(app.db, "check").some(
        (run) => run.repoId === tip.repo_id && inVerifyLane(run.env),
      );
      const due = verifyDue({
        tip: tip.commit_oid,
        last: last === null ? undefined : { commitOid: last.commit_oid, createdAt: last.created_at },
        active,
        now,
        everyMs,
      });
      if (!due) continue;
      const repo = getRepoById(app.db, tip.repo_id);
      if (repo === undefined) continue;
      const run = await request(repo, VERIFY_ENV, tip.commit_oid, VERIFY_REASON);
      if (run !== undefined) asked.push(run);
    }
    return asked;
  }

  /**
   * An open pull whose head was never checked — the event that should have
   * asked landed while a forge was on its way out, or before this forge
   * existed — is asked for on boot. A pull that stays unchecked would never
   * land on green, however green it is.
   */
  async function catchUp(): Promise<void> {
    const heads = app.db
      .query<
        { repo_id: string; issue_id: string; number: number; head_oid: string },
        []
      >(
        `SELECT issue.repo_id, issue.id AS issue_id, issue.number, pull.head_oid
           FROM pull JOIN issue ON issue.id = pull.issue_id
          WHERE issue.state = 'open' AND pull.merged_at IS NULL
          ORDER BY issue.created_at DESC LIMIT 200`,
      )
      .all();
    for (const head of heads) {
      if (head.head_oid === "") continue;
      if (checksForHead(app.db, head.issue_id, head.head_oid).length > 0)
        continue;
      const repo = getRepoById(app.db, head.repo_id);
      if (!repo) continue;
      try {
        await request(
          repo,
          `pull-${head.number}`,
          head.head_oid,
          "boot",
          head.issue_id,
        );
      } catch (error) {
        log.error("check could not be requested on boot", {
          pull: head.number,
          error: String(error),
        });
      }
    }
  }

  async function execute(
    run: Run,
    repo: Repo,
    signal: AbortSignal,
    slot = true,
  ): Promise<void> {
    // The verification lane takes no slot of the gate (`startVerify`).
    const release = slot ? await gate.acquire() : () => {};
    try {
      // A slot that opens while this forge is stopping is not taken: the run
      // stays queued for the forge that carries on.
      if (stopped) return;
      // Asked again as it starts: a check queued before a rule changed, or
      // handed back by a forge that stopped, runs only what may run now.
      if (!issueMayRun(app.db, repo, run.issueId, run.commitOid)) {
        cancelRun(app.db, run.id, "waiting for a writer to approve this head");
        return;
      }
      const claimed = claimRun(app.db, run.id);
      if (!claimed) return;
      const lease = holdLease(app.db, run.id);
      announceRun(app, claimed);
      const write = (line: string): void => {
        appendRunLog(app.config.dataDir, run.id, line);
        announceShard(app, run, line);
      };
      if (options.label !== undefined)
        write(`forge ${options.label} — checked in its parent's lane`);
      const started = Date.now();
      // The budget: past it the check is aborted, whatever it is doing.
      const limit = options.budgetMs ?? BUDGETS.gate;
      const budget = new AbortController();
      let overran = false;
      const forward = (): void => budget.abort();
      signal.addEventListener("abort", forward, { once: true });
      const clock = setTimeout(() => {
        overran = true;
        budget.abort();
      }, limit);
      const outcome = await check(claimed, repo, write, budget.signal).finally(
        () => {
          clearTimeout(clock);
          signal.removeEventListener("abort", forward);
          lease();
        },
      );
      if (overran) {
        const summary = budgetSummary(
          "a full gate",
          Date.now() - started,
          limit,
        );
        write(summary);
        if (!overranBefore(app.db, claimed)) {
          const moved = requeueCheck(app.db, run.id, undefined, summary);
          if (moved) {
            announceRun(app, moved.again, run.actorId ?? undefined);
            return;
          }
        }
        // The second overrun: a failure, and the card the vitals carry.
        const failed = finishRun(app.db, run.id, {
          state: "failed",
          summary,
        });
        if (failed) announceRun(app, failed);
        return;
      }
      // Ended from outside while it ran: its pull landed or closed, and
      // the row says so. That is not this check failing.
      // A person's cancel ends the log with who cancelled it (#11229).
      const row = getRun(app.db, run.id);
      if (!outcome.ok && row?.state === "cancelled") {
        write(cancelledLine(row) ?? `superseded: ${row.summary}`);
        return;
      }
      if (!outcome.ok && stopped && signal.aborted) {
        // Cut off by this forge stopping, not by the check: the same check
        // goes back on the queue, and the forge that carries on runs it.
        const moved = requeueCheck(app.db, run.id);
        if (!moved) return;
        write(REQUEUED_SUMMARY);
        announceRun(app, moved.again, run.actorId ?? undefined);
        return;
      }
      // The cluster lost the Job (evicted, node gone): interrupted, not
      // failed, and queued once more as after a restart; the second loss fails.
      if (!outcome.ok && outcome.error === JOB_VANISHED && !vanishedBefore(app.db, claimed)) {
        const moved = requeueCheck(app.db, run.id, undefined, VANISHED_SUMMARY);
        if (moved) {
          write(VANISHED_SUMMARY);
          announceRun(app, moved.again, run.actorId ?? undefined);
          return;
        }
      }
      // The install failed twice on what the machine did, not the code: the
      // check is queued once more and nothing reads it as red (#5093).
      if (!outcome.ok && outcome.infrastructure === true && !infraBefore(app.db, claimed)) {
        const moved = requeueCheck(app.db, run.id, undefined, INFRA_SUMMARY);
        if (moved) {
          write(INFRA_SUMMARY);
          announceRun(app, moved.again, run.actorId ?? undefined);
          return;
        }
      }
      // The disk was 80% used when the step would have started (#11799):
      // the machine's wait. Queued again, not red; the pick holds it until there is room.
      if (!outcome.ok && isUsedRefusal(outcome.error)) {
        const moved = requeueCheck(app.db, run.id, undefined, DISK_USED_SUMMARY);
        if (moved) {
          write(DISK_USED_SUMMARY);
          announceRun(app, moved.again, run.actorId ?? undefined);
          return;
        }
      }
      // Stopped for CPU by the cell's watch: the machine's, not the pull's.
      // Queued once more on its own, and no builder hears check_failed for
      // it; a second stop in a row is reported as any red is (#11617).
      if (!outcome.ok && outcome.cpuStop !== undefined) {
        const moved = requeueCpuStop(app.db, claimed, outcome.cpuStop);
        if (moved) {
          write(CPU_STOP_SUMMARY);
          announceRun(app, moved.again, run.actorId ?? undefined);
          return;
        }
      }
      const seconds = Math.round((Date.now() - started) / 1000);
      const done = finishRun(app.db, run.id, {
        state: outcome.ok ? "ok" : "failed",
        summary: outcome.ok
          ? outcome.proven === undefined
            ? `check passed in ${seconds}s${outcome.cleared === undefined ? "" : `; ${outcome.cleared}`}`
            : `already proven green by ${outcome.proven}`
          : `check failed: ${outcome.error}`,
        ...(outcome.ok
          ? {}
          : { checkDetail: withDisk(outcome.detail, app.config.dataDir) }),
      });
      write(outcome.ok ? `passed in ${seconds}s` : `failed: ${outcome.error}`);
      if (done) announceRun(app, done);
      if (done && outcome.ok) releaseOnGreen(app, done);
      if (!outcome.ok && run.issueId === null && run.env === repo.defaultBranch)
        proposeRevert(app, repo.id).catch((error) =>
          log.error("revert proposal failed", { error: String(error) }),
        );
      // A red verification after landing names its culprit (#7786).
      if (done && run.env === VERIFY_ENV) {
        reportRed(app, repo, done).forEach(write);
        // A file the run printed passing closes its open report issue (#9524).
        reportGreen(app, repo, done, outcome.passed ?? []).forEach(write);
        // A green that ran every file a culprit's issue names closes it (#11395).
        closeOnGreen(app, repo, done, outcome.passed ?? []).forEach(write);
      }
      if (done && inVerifyLane(run.env))
        await afterVerify(app, repo, done, (r, env, oid, reason) => request(r, env, oid, reason))
          .then((lines) => lines.forEach(write))
          .catch((error) => write(`culprit not named: ${String(error)}`));
    } finally {
      release();
    }
  }

  async function check(
    run: Run,
    repo: Repo,
    write: (line: string) => void,
    signal: AbortSignal,
  ): Promise<
    | {
        ok: true;
        proven?: string;
        passed?: readonly string[];
        /** A red it cleared as main's (#10304): `base_red.ts`'s words, kept in the summary. */
        cleared?: string;
      }
    | { ok: false; error: string; detail?: CheckDetail | undefined; infrastructure?: boolean; cpuStop?: string; passed?: readonly string[] }
  > {
    const bare = await runDir(app.db, app.reposRoot, repo, run.issueId);
    // A pull's check is the fast tier, judged against where the pull left
    // the base; anything else is the whole check (`apps/manifest.ts`).
    const issue =
      run.issueId === null ? undefined : getIssueById(app.db, run.issueId);
    const pull =
      issue?.kind === "pull" ? getPull(app.db, repo.id, issue.number) : undefined;
    if (inVerifyLane(run.env)) {
      // A bisection step runs only the red's failed files, with the red's
      // own command: an older commit may not say how to verify (#7786).
      const origin = run.env === VERIFY_ENV ? undefined : getRun(app.db, bisectOrigin(run.reason) ?? "");
      if (run.env !== VERIFY_ENV && origin === undefined)
        return { ok: false, error: "the red verification this step bisects is gone" };
      return runTier({
        bare,
        repo,
        id: run.id,
        runId: run.id,
        commitOid: run.commitOid,
        tier: "verify",
        ...(origin === undefined
          ? { keepImpact: true }
          : { only: origin.checkDetail?.files ?? [], commandsFrom: origin.commitOid }),
        fileOrderDependent: origin === undefined,
        isMain: true,
        write,
        signal,
      });
    }
    const outcome = await runTier({
      bare,
      repo,
      id: run.id,
      runId: run.id,
      commitOid: run.commitOid,
      pull,
      tier: pull === undefined ? "run" : "fast",
      keep: run.issueId === null && run.env === repo.defaultBranch,
      keepImpact: pull === undefined && run.env === repo.defaultBranch,
      fileOrderDependent: run.issueId === null && run.env === repo.defaultBranch,
      isMain: run.issueId === null && run.env === repo.defaultBranch,
      write,
      signal,
    });
    return outcome;
  }

  interface Execution {
    readonly bare: string;
    readonly repo: Repo;
    /** Names the checkout. */
    readonly id: string;
    readonly runId?: string;
    readonly commitOid: string;
    readonly pull?: Pull | undefined;
    /** `run`: a push to a branch; `fast`: a pull's push; `full`: on land; `verify`: main after landing. */
    readonly tier: "run" | "fast" | "full" | "verify";
    /** A bisection step: only these test files run (`FORGE_CHECK_ONLY`). */
    readonly only?: readonly string[];
    /** A bisection step: the commit whose `check.verify` it runs. */
    readonly commandsFrom?: string;
    /** A check of the default branch's own push: its cache is kept. */
    readonly keep?: boolean;
    /** A green run keeps the impact map it measured; `full` always does. */
    readonly keepImpact?: boolean;
    /** The default branch's own run: only its log may open issues. */
    readonly fileOrderDependent?: boolean;
    /** The default branch's own run: a failure of one or two tests is re-run alone before it counts as red. */
    readonly isMain?: boolean;
    readonly write: (line: string) => void;
    readonly signal: AbortSignal;
  }

  async function runTier(
    x: Execution,
  ): Promise<
    | {
        ok: true;
        proven?: string;
        passed?: readonly string[];
        /** A red it cleared as main's (#10304): `base_red.ts`'s words, kept in the summary. */
        cleared?: string;
      }
    | {
        ok: false;
        error: string;
        detail?: CheckDetail | undefined;
        /** A whole verification: the files its log ran to the end green (#9524). */
        passed?: readonly string[];
        infrastructure?: boolean;
        /** The check step's error when the cell's watch stopped it for CPU (#11617). */
        cpuStop?: string;
        /** Where it stopped red (#5276); none is before any step ran. */
        stage?: GateStage;
        /** The check step was ended by a signal from outside: no verdict (#6722). */
        killed?: boolean;
      }
  > {
    const { bare, repo, write, signal } = x;
    // A pull's fast check is of the pull as it would land: its head merged
    // into the base's tip. The gate comes from that tree, so a pull forked
    // before the base learned something is judged with it.
    let source = x.commitOid;
    let tip: string | undefined;
    // The commit the checked tree builds on: the base tip for a merge made
    // now, the base a combined commit names for a kept fork's pull. The fast
    // tier diffs against it, so a combined built before main moved is not
    // charged with main's later changes.
    let builtOnBase: string | undefined;
    let mergeLine = "";
    if (x.tier === "fast" && x.pull !== undefined) {
      tip = await resolveOid(bare, `refs/heads/${x.pull.baseBranch}`);
      if (tip === undefined)
        return { ok: false, error: `the base ${x.pull.baseBranch} could not be found` };
      // A kept fork's pull is checked on its combined commit (#9932): the
      // tree that lands, built on the base tip it names (`combined/N`).
      const combined = x.pull.crossRepo
        ? await readCombined(bare, x.pull.number, x.commitOid)
        : undefined;
      if (combined !== undefined && combined.oid !== x.commitOid) {
        source = combined.oid;
        const builtOn = combined.baseOid === "" ? tip : combined.baseOid;
        if (x.runId !== undefined) {
          setRunBase(app.db, x.runId, builtOn);
          setRunCombined(app.db, x.runId, combined.oid);
        }
        builtOnBase = builtOn;
        mergeLine = `checked as combined with ${x.pull.baseBranch} at ${builtOn.slice(0, 7)} (${combined.oid.slice(0, 7)})`;
      } else {
        const merged = await mergeForCheck(bare, x.pull.baseBranch, tip, x.commitOid);
        if (!merged.ok) return { ok: false, error: merged.error };
        source = merged.commit;
        if (x.runId !== undefined) setRunBase(app.db, x.runId, tip);
        builtOnBase = tip;
        mergeLine = merged.line;
      }
    }
    const run = { id: x.id, commitOid: source };
    const [forgeJson, packageJson] = await Promise.all([
      readFileAt(bare, run.commitOid, "forge.json"),
      readFileAt(bare, run.commitOid, "package.json"),
    ]);
    const declared = parseCheck(forgeJson, packageJson);
    if (!declared.ok)
      return {
        ok: false,
        error:
          declared.error.kind === "invalid"
            ? declared.error.message
            : "this commit declares no check",
      };
    if (declared.value === undefined)
      return { ok: false, error: "this commit declares no check" };
    // A pull does not choose its own gate: the commands and the timeout come
    // from the base branch's `forge.json` where the pull left it. The
    // branch's own supplies only what it needs to run (install, egress,
    // limits).
    let manifest = declared.value;
    let baseTip: string | undefined;
    if (x.pull !== undefined) {
      baseTip = await resolveOid(bare, `refs/heads/${x.pull.baseBranch}`);
      if (baseTip === undefined)
        return { ok: false, error: "the pull's base branch could not be found" };
      const [baseJson, basePackage] = await Promise.all([
        readFileAt(bare, baseTip, "forge.json"),
        readFileAt(bare, baseTip, "package.json"),
      ]);
      const gate = parseCheck(baseJson, basePackage);
      if (!gate.ok)
        return {
          ok: false,
          error:
            gate.error.kind === "invalid"
              ? `${x.pull.baseBranch}: ${gate.error.message}`
              : "the base branch declares no check",
        };
      if (gate.value !== undefined) {
        manifest = {
          ...manifest,
          run: gate.value.run,
          fast: gate.value.fast,
          full: gate.value.full,
          timeout: gate.value.timeout,
        };
        write(
          `tier ${x.tier} from ${x.pull.baseBranch}@${baseTip.slice(0, 7)}`,
        );
      }
    }
    if (x.commandsFrom !== undefined) {
      const from = parseCheck(await readFileAt(bare, x.commandsFrom, "forge.json"), undefined);
      if (from.ok && from.value !== undefined) manifest = { ...manifest, verify: from.value.verify, timeout: from.value.timeout };
    }
    if (x.tier === "verify" && manifest.verify === null)
      return { ok: false, error: "this commit declares no check.verify" };
    const command =
      x.tier === "full"
        ? manifest.full
        : x.tier === "fast"
          ? (manifest.fast ?? manifest.run)
          : x.tier === "verify"
            ? manifest.verify!
            : manifest.run;
    // The fast tier diffs what the pull changes against the commit it builds
    // on, which the clone is given as a repository of its own: `origin/main`
    // is not a ref there.
    const base = manifest.fast !== null ? builtOnBase : undefined;
    // The tree this runs on under this gate has been green before: that is
    // the verdict, and nothing is checked out (#1795).
    const learned =
      base === undefined ? "" : readLearned(app.config.dataDir, x.pull!.id).join(",");
    const tree = await runGit(["rev-parse", `${run.commitOid}^{tree}`], { cwd: bare });
    // A bisection step runs a slice: its green proves nothing of the whole.
    const key = tree.ok && x.only === undefined
      ? checkKey({
          repoId: repo.id,
          treeOid: tree.value.trim(),
          command,
          install: manifest.install,
          timeout: manifest.timeout,
          egress: manifest.egress,
          limits: manifest.limits,
          base,
          learned,
        })
      : undefined;
    const earlier = key === undefined ? undefined : provenBy(app.db, key);
    if (earlier !== undefined) {
      write(`already proven green by ${earlier}`);
      return { ok: true, proven: earlier };
    }
    if (await reclaimIfFull(app)) write("disk under its free floor: swept unused checkouts");
    const dir = join(checksRoot(app.config.dataDir), run.id);
    mkdirSync(dir, { recursive: true });
    write(mergeLine === "" ? `checking out ${run.commitOid.slice(0, 7)}` : mergeLine);
    const exported = await exportTree(bare, run.commitOid, dir);
    if (!exported.ok) return { ok: false, error: exported.error };
    if (base !== undefined) {
      const given = await giveHistory(bare, dir, base, run.commitOid);
      if (!given.ok) {
        await rm(dir, { recursive: true, force: true });
        return { ok: false, error: given.error };
      }
    }
    // What the base's own check left (`checks/cache.ts`): tsc's build info
    // and the gate's per-file times, keyed by the commit this one builds on.
    const cached = restoreCache(
      app.config.dataDir,
      repo.id,
      builtOnBase === undefined ? [] : [builtOnBase],
      dir,
    );
    if (cached !== undefined) write(`cache from ${cached.slice(0, 7)}`);
    // Every check starts from the impact map the last green default-branch
    // run measured; the fast tier selects by it.
    try {
      const seeded = seedImpact(app.config.dataDir, repo.id, dir);
      if (seeded > 0) write(`impact map: ${seeded} tests, from the last green ${repo.defaultBranch}`);
    } catch (error) {
      write(`impact map not seeded: ${String(error)}`);
    }
    // The check is repository code: it runs in a cell of its own
    // (`apps/contain.ts`), its checkout and a home its only places to write,
    // the forge, the registry and what it declared its only way out.
    // A Job cannot hold egress (#1428), so while it is enforced the check
    // stays in a cell. Read per run: an admin can flip it at runtime.
    const fellBack = placement.mode === "job" && egressSetting(app.db) === "enforce";
    const placed: Placement = fellBack ? { mode: "process" } : placement;
    const job = placed.mode === "job" ? placed : undefined;
    if (x.runId !== undefined)
      noteRunProgress(app.db, x.runId, { placement: placed.mode });
    if (fellBack)
      write("placement: job skipped, egress is enforced and a Job cannot hold it");
    // A Job is its own boundary: no cell here, the cluster holds it.
    const cells = job === undefined ? await cellsAvailable() : undefined;
    if (cells !== undefined) {
      if (x.runId !== undefined)
        noteRunProgress(app.db, x.runId, {
          sandbox: { enforced: cells.ok, note: cells.ok ? "" : cells.reason },
        });
      if (!cells.ok)
        write(`uncontained here: ${cells.reason}; the check runs unrestricted`);
    } else {
      // The cluster holds a Job, but not as a cell does: the egress a
      // check declared is not enforced here, and the run says so.
      if (x.runId !== undefined)
        noteRunProgress(app.db, x.runId, {
          sandbox: { enforced: false, note: "egress not enforced on a cluster job" },
        });
      write("placement: job");
    }
    const home = `${dir}.home`;
    const cell: CellSpec | undefined = cells?.ok
      ? {
          dir,
          writable: [],
          home,
          hide: cellHides(app),
          egress: [...STEP_HOSTS, ...manifest.egress],
          reach: [options.forgeUrl],
          limits: resolveLimits("step", manifest.limits),
          onUndeclared: (host, port) =>
            noteReached(app.config.dataDir, repo.id, host, port),
          egressMode: egressSetting(app.db),
          label: `check:${run.id}`,
        }
      : undefined;
    try {
      for (const line of limitWarnings(manifest.limits)) write(line);
      const cellCpus = resolveLimits("step", manifest.limits).cpus;
      const env = childEnv({
        // The shard count an admin set (`core/capacity.ts`), else the
        // default sized to what this check's cell holds, never the pod's.
        ...capacityEnv(app.db, workerCpus(cpuLimit(), cellCpus)),
        CI: "1",
        FORGE_URL: options.forgeUrl,
        FORGE_CHECK: run.id,
        FORGE_COMMIT: x.commitOid,
        FORGE_CHECK_IMPACT: IMPACT_FILE,
        ...(x.only === undefined ? {} : { FORGE_CHECK_ONLY: onlyEnv(x.only) }),
        // The cell's CPU limit, which `availableParallelism()` may not
        // report inside it; the shard count follows this (#2257).
        FORGE_CELL_CPUS: String(cellCpus),
        // The one place besides the checkout the cell can write on disk; its
        // own /tmp is a 256 MiB tmpfs the shards would fill (#8679).
        ...scratchEnv(cell === undefined ? undefined : home),
        ...(base === undefined
          ? {}
          : {
              FORGE_CHECK_BASE: base,
              FORGE_CHECK_LEARNED: learned,
            }),
        // A cell inside a cell is not a cell. This check's own cell is the
        // boundary; a forge the tests boot inside it would wrap its apps in
        // nested cells, and those never answer in time. Its children run as
        // plain processes here — as they do on a runner without bwrap.
        FORGE_CELLS: "off",
      });
      let ran: Result<void, string>;
      const checkLines: string[] = [];
      // A bisection step runs only some files: what it shows green says nothing of the rest.
      const wholeVerify = x.tier === "verify" && x.only === undefined;
      if (job !== undefined) {
        ran = await runJobStep(job, {
          runId: run.id,
          dir,
          commands: manifest.install === null ? [command] : [manifest.install, command],
          env,
          log: write,
          output: checkLines,
          signal,
          timeoutMs: manifest.timeout * 1000,
          limits: resolveLimits("step", manifest.limits),
          onNode: (node) => {
            if (x.runId !== undefined) noteRunProgress(app.db, x.runId, { node });
          },
          ...(options.job === undefined ? {} : { options: options.job }),
        });
      } else {
        if (manifest.install !== null) {
          const install = manifest.install;
          // A cell's home is its own cache. Uncontained, the repository's
          // cache is shared, so installs into it take turns (`checks/install.ts`).
          const shared =
            cell === undefined ? checkInstallCache(app.config.dataDir, repo.id) : undefined;
          // A cell installs from that same cache, bound read-only (#7543):
          // the forge fills it first, on the host, so no pull writes what
          // the gate on main installs. Cluster jobs (`runJobStep`) are
          // unchanged: a Job has its own cache and never takes this path.
          const warm = cell === undefined ? undefined : checkInstallCache(app.config.dataDir, repo.id);
          // Set once the fill has run: a cell installs from the shared cache
          // only when the forge filled it; otherwise it keeps a cache of its own.
          let filled = false;
          const once = (log: (line: string) => void): Promise<Result<void, string>> => {
            const base = shared === undefined ? env : { ...env, BUN_INSTALL_CACHE_DIR: shared };
            const from = cellInstall(install, base, filled ? warm : undefined);
            const revealed = cell !== undefined && filled && warm !== undefined ? { ...cell, reveal: [warm] } : cell;
            return runStep("install", from.command, {
              cwd: dir,
              env: from.env,
              log,
              signal,
              timeoutMs: manifest.timeout * 1000,
              cell: revealed,
            });
          };
          // What the cell's proxy received, for the one line that shows the cache
          // working (#7546). Uncontained, nothing is logged: the shared cache
          // is not metered, and its growth is wrong under concurrent checks.
          // Stopped in `finally`, so a throw never leaves the label metered;
          // over a MiB from the npm registry adds the miss line (#8382).
          const installed = await meteredInstall(
            cell === undefined ? undefined : `check:${run.id}`,
            repo.id,
            () =>
              installWithRetry(
                async (log) => {
                  if (shared === undefined) {
                    if (warm !== undefined) {
                      const fill = await prefillInstallCache({
                        cache: warm,
                        dir,
                        env,
                        log,
                        signal,
                        timeoutMs: manifest.timeout * 1000,
                      });
                      if (!fill.ok) return fill;
                      filled = fill.value;
                      void evictSoon(warm, process.env);
                    }
                    return once(log);
                  }
                  mkdirSync(shared, { recursive: true });
                  const held = await withLock(
                    `${shared}.lock`,
                    async () => {
                      const done = await once(log);
                      if (done.ok) lend(shared, dir);
                      return done;
                    },
                    { signal },
                  );
                  if (held.ok && held.value.ok) void evictSoon(shared, process.env);
                  return held.ok ? held.value : held;
                },
                { log: write, signal, retryMs: options.installRetryMs },
            ),
            write,
            { fetched: true },
          );
          if (!installed.ok)
            return {
              ok: false,
              error: installed.error,
              infrastructure: installed.infrastructure,
              stage: "install",
            };
        }
        // The check step's own lines are kept beside what `write` already
        // logs, so a failure can be summarised once here — never by reading
        // the log back, on this run or any later render of it. `runStep`
        // echoes the command as its first line before any output of the
        // command's own; that echo is not output to summarise from.
        let sawEcho = false;
        ran = await (options.checkStep ?? runStep)("check", command, {
          cwd: dir,
          env,
          log: (line) => {
            if (sawEcho) checkLines.push(line);
            sawEcho = true;
            write(line);
          },
          signal,
          timeoutMs: manifest.timeout * 1000,
          cell,
        });
      }
      if (!ran.ok && ran.error === JOB_VANISHED) return { ok: false, error: JOB_VANISHED };
      // A file the gate cleared because it passed alone is still a failure
      // to track: the cell cannot reach the forge, so it is filed from here.
      try {
        // Only the default branch's own run files: a pull branch controls
        // its check's output, and the issues are authored as the owner.
        const all =
          x.fileOrderDependent === true
            ? clearedFiles(checkLines)
            : [];
        const cleared = all.slice(0, MAX_FILED);
        if (cleared.length > 0) {
          fileOrderDependent(app.db, app.bus, repo, cleared, {
            runId: run.id,
            commit: run.commitOid,
          });
          write(`filed: ${cleared.length} test file(s) that fail only beside others`);
          if (all.length > cleared.length)
            write(`not filed: ${all.length - cleared.length} more (at most ${MAX_FILED} per run)`);
        }
      } catch (error) {
        write(`order-dependent tests not filed: ${String(error)}`);
      }
      // Main's red costs the forge every pull's check (#6643): one or two
      // failed tests are re-run alone, on this commit in this cell, before
      // main counts as red. Passing alone is a flake: green, and recorded.
      // A pull's red is the same unless the pull touched the test (#7426).
      if (!ran.ok && job === undefined && (x.isMain === true || tip !== undefined)) {
        try {
          let tests = rerunnable(checkLines, parseBunTestFailure(checkLines));
          if (tests !== undefined && x.isMain !== true) {
            const diff = await runGit(
              ["diff", "--name-only", "-z", `${tip}...${x.commitOid}`],
              { cwd: bare },
            );
            const changed = diff.ok ? diff.value.split("\0").filter((p) => p !== "") : undefined;
            const read = (path: string): string | undefined => {
              try {
                return readFileSync(join(dir, path), "utf8");
              } catch {
                return undefined;
              }
            };
            if (pullOwnsRed(tests, changed, read)) {
              write("not re-run alone: the pull changed a failed test or what it imports");
              tests = undefined;
            }
          }
          if (tests !== undefined) {
            write(`re-running ${tests.length} failed test(s) alone`);
            let alone = true;
            for (const test of tests) {
              const out: string[] = [];
              const again = await runStep("flake", rerunCommand(test), {
                cwd: dir,
                env,
                log: (line) => {
                  out.push(line);
                  write(line);
                },
                signal,
                timeoutMs: Math.min(manifest.timeout, RERUN_TIMEOUT_S) * 1000,
                cell,
              });
              if (!again.ok || !passedAlone(out)) {
                alone = false;
                write(`"${test.name}" fails alone too: ${x.isMain === true ? "main" : "the check"} is red`);
                break;
              }
            }
            if (alone) {
              recordFlakes(app.db, app.bus, repo, tests, { runId: run.id, commit: run.commitOid, pull: x.isMain !== true });
              for (const t of tests) write(`flake: ${t.file} > ${t.name} passed alone`);
              write(`flaky: ${tests.map((t) => `"${t.name}"`).join(", ")} failed in the full run and passed alone; recorded, ${x.isMain === true ? "main" : "the check"} stays green`);
              ran = { ok: true, value: undefined };
            }
          }
        } catch (error) {
          write(`flake re-run failed: ${String(error)}`);
        }
      }
      // A shard that crashed outside any test and ran green once more (#7781).
      {
        try {
          recordCrashFlakes(app.db, app.bus, repo, checkLines, { runId: run.id, commit: run.commitOid, pull: x.isMain !== true }, ran.ok);
        } catch (error) {
          write(`crash flakes not recorded: ${String(error)}`);
        }
      }
      if (!ran.ok) {
        const { summary, detail } = summariseCheckFailure(
          checkLines,
          ran.error,
        );
        const killed = killedStep(ran.error);
        // A red verification keeps the map it measured all the same, and
        // names the files it failed in for the bisection (#7786).
        const files = x.tier === "verify" ? failedFiles(checkLines) : [];
        if (x.tier === "verify" && x.keepImpact === true) {
          try {
            const kept = keepImpact(app.config.dataDir, repo.id, dir);
            if (kept !== undefined) write(kept);
          } catch (error) {
            write(`impact map not kept: ${String(error)}`);
          }
        }
        return {
          ok: false,
          error: killed ? ran.error : summary,
          detail: redDetail(detail, files, checkLines),
          ...(wholeVerify ? { passed: passedFiles(checkLines) } : {}),
          stage: checkStage(ran.error),
          ...(killed ? { killed } : {}),
          ...(stoppedForCpu(ran.error) ? { cpuStop: ran.error } : {}),
        };
      }
      // Only a green check of the default branch is kept for the next.
      if (
        x.keep === true &&
        keepCache(app.config.dataDir, repo.id, run.commitOid, dir)
      )
        write(`cache kept for ${run.commitOid.slice(0, 7)}`);
      if (x.tier === "full" || x.keepImpact === true) {
        try {
          const kept = keepImpact(app.config.dataDir, repo.id, dir);
          if (kept !== undefined) write(kept);
        } catch (error) {
          write(`impact map not kept: ${String(error)}`);
        }
      }
      if (key !== undefined) recordProven(app.db, key, x.id);
      const cleared = clearedIn(checkLines);
      return {
        ok: true,
        ...(wholeVerify ? { passed: passedFiles(checkLines) } : {}),
        ...(cleared === undefined ? {} : { cleared }),
      };
    } finally {
      if (existsSync(dir)) await removeRunDir(dir);
      await removeRunDir(home);
    }
  }

  // What starts a check: a branch moving, a pull opening, a fork's push
  // moving a pull's head. The commit checked is always the one the pull
  // proposes now.
  const unsubscribe = app.bus.subscribe((event: ForgeEvent) => {
    onEvent(event).catch((error) =>
      log.error("checks event handler failed", {
        kind: event.kind,
        error: String(error),
      }),
    );
  });

  async function onEvent(event: ForgeEvent): Promise<void> {
    if (stopped || event.repoId === null) return;
    const repo = getRepoById(app.db, event.repoId);
    if (!repo) return;
    const actor = event.actorId ?? undefined;
    switch (event.kind) {
      case "push": {
        // A fork that silently followed holds its parent's commit, byte for
        // byte: checking the copy proves nothing the parent's own check did
        // not, once per fork, on every landed pull. A merge of the parent
        // into the fork's own work is a new commit, and is checked.
        if (
          typeof event.payload["followed"] === "string" &&
          event.payload["merged"] !== true
        )
          return;
        const updates = event.payload["updates"];
        if (!Array.isArray(updates)) return;
        for (const update of updates as { ref?: unknown; newOid?: unknown }[]) {
          if (
            typeof update.ref !== "string" ||
            typeof update.newOid !== "string"
          )
            continue;
          if (
            !update.ref.startsWith("refs/heads/") ||
            /^0+$/.test(update.newOid)
          )
            continue;
          const branch = update.ref.slice("refs/heads/".length);
          if (branch === repo.defaultBranch)
            await request(
              repo,
              branch,
              update.newOid,
              "push",
              undefined,
              actor,
            );
          for (const pull of listPulls(app.db, repo.id, {
            sealed: true,
            state: "open",
            limit: 200,
          })) {
            if (pull.crossRepo || pull.headBranch !== branch) continue;
            await request(
              repo,
              `pull-${pull.number}`,
              update.newOid,
              "push",
              pull.id,
              actor,
            );
          }
        }
        return;
      }
      case "pull.opened":
      case "pull.reopened": {
        const number = event.payload["number"];
        if (typeof number !== "number") return;
        const pull = getPull(app.db, repo.id, number);
        if (!pull) return;
        const head = await headOf(repo, pull);
        if (head !== undefined)
          await request(
            repo,
            `pull-${pull.number}`,
            head,
            "pull",
            pull.id,
            actor,
          );
        return;
      }
      case "pull.pushed": {
        const number = event.payload["number"];
        const headOid = event.payload["headOid"];
        if (typeof number !== "number" || typeof headOid !== "string") return;
        const pull = getPull(app.db, repo.id, number);
        if (!pull) return;
        await request(
          repo,
          `pull-${pull.number}`,
          headOid,
          "push",
          pull.id,
          actor,
        );
        return;
      }
      // An approval is what lets a reader's pull run: check its head now.
      case "pull.run_granted":
      case "pull.reviewed": {
        const number = event.payload["number"];
        if (typeof number !== "number") return;
        if (
          event.kind === "pull.reviewed" &&
          event.payload["state"] !== "approved"
        )
          return;
        const pull = getPull(app.db, repo.id, number);
        if (!pull || pull.state !== "open") return;
        const head = await headOf(repo, pull);
        if (head === undefined) return;
        // A head already green is not checked again for nothing (#4391).
        const env = `pull-${pull.number}`;
        const dir = await pullDir(app.db, app.reposRoot, repo, pull);
        const tip = await resolveOid(dir, `refs/heads/${pull.baseBranch}`);
        // The merge queue gates only an autonomous repository's lands (`crew/autonomy.ts` admit).
        const landGated = repo.autonomy === "autonomous" && repo.autonomyBy !== null;
        if (!checkOnApproval(checksForHead(app.db, pull.id, head), env, tip, landGated))
          return;
        await request(repo, env, head, "approved", pull.id, actor);
        return;
      }
      // Landed or closed: nothing left to check, so nothing waits in the lane.
      case "pull.merged":
      case "pull.closed": {
        const number = event.payload["number"];
        if (typeof number !== "number") return;
        const pull = getPull(app.db, repo.id, number);
        if (!pull) return;
        const cancelled = cancelRunsForPull(
          app.db,
          pull.id,
          event.kind === "pull.merged" ? "pull landed" : "pull closed",
        );
        for (const run of cancelled) {
          inFlight.get(run.id)?.abort.abort();
          announceRun(app, run);
        }
        // A builder run still in flight when its pull lands reads as done now (#12049).
        if (event.kind === "pull.merged")
          for (const id of settleLandedRuns(app.db, { issueId: pull.id, headBranch: pull.headBranch, repoId: repo.id, number })) {
            const done = getRun(app.db, id);
            if (done) announceRun(app, done);
          }
        // A land moves the default branch without a push event: check its
        // new head, or a red main stays red until someone pushes to it. The
        // check settles first: a candidate's next step supersedes it.
        const mergeOid = event.payload["mergeOid"];
        if (
          event.kind === "pull.merged" &&
          pull.baseBranch === repo.defaultBranch &&
          typeof mergeOid === "string" &&
          /^[0-9a-f]{40}$/.test(mergeOid)
        )
          await request(
            repo,
            repo.defaultBranch,
            mergeOid,
            "push",
            undefined,
            actor,
            settle > 0 ? new Date(Date.now() + settle).toISOString() : undefined,
          );
        return;
      }
      default:
        return;
    }
  }

  async function headOf(repo: Repo, pull: Pull): Promise<string | undefined> {
    const dir = await pullDir(app.db, app.reposRoot, repo, pull);
    const ref = pull.crossRepo
      ? `refs/pull/${pull.number}/head`
      : `refs/heads/${pull.headBranch}`;
    return (await resolveOid(dir, ref)) ?? (pull.headOid || undefined);
  }

  const timer = setInterval(() => {
    if (!stopped) during("lane", schedule);
  }, options.tickMs ?? TICK_MS);
  // Main is verified after landing on a schedule, when the forge says how often.
  const sweeper =
    options.verifyEveryMs === undefined
      ? undefined
      : setInterval(() => {
          if (!stopped)
            during("verify-sweep", askVerifications).catch((error) =>
              log.error("verification not asked", { error: String(error) }),
            );
        }, Math.min(VERIFY_SWEEP_MS, options.verifyEveryMs));
  // A gate's slot frees: the pull check held for it starts now, not at the tick.
  const unwatch = watchGates(schedule);
  during("lane", schedule);
  void during("lane-catch-up", catchUp);

  /** One gate's run on the lane: the full tier on `commitOid`, traced, cut off by `controller`. */
  async function gateOnce(
    repo: Repo,
    pull: Pull,
    commitOid: string,
    controller: AbortController,
    signal: AbortSignal | undefined,
  ): Promise<GateDone> {
    const lines: string[] = [];
    const abandon = (): void => controller.abort();
    signal?.addEventListener("abort", abandon, { once: true });
    // The slot minutes it spends are the flow's gate minutes (#6426).
    const traced = beginGate(app.db, repo.id, pull.id, commitOid);
    try {
      const bare = await pullDir(app.db, app.reposRoot, repo, pull);
      const done = await runTier({
        bare,
        repo,
        id: gateRunId(commitOid),
        commitOid,
        pull,
        tier: "full",
        write: (line) => lines.push(line),
        signal: controller.signal,
      });
      if (done.ok) return { ok: true, error: "", lines };
      const stage = done.stage ?? "setup";
      // Cut off by this forge stopping, the Job lost under it, the check
      // killed by a signal from outside (the pod going, the OOM killer), or
      // an install the machine failed twice: the code was not judged, so
      // this is no red. A gate the drain lets finish is judged (#6611, #6722).
      if (
        controller.signal.aborted ||
        done.error === JOB_VANISHED ||
        done.infrastructure === true ||
        done.killed === true
      )
        return { ok: false, error: done.error, lines, interrupted: true, stage };
      return { ok: false, error: done.error, lines, stage };
    } finally {
      endGate(app.db, traced);
      signal?.removeEventListener("abort", abandon);
      gates.delete(controller);
    }
  }

  /** A gate asked of a forge already stopping is not started: the forge that carries on asks it again. */
  function gateRun(repo: Repo, pull: Pull, commitOid: string, signal?: AbortSignal): Promise<GateDone> {
    if (stopped) return Promise.resolve({ ok: false, error: INTERRUPTED, lines: [], interrupted: true });
    const controller = new AbortController();
    const done = gateOnce(repo, pull, commitOid, controller, signal);
    gates.set(controller, { commitOid, done });
    return done;
  }

  const handle: ChecksHandle = {
    request,
    gate: gateRun,
    adopt: (commitOid) => {
      for (const g of gates.values()) if (g.commitOid === commitOid) return g.done;
      return undefined;
    },
    spareSlots: () => Math.max(0, capacity() - PULL_RESERVE - slotted() - extraGates()),
    verifyDue: (now) => askVerifications(now),
    lane: gate,
    stop: async (stopOptions) => {
      stopped = true;
      clearInterval(timer);
      if (sweeper !== undefined) clearInterval(sweeper);
      unsubscribe();
      unwatch();
      // A roll waits for the checks under way, up to the budget, and only
      // then cuts off what is left (it is queued again, not lost).
      // A merge-queue gate is under way too: its verdict, if it comes in the
      // drain, is kept for the forge that carries on (#6611).
      const running = Promise.all([
        ...[...inFlight.values()].map((f) => f.promise),
        ...[...gates.values()].map((g) => g.done),
      ]);
      const drainMs = stopOptions?.drain === false ? 0 : (options.drainMs ?? 0);
      if (drainMs > 0 && inFlight.size + gates.size > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          running,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, drainMs);
          }),
        ]);
        clearTimeout(timer);
      }
      for (const { abort } of inFlight.values()) abort.abort();
      for (const abort of gates.keys()) abort.abort();
      await running;
    },
  };
  handles.set(app, handle);
  return handle;
}
