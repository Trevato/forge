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
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../app.ts";
import { announceRun } from "../actions/runs.ts";
import type { ForgeEvent } from "../core/events.ts";
import { getPull, listPulls, type Pull } from "../core/pulls.ts";
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
  vanishedBefore,
  VANISHED_SUMMARY,
  requeueCheck,
  REQUEUED_SUMMARY,
  sweepAbandonedChecks,
  type Run,
} from "../core/runs.ts";
import { Gate, runGit } from "../git/env.ts";
import { resolveOid } from "../git/merge.ts";
import { mergeForCheck } from "./merged.ts";
import { checkKey, provenBy, recordProven } from "./proven.ts";
import { giveHistory } from "./history.ts";
import { readLearned } from "./learned.ts";
import { keepCache, restoreCache } from "./cache.ts";
import { MAX_FILED, clearedFiles, fileOrderDependent } from "./order_dependent.ts";
import { ASKED, redMain, unheld } from "./red_main.ts";
import { IMPACT_FILE, keepImpact, seedImpact } from "./impact-store.ts";
import { getIssueById } from "../core/issues.ts";
import { repoDir } from "../git/repos.ts";
import { BUDGETS, budgetSummary } from "../kernel/budgets.ts";
import { transact } from "../kernel/db.ts";
import { createLog } from "../kernel/log.ts";
import { holdLease, STALE_AFTER_MS } from "../runs/lease.ts";
import { appendRunLog } from "../runs/log.ts";
import { runningLimitSentence, runningRuns } from "../settings/quotas.ts";
import { exportTree, readFileAt } from "../apps/checkout.ts";
import { parseCheck } from "../apps/manifest.ts";
import { workerCpus } from "../../scripts/shards.ts";
import { accountActive } from "../core/accounts.ts";
import { childEnv, runStep } from "../apps/process.ts";
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
  resolveLimits,
  STEP_HOSTS,
  type CellSpec,
} from "../apps/contain.ts";
import { summariseCheckFailure } from "./summary.ts";
import type { Result } from "../kernel/result.ts";
import { placementFromEnv, type Placement } from "./placement.ts";
import { JOB_VANISHED, runJobStep } from "./job_step.ts";
import type { JobOptions } from "../cluster/jobs.ts";
import type { CheckDetail } from "../core/runs.ts";

const log = createLog("checks");

export interface ChecksOptions {
  /** How many checks may run at once. @default 1 */
  readonly concurrency?: number | undefined;
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
   * queued and no run is written; the answer is the verdict.
   */
  gate(
    repo: Repo,
    pull: Pull,
    commitOid: string,
  ): Promise<{ ok: boolean; error: string; lines: string[] }>;
  /**
   * Stop checking. Checks under way get `drainMs` to finish unless `drain`
   * is false (a person's Ctrl-C): then they are cut off and queued again now.
   */
  stop(options?: { drain?: boolean }): Promise<void>;
  /** The gate checks take their turn at; a hosted child's checks share it. */
  readonly lane: Gate;
}

/** How often queued checks another forge left are looked for. */
const TICK_MS = 5_000;

/**
 * How long a queued check may wait before it outranks a newer one however
 * fresh: the bound that keeps `pickNext` from starving a pull nobody has
 * pushed to in a while.
 */
export const STARVATION_MS = 10 * 60 * 1000;

/**
 * Which queued check takes a slot when one frees: the one requested most
 * recently, so a push's own check is never stuck behind pulls that queued
 * hours earlier — unless something has already waited `STARVATION_MS` or
 * more, in which case the longest-waiting check goes first regardless of
 * how fresh the rest are. Ties (down to the same instant) fall back to id
 * order, which is itself creation order (`kernel/id.ts`).
 */
export function pickNext(
  queued: readonly Run[],
  now: number = Date.now(),
): Run | undefined {
  if (queued.length === 0) return undefined;
  let oldest = queued[0]!;
  let newest = queued[0]!;
  for (const run of queued) {
    if (
      run.createdAt < oldest.createdAt ||
      (run.createdAt === oldest.createdAt && run.id < oldest.id)
    )
      oldest = run;
    if (
      run.createdAt > newest.createdAt ||
      (run.createdAt === newest.createdAt && run.id > newest.id)
    )
      newest = run;
  }
  if (now - Date.parse(oldest.createdAt) >= STARVATION_MS) return oldest;
  return newest;
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
  return swept.requeued.length + swept.failed.length + swept.cancelled.length;
}

/** Where a check's checkout lives while it runs. */
const checksRoot = (dataDir: string): string => join(dataDir, "checks");

/**
 * Remove the checkouts nobody is using: one whose run is not running with a
 * live lease, or has no run at all. A forge booting during a roll shares this
 * directory and database with the old one, whose checks are still running in
 * theirs; those are left alone.
 */
export function sweepCheckouts(app: App, now: number = Date.now()): void {
  const root = checksRoot(app.config.dataDir);
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const run = getRun(app.db, name);
    const live =
      run !== undefined &&
      run.state === "running" &&
      !leaseLapsed(run, STALE_AFTER_MS, now);
    if (!live) rmSync(join(root, name), { recursive: true, force: true });
  }
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
  /** Full gates on land in flight: not slots in the queue, but stopped with it. */
  const gates = new Set<AbortController>();
  const inFlight = new Map<
    string,
    { promise: Promise<void>; abort: AbortController }
  >();
  /** Checks already told why they wait, so the log says it once. */
  const waiting = new Set<string>();
  let stopped = false;

  sweepCheckouts(app);

  async function request(
    repo: Repo,
    env: string,
    commitOid: string,
    reason: string,
    issueId?: string,
    actorId?: string,
  ): Promise<Run | undefined> {
    // A suspended or removed owner's code is not run, not even to check it.
    if (stopped || !accountActive(app.db, repo.ownerId)) return undefined;
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
    const abort = new AbortController();
    const promise = execute(run, repo, abort.signal)
      .catch((error) =>
        log.error("check failed to execute", {
          run: run.id,
          error: String(error),
        }),
      )
      .finally(() => {
        inFlight.delete(run.id);
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
  function schedule(): void {
    if (stopped) return;
    const limit = capacity();
    if (options.gate === undefined) gate.resize(limit);
    while (inFlight.size < limit) {
      // A pull's check waits while its main is red (`checks/red_main.ts`).
      const queued = unheld(
        listActive(app.db, "check").filter(
          (run) => run.state === "queued" && !inFlight.has(run.id),
        ),
        (repoId) => redMain(app.db, repoId),
        options.redHoldMs ?? 0,
      );
      // The limit is asked at the point of starting, one pick at a time:
      // a started check is in flight before the next is asked about, so a
      // burst of one account's checks cannot pass together.
      let rest = queued;
      let next = pickNext(rest);
      while (next !== undefined && atLimit(next)) {
        const held = next;
        rest = rest.filter((run) => run !== held);
        next = pickNext(rest);
      }
      if (!next) return;
      const repo = getRepoById(app.db, next.repoId);
      if (!repo) return;
      start(next, repo);
    }
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
  ): Promise<void> {
    const release = await gate.acquire();
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
      const write = (line: string): void =>
        appendRunLog(app.config.dataDir, run.id, line);
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
      if (!outcome.ok && getRun(app.db, run.id)?.state === "cancelled") {
        write(`superseded: ${getRun(app.db, run.id)?.summary ?? "cancelled"}`);
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
      const seconds = Math.round((Date.now() - started) / 1000);
      const done = finishRun(app.db, run.id, {
        state: outcome.ok ? "ok" : "failed",
        summary: outcome.ok
          ? outcome.proven === undefined
            ? `check passed in ${seconds}s`
            : `already proven green by ${outcome.proven}`
          : `check failed: ${outcome.error}`,
        ...(outcome.ok || outcome.detail === undefined
          ? {}
          : { checkDetail: outcome.detail }),
      });
      write(outcome.ok ? `passed in ${seconds}s` : `failed: ${outcome.error}`);
      if (done) announceRun(app, done);
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
    | { ok: true; proven?: string }
    | { ok: false; error: string; detail?: CheckDetail | undefined }
  > {
    const bare = await runDir(app.db, app.reposRoot, repo, run.issueId);
    // A pull's check is the fast tier, judged against where the pull left
    // the base; anything else is the whole check (`apps/manifest.ts`).
    const issue =
      run.issueId === null ? undefined : getIssueById(app.db, run.issueId);
    const pull =
      issue?.kind === "pull" ? getPull(app.db, repo.id, issue.number) : undefined;
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
    /** `run`: a push to a branch; `fast`: a pull's push; `full`: on land. */
    readonly tier: "run" | "fast" | "full";
    /** A check of the default branch's own push: its cache is kept. */
    readonly keep?: boolean;
    /** A green run keeps the impact map it measured; `full` always does. */
    readonly keepImpact?: boolean;
    /** The default branch's own run: only its log may open issues. */
    readonly fileOrderDependent?: boolean;
    readonly write: (line: string) => void;
    readonly signal: AbortSignal;
  }

  async function runTier(
    x: Execution,
  ): Promise<
    | { ok: true; proven?: string }
    | { ok: false; error: string; detail?: CheckDetail | undefined }
  > {
    const { bare, repo, write, signal } = x;
    // A pull's fast check is of the pull as it would land: its head merged
    // into the base's tip. The gate comes from that tree, so a pull forked
    // before the base learned something is judged with it.
    let source = x.commitOid;
    let tip: string | undefined;
    let mergeLine = "";
    if (x.tier === "fast" && x.pull !== undefined) {
      tip = await resolveOid(bare, `refs/heads/${x.pull.baseBranch}`);
      if (tip === undefined)
        return { ok: false, error: `the base ${x.pull.baseBranch} could not be found` };
      const merged = await mergeForCheck(bare, x.pull.baseBranch, tip, x.commitOid);
      if (!merged.ok) return { ok: false, error: merged.error };
      source = merged.commit;
      if (x.runId !== undefined) setRunBase(app.db, x.runId, tip);
      mergeLine = merged.line;
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
    const command =
      x.tier === "full"
        ? manifest.full
        : x.tier === "fast"
          ? (manifest.fast ?? manifest.run)
          : manifest.run;
    // The fast tier diffs what the pull changes against the base's tip,
    // which the clone is given as a repository of its own: `origin/main` is
    // not a ref there.
    const base = manifest.fast !== null ? tip : undefined;
    // The tree this runs on under this gate has been green before: that is
    // the verdict, and nothing is checked out (#1795).
    const learned =
      base === undefined ? "" : readLearned(app.config.dataDir, x.pull!.id).join(",");
    const tree = await runGit(["rev-parse", `${run.commitOid}^{tree}`], { cwd: bare });
    const key = tree.ok
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
    const dir = join(checksRoot(app.config.dataDir), run.id);
    mkdirSync(dir, { recursive: true });
    write(mergeLine === "" ? `checking out ${run.commitOid.slice(0, 7)}` : mergeLine);
    const exported = await exportTree(bare, run.commitOid, dir);
    if (!exported.ok) return { ok: false, error: exported.error };
    if (base !== undefined) {
      const given = await giveHistory(bare, dir, base, run.commitOid);
      if (!given.ok) {
        rmSync(dir, { recursive: true, force: true });
        return { ok: false, error: given.error };
      }
    }
    // What the base's own check left (`checks/cache.ts`): tsc's build info
    // and the gate's per-file times, keyed by the commit this one builds on.
    const cached = restoreCache(
      app.config.dataDir,
      repo.id,
      tip === undefined ? [] : [tip],
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
    const job = placement.mode === "job" ? placement : undefined;
    if (x.runId !== undefined)
      noteRunProgress(app.db, x.runId, { placement: placement.mode });
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
          hide: [app.config.dataDir, process.env["HOME"] ?? "", tmpdir()],
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
        // The cell's CPU limit, which `availableParallelism()` may not
        // report inside it; the shard count follows this (#2257).
        FORGE_CELL_CPUS: String(cellCpus),
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
          const installed = await runStep("install", manifest.install, {
            cwd: dir,
            env,
            log: write,
            signal,
            timeoutMs: manifest.timeout * 1000,
            cell,
          });
          if (!installed.ok) return { ok: false, error: installed.error };
        }
        // The check step's own lines are kept beside what `write` already
        // logs, so a failure can be summarised once here — never by reading
        // the log back, on this run or any later render of it. `runStep`
        // echoes the command as its first line before any output of the
        // command's own; that echo is not output to summarise from.
        let sawEcho = false;
        ran = await runStep("check", command, {
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
      if (!ran.ok) {
        const { summary, detail } = summariseCheckFailure(
          checkLines,
          ran.error,
        );
        return { ok: false, error: summary, detail };
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
      return { ok: true };
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
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
        if (head !== undefined)
          await request(
            repo,
            `pull-${pull.number}`,
            head,
            "approved",
            pull.id,
            actor,
          );
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
        // A land moves the default branch without a push event: check its
        // new head, or a red main stays red until someone pushes to it.
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
    if (!stopped) schedule();
  }, TICK_MS);
  schedule();
  void catchUp();

  const handle: ChecksHandle = {
    request,
    gate: async (repo, pull, commitOid) => {
      const lines: string[] = [];
      const controller = new AbortController();
      gates.add(controller);
      try {
        const bare = await pullDir(app.db, app.reposRoot, repo, pull);
        const done = await runTier({
          bare,
          repo,
          id: `gate-${commitOid.slice(0, 12)}`,
          commitOid,
          pull,
          tier: "full",
          write: (line) => lines.push(line),
          signal: controller.signal,
        });
        return { ok: done.ok, error: done.ok ? "" : done.error, lines };
      } finally {
        gates.delete(controller);
      }
    },
    lane: gate,
    stop: async (stopOptions) => {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
      // A roll waits for the checks under way, up to the budget, and only
      // then cuts off what is left (it is queued again, not lost).
      const running = Promise.all([...inFlight.values()].map((f) => f.promise));
      const drainMs = stopOptions?.drain === false ? 0 : (options.drainMs ?? 0);
      if (drainMs > 0 && inFlight.size > 0) {
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
      for (const abort of gates) abort.abort();
      await running;
    },
  };
  handles.set(app, handle);
  return handle;
}
