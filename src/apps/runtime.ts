/**
 * What is running. One `AppsRuntime` per forge holds every environment of
 * every app as an in-memory record — a process is not state — and rebuilds
 * the whole set on boot from the default branch and the open pulls, the
 * way `core/reconcile.ts` rebuilds the index from git.
 *
 * It listens to the outbox and it sweeps: a push to the default branch
 * redeploys production, a push to a pull's branch redeploys its preview, a
 * pull opening gets a preview and a pull closing loses it. Every deploy is
 * a run row with a log; a failed deploy leaves the previous deployment
 * serving. Deploys are serial per environment and a newer request
 * supersedes one still queued, so a burst of pushes ends at the last
 * commit, once.
 */

import type { Database } from "bun:sqlite";
import { VERIFYING_NOTE } from "./env_phrase.ts";
import { listEgressGrants } from "../core/egress_grants.ts";
import { recordCarried } from "../core/carried.ts";
import { releaseOfCommit } from "../core/release_subject.ts";
import { pullDir, runDir } from "../core/pulls.ts";
import { accountActive } from "../core/accounts.ts";
import { sshCommand } from "../ssh/command.ts";
import { checkPreview } from "./preview_spec.ts";
import { appHostSuffix } from "./host.ts";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../app.ts";
import { getAppByRepo, listApps, type AppRecord } from "../core/apps.ts";
import { resolveAppEnv } from "../core/app_env.ts";
import { featureVarsAt } from "./feature_env.ts";
import { mintAppToken, renewAppToken, revokeAppToken } from "./token.ts";
import type { ForgeEvent } from "../core/events.ts";
import { announceRun } from "../actions/runs.ts";
import { requeueAbandonedChecks } from "../checks/service.ts";
import { checkInstallCache } from "../checks/install.ts";
import { getPull, listPulls, type Pull } from "../core/pulls.ts";
import { isContributionFork } from "../core/contribute.ts";
import { pullMayRun } from "../core/pull_trust.ts";
import { guestWaits } from "../origins/guest.ts";
import { canEnterApp, getRepoById, type Repo } from "../core/repos.ts";
import { runningLimitSentence } from "../settings/quotas.ts";
import type { User } from "../core/users.ts";
import {
  cancelRun,
  getRun,
  listRuns,
  claimRun,
  createRun,
  failAbandonedRuns,
  finishRun,
  markServing,
  noteRunProgress,
  STOPPED_SUMMARY,
  type Run,
} from "../core/runs.ts";
import { Gate } from "../git/env.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { headUnder, previewCommit } from "../git/combined.ts";
import { createLog } from "../kernel/log.ts";
import type { Result } from "../kernel/result.ts";
import { holdLease, STALE_AFTER_MS } from "../runs/lease.ts";
import { appendRunLog } from "../runs/log.ts";
import { primaryDomain, primaryHosts } from "../core/domains.ts";
import {
  beatAwake,
  closeAllAwake,
  closeAwake,
  closeOrphans,
  lastStorageAt,
  openAwake,
  recordStorage,
  SAMPLE_SPAN_MS,
  type Placement,
} from "../core/meter.ts";
import { dirBytes } from "./bytes.ts";
import { BUSY_WORDS, busyReason, type BusyReason } from "./busy.ts";
import { exportTree, readFileAt } from "./checkout.ts";
import { seconds, Stopwatch } from "./timing.ts";
import { DRAIN_BUDGET_MS, drainPort } from "./handoff.ts";
import type { DomainResolver } from "./domains.ts";
import {
  appsRoot,
  buildEnv,
  envBuild,
  envHostLabel,
  ensureEnvData,
  envDataDir,
  envDir,
  envPull,
  isEnvName,
  previewEnv,
  removeApp,
  removeEnv,
  reseedEmpty,
  type EnvName,
} from "./data.ts";
import { parseManifest, type AppManifest } from "./manifest.ts";
import { identityKey } from "./proxy.ts";
import { noteReached } from "./egress_report.ts";
import { egressSetting } from "../core/capacity.ts";
import { noteProtection } from "../kernel/protection.ts";
import { cellsAvailable, resolveLimits, type CellSpec } from "./contain.ts";
import {
  startProcess,
  type CellBase,
  type ProcessHandle,
  type StartError,
  type StartInput,
} from "./process.ts";

const log = createLog("apps");

export interface RuntimeOptions {
  /** The domain app hostnames hang off: `<slug>.<domain>`. */
  readonly domain: string;
  /** `http` or `https` — what the public URL of an app starts with. */
  readonly scheme: "http" | "https";
  /** The port in public app URLs, or undefined for the scheme's default. */
  readonly publicPort?: number | undefined;
  /** The forge's own public URL, for the app's `FORGE_URL` and links. */
  readonly forgeUrl: string;
  /** How many deploys may run their heavy steps at once. @default 2 */
  readonly concurrency?: number | undefined;
  /**
   * How long an environment serves nobody before its process is stopped
   * and it sleeps, to be woken by the next request. A preview is looked at
   * and forgotten; production is left alone for a day before it rests.
   */
  readonly sleepAfterMs?:
    | { readonly production: number; readonly preview: number }
    | undefined;
  /** How often the runtime looks for environments to put to sleep. */
  readonly sweepEveryMs?: number | undefined;
  /**
   * How long a pull may go without a push or a comment before its preview
   * is stopped (not removed: its row, data and pictures stay) and reads as
   * asleep until someone asks for it. Unset or 0 keeps every preview warm.
   */
  readonly idlePullMs?: number | undefined;
  /**
   * How long past its idle window a busy environment (`apps/busy.ts`) is
   * left awake before it sleeps anyway — one crew run's length, so an app
   * that only claims to be busy cannot stay up forever.
   */
  readonly busyGraceMs?: number | undefined;
  /**
   * What a domain check asks: the system resolver unless a test hands in
   * its own, so proving `app.example.com` needs no network in a test.
   */
  readonly dns?: DomainResolver | undefined;
  /** Where this forge's processes run, as the meter records it. @default "owned" */
  readonly placement?: Placement | undefined;
  /** How often storage is sampled for the meter. @default one hour */
  readonly storageEveryMs?: number | undefined;
  /**
   * The gate deploys take their turn at. A hosted child's runtime is handed
   * its parent's, so a child's deploys count against the parent's capacity
   * instead of beside it. @default a gate of `concurrency`
   */
  readonly gate?: Gate | undefined;
}

export type EnvState =
  | "stopped"
  | "deploying"
  | "running"
  | "asleep"
  | "failed";

const SLEEP_AFTER_MS = { production: 24 * 3_600_000, preview: 30 * 60_000 };
const SWEEP_EVERY_MS = 60_000;
const BUSY_GRACE_MS = 45 * 60_000;

/** What a finished deploy's summary ends with: the studio words its green
 * from these, so a pull says whether its tests ran (`words.ts`). */
export const TESTS_PASSED_TAIL = " · its tests passed";
export const NO_TESTS_TAIL = " · no tests declared, none run";

export interface EnvStatus {
  readonly env: EnvName;
  readonly state: EnvState;
  /** The commit serving, or being brought up. */
  readonly commitOid: string;
  readonly url: string;
  readonly port?: number | undefined;
  /** The run that produced this state — a link to its log. */
  readonly runId?: string | undefined;
  readonly since?: string | undefined;
  /** The instant this deployment started serving, set once at the swap-in. */
  readonly servingAt?: string | undefined;
  /**
   * The instant the push created this deploy run — what a person means by
   * "after the push", and the reference `servedPhrase` measures from. Unset
   * for a deploy no push asked for (a redeploy someone pressed, a boot
   * reconcile), so the words for those never claim a push that never was.
   */
  readonly createdAt?: string | undefined;
  /** The deploy run's own start — after however long it waited for a permit. */
  readonly deployStartedAt?: string | undefined;
  readonly error?: string | undefined;
  /**
   * A running environment whose deploy is still checking itself: its tests
   * are still running, or ran and failed. Never set while `state` is
   * anything but `running` — a failed test never stops a deployment that
   * already answers.
   */
  readonly note?: string | undefined;
  /**
   * The app's own `tty` command, once known live — `null` when its
   * `forge.json` declares none. Unset while never live, since a checkout
   * that has not started has not said either way.
   */
  readonly tty?: string | null | undefined;
  /**
   * The pages `app.looks` names worth a picture, once known live — `["/"]`
   * when its `forge.json` says nothing. Unset while never live, the same
   * as `tty`.
   */
  readonly looks?: readonly string[] | undefined;
  /** The pages of `looks` pictured as the owner (`app.looksAsOwner`), once known live. */
  readonly looksAsOwner?: readonly string[] | undefined;
  /** `false` when its `forge.json` turns the forge pill off; unset is on. */
  readonly toolbar?: boolean | undefined;
  /**
   * A deploy newer than the one serving that never came up — set only
   * while an older deployment keeps answering in its place. A later
   * successful deploy of this environment clears it (it is the newest
   * attempt's own outcome, never a history), and it is never set once
   * nothing serves at all: `state: "failed"` and `error` already say that.
   */
  readonly failedDeploy?:
    | {
        readonly commitOid: string;
        readonly runId: string;
        readonly error: string;
      }
    | undefined;
  /**
   * Why a running environment is still awake past its idle window, in a
   * person's words (`BUSY_WORDS`) — set only while the sweep is sparing it.
   */
  readonly busy?: string | undefined;
  /**
   * Set while a preview is stopped because its pull went quiet: when it was
   * stopped, and the last touch (push, comment, wake) it was measured from.
   * A stopped preview with this set is asleep, never failed.
   */
  readonly dormant?: { readonly since: string; readonly idleSince: string } | undefined;
}

interface Live {
  readonly commitOid: string;
  readonly handle: ProcessHandle;
  readonly dir: string;
  readonly runId: string;
  readonly since: string;
  /** How this checkout runs — its `tty` is what an ssh session opens. */
  readonly manifest: AppManifest;
  /** Unset while tests are still running or there are none; the message once they fail. */
  readonly testsFailed?: string | undefined;
  /**
   * The instant this deployment started serving, set once at the swap-in —
   * unset on the value `bringUp` returns, which does not yet know it.
   */
  readonly servingAt?: string | undefined;
  /** The instant the push created this deploy run, when a push did. */
  readonly createdAt?: string | undefined;
  /** The deploy run's own start — the reference the deploy log measures from. */
  readonly deployStartedAt?: string | null | undefined;
  /** This process's forge token (`apps/token.ts`), revoked when it stops. */
  readonly tokenId?: string | undefined;
}

/**
 * The deploy reasons a ref moving created: for these the run's `createdAt`
 * is the instant of the push that asked for the deploy, so the wait for a
 * permit sits inside the number the studio prints. A redeploy someone
 * pressed, a crash restart, and a boot or enable reconcile are not pushes.
 */
const PUSH_REASONS: readonly string[] = ["push", "opened", "merge"];

/** How long between two instants, in seconds to one decimal place: `3.4s`. */
function elapsedSeconds(fromIso: string, toIso: string): string {
  return seconds(Date.parse(toIso) - Date.parse(fromIso));
}

/**
 * Whether a start failure is the process itself exiting before it ever
 * answered its health path — as opposed to install failing, or the process
 * staying up but never answering. Only this shape of failure is worth
 * retrying on empty data: it is what a build too old for the data it was
 * given looks like.
 */
function diedBeforeAnswering(error: StartError): boolean {
  return (
    error.stage === "start" &&
    /^exited with code \d+ before answering/.test(error.message)
  );
}

/** A running environment, as a terminal session needs it. */
/**
 * A checkout that served and was stopped for want of visitors, kept whole:
 * the next request starts it again, warm, in about the time a page takes.
 */
interface Asleep {
  readonly commitOid: string;
  readonly dir: string;
  readonly manifest: AppManifest;
  readonly runId: string;
  readonly since: string;
}

export interface LiveEnv {
  readonly env: EnvName;
  readonly dir: string;
  readonly dataDir: string;
  readonly port: number;
  readonly commitOid: string;
  readonly url: string;
  readonly tty: string | null;
  /** The cell a terminal session runs in, the app's own; unset where cells cannot work. */
  readonly cell?: CellSpec | undefined;
}

interface Environment {
  readonly app: AppRecord;
  readonly env: EnvName;
  live?: Live | undefined;
  asleep?: Asleep | undefined;
  /** Stopped for want of a push or comment; asked for, it redeploys. */
  dormant?:
    | { since: string; idleSince: string; commitOid: string }
    | undefined;
  /** Why the last wake did not happen (the owner's preview limit), for the page a visitor sees. */
  wakeRefused?: string | undefined;
  /** One wake at a time; every request that arrives meanwhile waits on it. */
  waking?: Promise<void> | undefined;
  /** When something last came through the proxy for this environment. */
  lastRequestAt?: number | undefined;
  /** Streams the proxy holds open to it: websockets, event streams. */
  openStreams: number;
  /** Requests passed to it whose answer has not begun. */
  openRequests: number;
  /** Why the last sweep spared it, while it still is. */
  keptAwake?: BusyReason | undefined;
  /** The deploy in flight, if one is. */
  deploying?: { run: Run; abort: AbortController } | undefined;
  /** The next deploy, waiting its turn; replaced by a newer request. */
  queued?: Run | undefined;
  chain: Promise<void>;
  lastError?: string | undefined;
  lastRunId?: string | undefined;
  /** The commit `lastError` belongs to — set together, cleared together. */
  lastErrorCommitOid?: string | undefined;
  /** Crash restarts in the current window, for backing off. */
  restarts: number[];
  /** A build preview's place in the order build previews were started, oldest lowest. */
  buildOrder?: number | undefined;
}

/** How many build previews (`build-<sha7>`) one app runs at once; a newer one takes the oldest's place. */
export const BUILD_PREVIEWS_MAX = 3;

/** The deploy reasons that mean a person touched the change. */
const TOUCH_REASONS: readonly string[] = [
  "push",
  "opened",
  "redeploy",
  "wake",
];

const RESTART_WINDOW_MS = 10 * 60_000;
const RESTART_MAX = 3;
export const RESTART_BACKOFF_MS = [2_000, 10_000, 30_000];

const runtimes = new WeakMap<App, AppsRuntime>();

/** The runtime serving this forge, if apps are on. */
export const appsRuntime = (app: App): AppsRuntime | undefined =>
  runtimes.get(app);

/**
 * An app's environments as `viewer` may see them. A private app's state,
 * errors and runs are its writers' and crew's (`canEnterApp`, without the
 * people it only names, who enter the app and nothing behind it); to
 * anyone else who can read the repository it shows none — a deploy error
 * can carry paths and configuration (#620). Every surface that shows a
 * viewer an app's environments reads them here.
 */
export function envsFor(
  app: App,
  viewer: User | undefined,
  record: AppRecord,
): EnvStatus[] {
  const runtime = runtimes.get(app);
  if (runtime === undefined) return [];
  if (record.access === "private") {
    const repo = getRepoById(app.db, record.repoId);
    if (repo === undefined || !canEnterApp(app.db, repo, record, viewer, { named: false }))
      return [];
  }
  return runtime.status(record);
}

/**
 * Production first, then build previews, then previews by
 * pull number — a number, not a string, so `pull-10` follows `pull-9`.
 */
const envRank = (env: EnvName): number =>
  env === "production" ? -1 : (envPull(env) ?? 0);
const byEnv = (a: EnvStatus, b: EnvStatus): number => envRank(a.env) - envRank(b.env);

export class AppsRuntime {
  private readonly envs = new Map<string, Environment>();
  /** Whether this host can hold an app in a cell (`apps/contain.ts`), asked once at start. */
  private cells: { ok: true } | { ok: false; reason: string } = {
    ok: false,
    reason: "not started",
  };
  private readonly gate: Gate;
  private unsubscribe: (() => void) | undefined;
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  /** Counts build previews as they start, so the oldest is the lowest. */
  private buildCount = 0;

  constructor(
    readonly app: App,
    readonly options: RuntimeOptions,
  ) {
    this.gate = options.gate ?? new Gate(options.concurrency ?? 2);
    runtimes.set(app, this);
    // Closing the forge closes the database next: end every open awake
    // interval now, while it can be written, and write nothing after.
    app.closing.signal.addEventListener("abort", () => this.closeMeter(), {
      once: true,
    });
  }

  /** The gate this runtime's deploys wait at; a hosted child shares it. */
  get lane(): Gate {
    return this.gate;
  }

  // ---- addressing ----

  hostFor(slug: string, env: EnvName): string {
    return `${envHostLabel(slug, env)}${appHostSuffix(this.options.domain)}`;
  }

  /**
   * The exact command that opens an environment's terminal — the app is the
   * login, the forge is the host — or undefined when SSH is off.
   */
  sshFor(record: AppRecord, env: EnvName): string | undefined {
    return sshCommand(this.app, envHostLabel(record.slug, env));
  }

  /**
   * Where an environment is reached. Production answers at the app's own
   * domain once one is verified — every link, the app's JSON `url` and the
   * `FORGE_APP_URL` its next process starts with all follow — and at
   * `<slug>.<domain>` until then; a preview is always at its label. A
   * domain carries no port: it reaches the forge through whatever fronts
   * it, which holds its own.
   */
  urlFor(
    record: AppRecord,
    env: EnvName,
    hosts?: ReadonlyMap<string, string>,
  ): string {
    if (env === "production") {
      const host = hosts
        ? hosts.get(record.id)
        : primaryDomain(this.app.db, record.id)?.host;
      if (host !== undefined) return `${this.options.scheme}://${host}`;
    }
    const port =
      this.options.publicPort === undefined ||
      (this.options.scheme === "http" && this.options.publicPort === 80) ||
      (this.options.scheme === "https" && this.options.publicPort === 443)
        ? ""
        : `:${this.options.publicPort}`;
    return `${this.options.scheme}://${this.hostFor(record.slug, env)}${port}`;
  }

  // ---- observation ----

  envStatus(record: AppRecord, env: EnvName): EnvStatus | undefined {
    const state = this.envs.get(key(record.id, env));
    if (state === undefined) return undefined;
    return this.describe(state);
  }

  /**
   * `status` for many apps in one pass over the environments and one read
   * of their domains; nothing per app touches the database. The caller has
   * already decided which apps the viewer may see (`envsFor`'s rule).
   */
  statusMany(records: readonly AppRecord[]): Map<string, EnvStatus[]> {
    const out = new Map<string, EnvStatus[]>();
    const wanted = new Set(records.map((r) => r.id));
    const hosts = primaryHosts(this.app.db, [...wanted]);
    for (const id of wanted) out.set(id, []);
    for (const state of this.envs.values())
      out.get(state.app.id)?.push(this.describe(state, hosts));
    for (const list of out.values()) list.sort(byEnv);
    return out;
  }

  /** Every environment of an app, production first. */
  status(record: AppRecord): EnvStatus[] {
    const out: EnvStatus[] = [];
    for (const state of this.envs.values()) {
      if (state.app.id === record.id) out.push(this.describe(state));
    }
    // Production first, then build previews, then previews
    // by pull number (`envRank`).
    return out.sort(byEnv);
  }

  private describe(
    state: Environment,
    hosts?: ReadonlyMap<string, string>,
  ): EnvStatus {
    const url = this.urlFor(state.app, state.env, hosts);
    // Once a deploy's own commit has answered and swapped in, it is
    // "running" from here — even though its run stays open, checking its
    // tests, until they finish. Only a build still short of that point (no
    // live process yet, or the live one is an older commit) is "deploying".
    const swapped =
      state.deploying !== undefined &&
      state.live?.commitOid === state.deploying.run.commitOid;
    if (state.deploying !== undefined && !swapped) {
      return {
        env: state.env,
        state: "deploying",
        commitOid: state.deploying.run.commitOid,
        url,
        ...(state.live === undefined
          ? {}
          : {
              port: state.live.handle.port,
              since: state.live.since,
              servingAt: state.live.servingAt,
              createdAt: state.live.createdAt,
              tty: state.live.manifest.tty,
              looks: state.live.manifest.looks,
              looksAsOwner: state.live.manifest.looksAsOwner,
              toolbar: state.live.manifest.toolbar,
              ...(state.live.deployStartedAt === null
                ? {}
                : { deployStartedAt: state.live.deployStartedAt }),
            }),
        runId: state.deploying.run.id,
      };
    }
    if (state.live !== undefined) {
      // The most recent deploy attempt failed, and it was not this one — a
      // newer commit that never came up, while this older deployment kept
      // serving. `swapped` already covers the alternative (the newest
      // attempt is this one and it succeeded, however its tests read).
      const failedDeploy =
        !swapped &&
        state.lastError !== undefined &&
        state.lastErrorCommitOid !== undefined &&
        state.lastErrorCommitOid !== state.live.commitOid &&
        state.lastRunId !== undefined
          ? {
              commitOid: state.lastErrorCommitOid,
              runId: state.lastRunId,
              error: state.lastError,
            }
          : undefined;
      return {
        env: state.env,
        state: "running",
        commitOid: state.live.commitOid,
        url,
        port: state.live.handle.port,
        runId: swapped ? state.deploying!.run.id : state.live.runId,
        since: state.live.since,
        servingAt: state.live.servingAt,
        createdAt: state.live.createdAt,
        tty: state.live.manifest.tty,
        looks: state.live.manifest.looks,
        looksAsOwner: state.live.manifest.looksAsOwner,
        toolbar: state.live.manifest.toolbar,
        ...(state.live.deployStartedAt === null
          ? {}
          : { deployStartedAt: state.live.deployStartedAt }),
        ...(swapped ? { note: VERIFYING_NOTE } : {}),
        ...(state.live.testsFailed === undefined
          ? {}
          : { error: `serving · tests failed: ${state.live.testsFailed}` }),
        ...(failedDeploy === undefined ? {} : { failedDeploy }),
        ...(state.keptAwake === undefined
          ? {}
          : { busy: BUSY_WORDS[state.keptAwake] }),
      };
    }
    // Nothing is live and nothing is in flight yet, but a deploy already
    // waits its turn on the chain — a restart's own reconcile queues one
    // the instant it boots. That is "starting", not the stale error (if
    // any) a cancelled attempt before it left behind.
    if (state.queued !== undefined) {
      return {
        env: state.env,
        state: "deploying",
        commitOid: state.queued.commitOid,
        url,
        runId: state.queued.id,
      };
    }
    if (state.dormant !== undefined) {
      return {
        env: state.env,
        state: "stopped",
        commitOid: state.dormant.commitOid,
        url,
        runId: state.lastRunId,
        dormant: {
          since: state.dormant.since,
          idleSince: state.dormant.idleSince,
        },
      };
    }
    if (state.asleep !== undefined) {
      return {
        env: state.env,
        state: "asleep",
        commitOid: state.asleep.commitOid,
        url,
        runId: state.asleep.runId,
        since: state.asleep.since,
        error: state.wakeRefused,
      };
    }
    return {
      env: state.env,
      state: state.lastError === undefined ? "stopped" : "failed",
      commitOid: "",
      url,
      runId: state.lastRunId,
      error: state.lastError,
    };
  }

  // ---- lifecycle ----

  /** Each production environment the boot asked to deploy, and the run that does it. */
  private readonly bootRuns = new Map<Environment, string>();

  /**
   * How many of the productions this boot asked for are neither serving
   * nor settled yet. Until it reads 0 the forge is not ready (`/readyz`),
   * so in a rollout the forge it replaces keeps proxying to its own copy
   * of each app and no request finds an app that is still starting (#4496).
   */
  startingCount(): number {
    let count = 0;
    for (const [state, runId] of this.bootRuns) {
      const run = state.live?.runId === runId ? undefined : getRun(this.app.db, runId);
      const pending = run?.state === "queued" || run?.state === "running";
      if (pending) count++;
      else this.bootRuns.delete(state);
    }
    return count;
  }

  /** Rebuild every environment from git and the open pulls, then listen. */
  async start(): Promise<void> {
    this.cells = await cellsAvailable();
    noteProtection("apps", this.cells);
    if (!this.cells.ok)
      log.warn("apps run uncontained here", { reason: this.cells.reason });
    // Deploys are failed; a check the last forge left is queued again while
    // its commit still heads an open pull; an agent run is the crew's,
    // which queues it again rather than failing it.
    const abandoned =
      failAbandonedRuns(this.app.db, STALE_AFTER_MS, ["deploy"]) +
      requeueAbandonedChecks(this.app, STALE_AFTER_MS);
    if (abandoned > 0) log.info("settled abandoned runs", { count: abandoned });
    // An awake interval the last forge left open ends at its last heartbeat.
    const orphans = this.metered(() => closeOrphans(this.app.db));
    if (orphans) log.info("closed open meter intervals", { count: orphans });
    this.unsubscribe = this.app.bus.subscribe((event) => {
      // Never let an event handler's rejection reach the bus.
      this.onEvent(event).catch((error) =>
        log.error("apps event handler failed", {
          kind: event.kind,
          error: String(error),
        }),
      );
    });
    // Every app's production first, then every app's previews: deploys
    // take the gate in the order they are asked for, and the environment a
    // person actually visits must never come back behind someone's preview.
    const known = new Set<string>();
    const present: { record: AppRecord; repo: Repo }[] = [];
    for (const record of listApps(this.app.db)) {
      known.add(record.id);
      const repo = getRepoById(this.app.db, record.repoId);
      // A forge coming back does not restart a suspended owner's apps.
      if (repo && accountActive(this.app.db, repo.ownerId))
        present.push({ record, repo });
    }
    for (const { record, repo } of present)
      await this.reconcileApp(record, repo, "boot", "production");
    for (const { record, repo } of present)
      await this.reconcileApp(record, repo, "boot", "preview");
    this.pruneDirs(known);
    await this.sampleStorage();
    this.sweeper = setInterval(
      () => void this.sweep(),
      this.options.sweepEveryMs ?? SWEEP_EVERY_MS,
    );
  }

  /** Stop every process. The rows stay; a restart brings them back. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweeper !== undefined) clearInterval(this.sweeper);
    this.unsubscribe?.();
    const stops: Promise<void>[] = [];
    for (const state of this.envs.values()) {
      state.deploying?.abort.abort();
      if (state.queued)
        cancelRun(this.app.db, state.queued.id, STOPPED_SUMMARY);
      if (state.live) {
        revokeAppToken(this.app.db, state.live.tokenId);
        // A forge leaving (a rollout) lets its sockets reconnect to the
        // forge that replaced it, and answers what it took, before it
        // stops the app (#4496).
        const handle = state.live.handle;
        stops.push(drainPort(handle.port).then(() => handle.stop()));
      }
      // Abort only cancels the step in flight; the `execute()` continuation
      // chained onto `state.chain` still runs afterwards to record the
      // outcome (`finishRun`, `announceRun`). Wait for it too, or it can
      // touch `this.app.db` after a caller who awaited `stop()` closes it.
      stops.push(state.chain.catch(() => {}));
    }
    await Promise.all(stops);
    this.metered(() => closeAllAwake(this.app.db, new Date().toISOString()));
    runtimes.delete(this.app);
  }

  /**
   * Make the environments match the repository: production at the default
   * branch, a preview per open pull, and nothing for pulls that closed while the
   * forge was away.
   */
  async reconcileApp(
    record: AppRecord,
    repo: Repo,
    reason: string,
    only?: "production" | "preview",
  ): Promise<void> {
    const dir = repoDir(this.app.reposRoot, repo.ownerName, repo.name);
    const tip = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
    if (tip !== undefined && only !== "preview")
      this.requestDeploy(record, repo, "production", tip, reason);
    const open = new Set<EnvName>(["production"]);
    // A build preview lives only in memory: one this forge is running stays,
    // and one an earlier life left on disk goes (`previewBuild`).
    for (const state of this.envs.values())
      if (state.app.id === record.id && envBuild(state.env) !== undefined)
        open.add(state.env);
    for (const pull of listPulls(this.app.db, repo.id, { sealed: true,
      state: "open",
      limit: 200,
    })) {
      const env = previewEnv(pull.number);
      open.add(env);
      if (only === "production") continue;
      const head = await this.pullHead(repo, pull);
      if (head === undefined) continue;
      // A preview the forge built in an earlier life comes back asleep, not
      // deployed: nobody is looking at it this second, and the first who
      // does wakes it warm. Thirty previews starting at once is what a
      // restart used to cost.
      // One idle past the age stays stopped: a restart never wakes it.
      if (reason === "boot") {
        // A preview at a head nobody who can write approved — built before
        // the gate, or its approval withdrawn — does not come back at all.
        if (!this.mayRun(record, repo, env, head)) {
          await this.teardown(record, env);
          continue;
        }
        const idleSince = this.idleSince(repo, pull, env);
        if (idleSince !== undefined) {
          this.hibernateAtBoot(record, env, head, idleSince);
          continue;
        }
        if (this.settleAsleep(record, env, head)) continue;
      }
      this.requestDeploy(record, repo, env, head, reason);
    }
    // Environments on disk for pulls that are no longer open.
    const root = join(appsRoot(this.app.config.dataDir), record.id);
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        if (isEnvName(name) && !open.has(name))
          await this.teardown(record, name);
      }
    }
  }

  /** Data on disk for apps that no longer exist. */
  private pruneDirs(known: Set<string>): void {
    const root = appsRoot(this.app.config.dataDir);
    if (!existsSync(root)) return;
    for (const name of readdirSync(root)) {
      if (!known.has(name))
        rmSync(join(root, name), { recursive: true, force: true });
    }
  }

  private async pullHead(repo: Repo, pull: Pull): Promise<string | undefined> {
    const dir = await pullDir(this.app.db, this.app.reposRoot, repo, pull);
    // A fork's pull combined on our side previews the combined build (#9012).
    return previewCommit(dir, pull);
  }

  // ---- events ----

  private async onEvent(event: ForgeEvent): Promise<void> {
    if (this.stopped || event.repoId === null) return;
    if (event.kind === "repo.deleted") {
      await this.teardownAll(event.repoId);
      return;
    }
    const record = getAppByRepo(this.app.db, event.repoId);
    if (!record) return;
    const repo = getRepoById(this.app.db, event.repoId);
    if (!repo) return;
    const dir = repoDir(this.app.reposRoot, repo.ownerName, repo.name);

    switch (event.kind) {
      case "app.created":
        await this.reconcileApp(record, repo, "enabled");
        return;
      case "app.deleted":
        await this.teardownAll(event.repoId);
        return;
      case "push": {
        const updates = event.payload["updates"];
        if (!Array.isArray(updates)) return;
        for (const update of updates as { ref?: unknown; newOid?: unknown }[]) {
          if (
            typeof update.ref !== "string" ||
            typeof update.newOid !== "string"
          )
            continue;
          if (!update.ref.startsWith("refs/heads/")) continue;
          const branch = update.ref.slice("refs/heads/".length);
          const deleted = /^0+$/.test(update.newOid);
          if (branch === repo.defaultBranch && !deleted) {
            this.requestDeploy(
              record,
              repo,
              "production",
              update.newOid,
              "push",
              event.actorId ?? undefined,
            );
          }
          // Every open pull whose head is this branch previews the new tip.
          for (const pull of listPulls(this.app.db, repo.id, { sealed: true,
            state: "open",
            limit: 200,
          })) {
            if (pull.crossRepo || pull.headBranch !== branch || deleted)
              continue;
            this.requestDeploy(
              record,
              repo,
              previewEnv(pull.number),
              update.newOid,
              "push",
              event.actorId ?? undefined,
            );
          }
        }
        return;
      }
      case "pull.pushed": {
        // A fork's branch moved: the base's snapshot followed, and so
        // does the preview.
        const number = event.payload["number"];
        const headOid = event.payload["headOid"];
        if (typeof number !== "number" || typeof headOid !== "string") return;
        this.requestDeploy(
          record,
          repo,
          previewEnv(number),
          headOid,
          "push",
          event.actorId ?? undefined,
        );
        return;
      }
      case "pull.opened":
      case "pull.reopened": {
        const pull = this.pullFromEvent(repo, event);
        if (!pull) return;
        const head = await this.pullHead(repo, pull);
        if (head !== undefined)
          this.requestDeploy(
            record,
            repo,
            previewEnv(pull.number),
            head,
            "opened",
            event.actorId ?? undefined,
          );
        return;
      }
      // An approval is what lets a reader's pull run: deploy its head now.
      // A guest's approval restarts its preview with the app's variables.
      case "pull.run_granted":
      case "pull.guest_approved":
      case "pull.reviewed": {
        // A writer asking for changes may withdraw what let the preview run:
        // if the code it serves may no longer run, it stops now, not at its
        // next sleep or restart.
        if (
          event.kind === "pull.reviewed" &&
          event.payload["state"] === "changes_requested"
        ) {
          const pull = this.pullFromEvent(repo, event);
          if (!pull) return;
          const env = previewEnv(pull.number);
          const state = this.envs.get(key(record.id, env));
          const serving =
            state?.live?.commitOid ??
            state?.deploying?.run.commitOid ??
            state?.asleep?.commitOid;
          if (serving !== undefined && !this.mayRun(record, repo, env, serving))
            await this.teardown(record, env);
          return;
        }
        if (
          event.kind === "pull.reviewed" &&
          event.payload["state"] !== "approved"
        )
          return;
        const pull = this.pullFromEvent(repo, event);
        if (!pull || pull.state !== "open") return;
        const head = await this.pullHead(repo, pull);
        if (head !== undefined)
          this.requestDeploy(
            record,
            repo,
            previewEnv(pull.number),
            head,
            // The same head may be serving already: start it again so it
            // comes up holding the variables it ran without.
            event.kind === "pull.guest_approved" ? "redeploy" : "approved",
            event.actorId ?? undefined,
          );
        return;
      }
      case "pull.closed":
      case "pull.merged": {
        const number = event.payload["number"];
        if (typeof number === "number")
          await this.teardown(record, previewEnv(number));
        // A merge moves the default branch with `update-ref`, which runs no
        // hooks and so announces no push: production follows it from here.
        if (event.kind === "pull.merged") {
          const tip = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
          if (tip !== undefined)
            this.requestDeploy(
              record,
              repo,
              "production",
              tip,
              "merge",
              event.actorId ?? undefined,
            );
        }
        return;
      }
      default:
        return;
    }
  }

  private pullFromEvent(repo: Repo, event: ForgeEvent): Pull | undefined {
    const number = event.payload["number"];
    return typeof number === "number"
      ? getPull(this.app.db, repo.id, number)
      : undefined;
  }

  // ---- deploying ----

  /**
   * Ask for `env` to run `commitOid`. Returns the run that will do it — or
   * the one already serving that commit, when nothing needs to happen.
   */
  requestDeploy(
    record: AppRecord,
    repo: Repo,
    env: EnvName,
    commitOid: string,
    reason: string,
    actorId?: string,
  ): Run | undefined {
    // A suspended or removed owner's app does not deploy, nor does an
    // archived repository's: it is put away, its data kept.
    if (
      this.stopped ||
      repo.archivedAt !== null ||
      !accountActive(this.app.db, repo.ownerId)
    )
      return undefined;
    if (!this.mayRun(record, repo, env, commitOid)) return undefined;
    const state = this.envFor(record, env);
    state.dormant = undefined;
    if (
      (state.live?.commitOid === commitOid ||
        state.asleep?.commitOid === commitOid) &&
      state.deploying === undefined &&
      state.queued === undefined &&
      reason !== "restart" &&
      reason !== "oom" &&
      reason !== "redeploy"
    ) {
      return undefined;
    }
    if (state.deploying?.run.commitOid === commitOid && reason !== "redeploy") {
      return state.deploying.run;
    }
    const issue =
      envPull(env) === undefined ? undefined : this.pullIssueId(repo, env);
    const run = createRun(this.app.db, {
      repoId: repo.id,
      kind: "deploy",
      env,
      commitOid,
      reason,
      ...(issue === undefined ? {} : { issueId: issue }),
      ...(actorId === undefined ? {} : { actorId }),
    });
    announceRun(this.app, run, actorId);
    if (state.queued !== undefined) {
      cancelRun(
        this.app.db,
        state.queued.id,
        `superseded by ${commitOid.slice(0, 7)}`,
      );
    }
    state.queued = run;
    if (reason === "boot" && env === "production") this.bootRuns.set(state, run.id);
    state.chain = state.chain.then(async () => {
      if (state.queued?.id !== run.id) return; // superseded
      state.queued = undefined;
      await this.execute(state, repo, run);
    });
    return run;
  }

  /**
   * Serve one commit now, at `build-<sha7>`. Asked again for a build already
   * here, it redeploys nothing and hands back the same environment. A new
   * one beyond `BUILD_PREVIEWS_MAX` takes the place of the oldest, which is
   * torn down with its data. Nothing of it outlives this process: a forge
   * coming back removes what a build preview left on disk.
   */
  async previewBuild(
    record: AppRecord,
    repo: Repo,
    commitOid: string,
    actorId?: string,
  ): Promise<{ env: EnvName; run: Run | undefined }> {
    const env = buildEnv(commitOid);
    const k = key(record.id, env);
    if (!this.envs.has(k)) {
      // Claimed before anything waits, so two asks at once count each other.
      this.envFor(record, env).buildOrder = ++this.buildCount;
      const builds = [...this.envs.values()]
        .filter((s) => s.app.id === record.id && s.buildOrder !== undefined)
        .sort((a, b) => b.buildOrder! - a.buildOrder!);
      for (const old of builds.slice(BUILD_PREVIEWS_MAX)) {
        log.info("build preview replaced", { app: record.slug, env: old.env, by: env });
        await this.teardown(record, old.env);
      }
    }
    // Torn down by a newer ask while the old ones went: nothing to deploy.
    if (!this.envs.has(k)) return { env, run: undefined };
    const run = this.requestDeploy(record, repo, env, commitOid, "build", actorId);
    return { env, run };
  }

  private pullIssueId(repo: Repo, env: EnvName): string | undefined {
    const pull = getPull(this.app.db, repo.id, Number(env.slice(5)));
    return pull?.id;
  }

  private envFor(record: AppRecord, env: EnvName): Environment {
    const k = key(record.id, env);
    let state = this.envs.get(k);
    if (state === undefined) {
      state = {
        app: record,
        env,
        chain: Promise.resolve(),
        restarts: [],
        openStreams: 0,
        openRequests: 0,
      };
      this.envs.set(k, state);
    }
    return state;
  }

  /**
   * Previews of the account's apps that are up, `except` aside, and those
   * coming up whose run is older than `before`: of two deploying together
   * the older counts against the younger, never both against each other.
   * With no `before`, every one coming up counts (a wake has no run).
   */
  private livePreviews(
    ownerId: string,
    except: Environment,
    before?: string,
  ): number {
    let n = 0;
    for (const other of this.envs.values()) {
      if (other === except || other.env === "production") continue;
      const up =
        other.live !== undefined ||
        (other.deploying !== undefined &&
          (before === undefined || other.deploying.run.id < before));
      if (!up) continue;
      if (getRepoById(this.app.db, other.app.repoId)?.ownerId === ownerId) n++;
    }
    return n;
  }

  private async execute(
    state: Environment,
    repo: Repo,
    run: Run,
  ): Promise<void> {
    const claimed = claimRun(this.app.db, run.id);
    if (!claimed) return; // cancelled meanwhile
    const lease = holdLease(this.app.db, run.id);
    const abort = new AbortController();
    state.deploying = { run: claimed, abort };
    state.lastRunId = run.id;
    const write = (line: string): void =>
      appendRunLog(this.app.config.dataDir, run.id, line);
    announceRun(this.app, claimed);
    // An account's live previews are bounded (`settings/quotas.ts`): a
    // preview past the limit does not start, and its run — the check the
    // pull shows — fails saying why, so the pull never waits for it.
    const refusal =
      state.env === "production" || state.live !== undefined
        ? undefined
        : runningLimitSentence(
            this.app.db,
            "previews",
            "live previews",
            repo.ownerId,
            () => this.livePreviews(repo.ownerId, state, run.id),
          );
    if (refusal !== undefined) {
      state.deploying = undefined;
      lease();
      const message = `not started: ${refusal}. Close a pull or stop a preview to make room.`;
      write(message);
      const done = finishRun(this.app.db, run.id, { state: "failed", summary: message });
      if (done) announceRun(this.app, done);
      return;
    }
    write(
      `deploy ${state.env} of ${repo.ownerName}/${repo.name} at ${run.commitOid.slice(0, 7)} (${run.reason})`,
    );

    // The clock starts at the claim, the instant the log calls "the deploy
    // started"; the first lap is the wait for a permit. Production goes
    // ahead of previews waiting for one: it is the environment a person
    // actually visits.
    const clock = new Stopwatch();
    // A deploy that throws is a failed run, never a fallen forge: the chain
    // this runs on would otherwise reject unhandled and take the process.
    const outcome = await this.gate
      .run(
        () => {
          clock.lap("turn");
          return this.bringUp(state, repo, run, write, abort.signal, clock);
        },
        { first: state.env === "production" },
      )
      .catch((error: unknown) => ({
        ok: false as const,
        error: `deploy failed: ${error instanceof Error ? error.message : String(error)}`,
      }));

    if (!outcome.ok) {
      state.deploying = undefined;
      lease();
      // The runtime itself stopping is what aborted the step in flight —
      // the forge's own business, never this commit's fault, and the same
      // honest reason the still-queued case already carries. A real
      // failure (a non-zero exit, a genuine timeout) still fails the run
      // below even if the runtime happens to be stopping at the same time:
      // only an abort this runtime raised earns the quieter outcome.
      if (this.stopped && abort.signal.aborted) {
        const done = cancelRun(this.app.db, run.id, STOPPED_SUMMARY);
        write(`cancelled: ${STOPPED_SUMMARY}`);
        if (done) announceRun(this.app, done);
        return;
      }
      state.lastError = outcome.error;
      state.lastErrorCommitOid = run.commitOid;
      const done = finishRun(this.app.db, run.id, {
        state: "failed",
        summary: outcome.error,
      });
      write(`failed: ${outcome.error}`);
      if (state.live !== undefined)
        write(
          `the previous deployment (${state.live.commitOid.slice(0, 7)}) keeps serving`,
        );
      if (done) announceRun(this.app, done);
      return;
    }

    // It answers: swap it in now, before its tests are done. `state.deploying`
    // stays set — the run is still open, and a stop or a teardown must still
    // be able to reach in and kill the test step — until they finish below.
    // `servingAt` is stamped here, at the swap-in, the same instant the log
    // says so — never the moment the tests beside it finish.
    const previous = state.live;
    const rested = state.asleep;
    const served = markServing(this.app.db, run.id);
    const servingAt = served?.servingAt ?? new Date().toISOString();
    const deployStartedAt = claimed.startedAt;
    // The run was created the instant the push asked for it; it started when
    // the gate handed it a permit. Both travel with the deployment: the log
    // below is measured from the start, the studio's phrase from the push.
    const createdAt = PUSH_REASONS.includes(run.reason)
      ? run.createdAt
      : undefined;
    const live: Live = {
      ...outcome.value,
      servingAt,
      createdAt,
      deployStartedAt,
    };
    state.live = live;
    this.awake(state, servingAt);
    state.asleep = undefined;
    state.lastRequestAt = Date.now();
    state.lastError = undefined;
    if (rested !== undefined && rested.dir !== live.dir)
      rmSync(rested.dir, { recursive: true, force: true });
    state.lastErrorCommitOid = undefined;
    if (previous !== undefined) {
      write(
        `stopping the previous deployment (${previous.commitOid.slice(0, 7)})`,
      );
      revokeAppToken(this.app.db, previous.tokenId);
      // Traffic already goes to the new one: the old one's sockets are told
      // to reconnect (1012), and what it was answering is answered (#4496).
      const unanswered = await drainPort(previous.handle.port);
      if (unanswered > 0)
        write(`${unanswered} request(s) to the previous deployment were still waiting after ${seconds(DRAIN_BUDGET_MS)}`);
      await previous.handle.stop();
      if (previous.dir !== live.dir)
        rmSync(previous.dir, { recursive: true, force: true });
    }
    this.watch(state, repo, live);
    const url = this.urlFor(state.app, state.env);
    write(
      deployStartedAt
        ? `serving ${url} — ${elapsedSeconds(deployStartedAt, servingAt)} after the deploy started`
        : `serving ${url}`,
    );
    // The same statement the log line above just made, on the bus: a
    // subscriber (the looks service) must never be able to take the
    // deploy path down with it.
    try {
      const release = await releaseOfCommit(
        repoDir(this.app.reposRoot, repo.ownerName, repo.name),
        state.env,
        live.commitOid,
      );
      this.app.bus.append({
        kind: "app.serving",
        repoId: repo.id,
        payload: {
          app: state.app.slug,
          env: state.env,
          commitOid: live.commitOid,
          servingAt,
          ...(deployStartedAt === null ? {} : { deployStartedAt }),
          testsRunning: live.manifest.test !== null,
          ...(release === undefined ? {} : { version: release.version, pulls: release.pulls }),
        },
      });
    } catch (error) {
      log.error("could not publish app.serving", { error: String(error) });
    }

    // A preview is held to the website specification once it is live, beside
    // its tests and after the swap-in (#2955). Report-only and unawaited: the
    // run neither waits for it nor can it fail.
    if (state.env !== "production")
      void checkPreview(
        this.app.db,
        run.id,
        `http://127.0.0.1:${live.handle.port}`,
        live.manifest.looks,
      );

    const tested = await outcome.tested;
    state.deploying = undefined;
    lease();
    if (tested.ok) {
      const done = finishRun(this.app.db, run.id, {
        state: "ok",
        summary: `running at ${url}${live.manifest.test === null ? NO_TESTS_TAIL : TESTS_PASSED_TAIL}`,
      });
      write(`done: ${url}`);
      if (done && state.env === "production") await this.noteCarried(repo, done);
      if (done) announceRun(this.app, done);
      return;
    }
    // The tests failed, but the deployment that answered is what was asked
    // for: it keeps serving, and the run — the check a pull shows — fails.
    if (state.live === live)
      state.live = { ...live, testsFailed: tested.error };
    const done = finishRun(this.app.db, run.id, {
      state: "failed",
      summary: `test: ${tested.error}`,
    });
    write(`failed: test: ${tested.error}`);
    write(`serving ${url} anyway — its tests failed`);
    if (done) announceRun(this.app, done);
  }

  /** Note the merged pulls a finished production deploy carries; never fails the deploy. */
  private async noteCarried(repo: Repo, run: Run): Promise<void> {
    try {
      const dir = await runDir(this.app.db, this.app.reposRoot, repo, null);
      await recordCarried(this.app.db, {
        runId: run.id,
        repoId: repo.id,
        commitOid: run.commitOid,
        dir,
      });
    } catch (error) {
      log.error("could not record what a deploy carries", { error: String(error) });
    }
  }

  private async bringUp(
    state: Environment,
    repo: Repo,
    run: Run,
    write: (line: string) => void,
    signal: AbortSignal,
    clock: Stopwatch,
  ): Promise<
    | { ok: true; value: Live; tested: Promise<Result<void, string>> }
    | { ok: false; error: string }
  > {
    // A sealed pull's preview is built from where its work is (`pullDir`).
    const bare = await runDir(this.app.db, this.app.reposRoot, repo, run.issueId);
    const [forgeJson, packageJson] = await Promise.all([
      readFileAt(bare, run.commitOid, "forge.json"),
      readFileAt(bare, run.commitOid, "package.json"),
    ]);
    const manifest = parseManifest(forgeJson, packageJson);
    clock.lap("manifest");
    if (!manifest.ok) {
      return {
        ok: false,
        error:
          manifest.error.kind === "not_an_app"
            ? "this commit is not an app: no forge.json with an app, and no package.json start script"
            : manifest.error.message,
      };
    }
    const dir = join(
      envDir(this.app.config.dataDir, state.app.id, state.env),
      run.commitOid.slice(0, 7),
    );
    // A checkout that is already here was installed and tested when it was
    // made; the forge coming back starts it, and only starts it.
    const warm = existsSync(join(dir, "package.json"));
    if (warm) {
      write(`warm start: ${run.commitOid.slice(0, 7)} was built here before`);
    } else {
      write(`checking out ${run.commitOid.slice(0, 7)}`);
      const exported = await exportTree(bare, run.commitOid, dir);
      if (!exported.ok) return { ok: false, error: exported.error };
    }
    clock.lap(warm ? "checkout (warm)" : "checkout");

    const seeded = ensureEnvData(
      this.app.config.dataDir,
      state.app.id,
      state.env,
      state.app.previewData,
    );
    const dataDir = envDataDir(
      this.app.config.dataDir,
      state.app.id,
      state.env,
    );
    if (seeded === "cloned" || seeded === "copied")
      write(`data: ${seeded} from production`);
    else if (seeded === "empty" && state.env !== "production")
      write("data: starting empty");
    clock.lap("data");

    // The process's own credential; every way out of here without a
    // process to hold it revokes it.
    const token = mintAppToken(
      this.app.db,
      repo.ownerId,
      state.app.slug,
      state.env,
    );
    const startInput: Omit<StartInput, "signal"> = {
      dir,
      dataDir,
      manifest: manifest.value,
      env: state.env,
      url: this.urlFor(state.app, state.env),
      commitOid: run.commitOid,
      forgeUrl: this.options.forgeUrl,
      identityKey: identityKey(this.app.config.dataDir, state.app.id),
      ssh: this.sshFor(state.app, state.env),
      // Read at start, never cached: a change is a redeploy, and the
      // process that comes up is the one that sees it.
      ...this.secretsFor(repo, state.app.id, state.env, token.token),
      feature: this.featureFor(state.app.id, dir),
      log: write,
      warm,
      cell: this.cellFor(state.app, state.env),
      // Every environment, production too, installs from the cache the
      // repository's checks fill, so a new preview fetches nothing it has.
      installCache: checkInstallCache(this.app.config.dataDir, repo.id),
    };
    this.noteCell(run.id, write);
    clock.lap("setup");
    write(clock.line("starting the process"));
    const start = async (): ReturnType<typeof startProcess> => {
      try {
        return await startProcess({ ...startInput, signal });
      } catch (error) {
        revokeAppToken(this.app.db, token.id);
        throw error;
      }
    };
    let started = await start();

    // The one retry this deploy gets: a preview seeded from production whose
    // process died before it ever answered — schema ahead of what this build
    // knows, most often — is tried again on empty data, once. A production
    // deploy is never seeded from a copy, so it never takes this path.
    if (
      !started.ok &&
      (seeded === "cloned" || seeded === "copied") &&
      diedBeforeAnswering(started.error)
    ) {
      const first = started.error;
      write(`failed: ${first.stage}: ${first.message}`);
      write(
        "the copied data was not usable by this build; the preview is starting on empty data",
      );
      reseedEmpty(this.app.config.dataDir, state.app.id, state.env);
      started = await start();
      if (!started.ok) {
        revokeAppToken(this.app.db, token.id);
        rmSync(dir, { recursive: true, force: true });
        return {
          ok: false,
          error: `${started.error.stage}: ${started.error.message} (retried on empty data after the copy failed with ${first.stage}: ${first.message})`,
        };
      }
    } else if (!started.ok) {
      revokeAppToken(this.app.db, token.id);
      rmSync(dir, { recursive: true, force: true });
      return {
        ok: false,
        error: `${started.error.stage}: ${started.error.message}`,
      };
    }
    return {
      ok: true,
      value: {
        commitOid: run.commitOid,
        handle: started.value.handle,
        dir,
        runId: run.id,
        since: new Date().toISOString(),
        manifest: manifest.value,
        tokenId: token.id,
      },
      tested: started.value.tested,
    };
  }

  /**
   * What an environment's processes are held to: the forge's data and home
   * hidden, the environment's own home. `undefined` where cells cannot work.
   */
  cellFor(record: AppRecord, env: EnvName): CellBase | undefined {
    if (!this.cells.ok) return undefined;
    const dataDir = this.app.config.dataDir;
    return {
      hide: [dataDir, process.env["HOME"] ?? "", tmpdir()],
      home: join(envDir(dataDir, record.id, env), "home"),
      onUndeclared: (host, port) =>
        noteReached(dataDir, record.repoId, host, port),
      // Asked at every start: an admin's grant reaches the next cell.
      granted: grantedFor(this.app.db, record.repoId),
      // Likewise an admin's flip of the egress mode.
      egressMode: egressSetting(this.app.db),
      label: `app:${record.slug}/${env}`,
      repoId: record.repoId,
    };
  }

  /** Say on the run, once, whether its processes were held. */
  private noteCell(runId: string, write: (line: string) => void): void {
    noteRunProgress(this.app.db, runId, {
      sandbox: {
        enforced: this.cells.ok,
        note: this.cells.ok ? "" : this.cells.reason,
      },
    });
    if (!this.cells.ok)
      write(`uncontained here: ${this.cells.reason}; the app's processes run unrestricted`);
  }

  /** The running environment a terminal session would attach to, if any. */
  liveFor(record: AppRecord, env: EnvName): LiveEnv | undefined {
    const state = this.envs.get(key(record.id, env));
    const live = state?.live;
    if (state === undefined || live === undefined) return undefined;
    const dataDir = envDataDir(this.app.config.dataDir, record.id, env);
    const base = this.cellFor(record, env);
    return {
      env,
      dir: live.dir,
      dataDir,
      port: live.handle.port,
      commitOid: live.commitOid,
      url: this.urlFor(record, env),
      tty: live.manifest.tty,
      cell:
        base === undefined
          ? undefined
          : {
              dir: live.dir,
              writable: [dataDir],
              home: base.home,
              hide: base.hide,
              egress: live.manifest.egress ?? [],
              granted: base.granted,
              // A terminal is the app's own client: it reaches the app on
              // its port, as it would beside it.
              reach: [
                this.options.forgeUrl,
                `http://127.0.0.1:${live.handle.port}`,
              ],
              limits: resolveLimits("app", live.manifest.limits),
              terminal: true,
              onUndeclared: base.onUndeclared,
              egressMode: base.egressMode,
              label: base.label,
            },
    };
  }

  /** When a live process ends on its own, say so and bring it back — bounded. */
  private watch(state: Environment, repo: Repo, live: Live): void {
    live.handle.exited
      .then((code) => {
        if (this.stopped || state.live !== live) return; // replaced or stopped on purpose
        state.live = undefined;
        this.resting(state);
        revokeAppToken(this.app.db, live.tokenId);
        // The cell's memory cap — its own watch or the kernel's OOM killer —
        // is a cause of its own on the restarts board (`boards/sources.ts`).
        const breach = live.handle.breach?.();
        const oom = breach !== undefined && /memory/.test(breach);
        state.lastError = `exited with code ${code}`;
        appendRunLog(
          this.app.config.dataDir,
          live.runId,
          `process exited with code ${code}`,
        );
        const now = Date.now();
        state.restarts = state.restarts.filter(
          (at) => now - at < RESTART_WINDOW_MS,
        );
        if (state.restarts.length >= RESTART_MAX) {
          state.lastError = `exited with code ${code}; restarted ${RESTART_MAX} times in ten minutes, giving up`;
          appendRunLog(this.app.config.dataDir, live.runId, state.lastError);
          return;
        }
        const delay = RESTART_BACKOFF_MS[state.restarts.length] ?? 30_000;
        state.restarts.push(now);
        setTimeout(() => {
          if (this.stopped) return;
          const fresh = getRepoById(this.app.db, repo.id);
          if (fresh)
            this.requestDeploy(
              state.app,
              fresh,
              state.env,
              live.commitOid,
              oom ? "oom" : "restart",
            );
        }, delay);
      })
      .catch(() => {});
  }

  // ---- tearing down ----

  /** Stop an environment and remove everything it owned, data included. */
  /** Something came through the proxy: the environment is wanted. */
  touch(record: AppRecord, env: EnvName): void {
    const state = this.envs.get(key(record.id, env));
    if (state === undefined) return;
    state.lastRequestAt = Date.now();
    state.keptAwake = undefined;
  }

  /**
   * A stream through the proxy opened: the environment is busy until the
   * returned release is called — once; a second call does nothing.
   */
  holdStream(record: AppRecord, env: EnvName): () => void {
    const state = this.envs.get(key(record.id, env));
    if (state === undefined) return () => {};
    state.openStreams++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      state.openStreams--;
      state.lastRequestAt = Date.now();
    };
  }

  /**
   * A request passed to the app is waiting on its answer: the environment
   * is busy until the returned release is called — once; a second call
   * does nothing. Still inside the busy grace, so a hung app sleeps anyway.
   */
  holdRequest(record: AppRecord, env: EnvName): () => void {
    const state = this.envs.get(key(record.id, env));
    if (state === undefined) return () => {};
    state.openRequests++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      state.openRequests--;
      state.lastRequestAt = Date.now();
    };
  }

  /**
   * An absorbed app's settings for a process about to start in `dir`, read
   * from that checkout's forge.json; nothing for an app not absorbed.
   */
  featureFor(appId: string, dir: string): Record<string, string> {
    let forgeJson: string | undefined;
    try {
      forgeJson = readFileSync(join(dir, "forge.json"), "utf8");
    } catch {
      forgeJson = undefined;
    }
    return featureVarsAt(this.app.db, appId, forgeJson);
  }

  /**
   * What a process for `env` starts holding: the operator's variables, read
   * at start, and the forge token. A preview of a guest pull nobody has
   * approved yet (`origins/guest.ts`) holds neither.
   */
  secretsFor(
    repo: Repo,
    appId: string,
    env: EnvName,
    forgeToken: string,
  ): { vars: Record<string, string>; forgeToken: string | undefined } {
    const number = envPull(env);
    const pull =
      number === undefined ? undefined : getPull(this.app.db, repo.id, number);
    if (pull !== undefined && guestWaits(this.app.db, pull))
      return { vars: {}, forgeToken: undefined };
    return {
      vars: resolveAppEnv(this.app.db, this.app.config.dataDir, appId, env),
      forgeToken,
    };
  }

  /**
   * An environment asleep is started again, warm, from the checkout it
   * kept; one start serves every request that arrives while it happens.
   * Returns once it is live, or once it is clear it will not be.
   */
  /**
   * A preview runs a pull's code: from someone who cannot write, only once
   * a writer has approved this exact head (`core/pull_trust.ts`). Asked by
   * every door that starts one — a deploy and a wake.
   */
  private mayRun(
    record: AppRecord,
    repo: Repo,
    env: EnvName,
    commitOid: string,
  ): boolean {
    // A guest's fork has no app; were one ever to reach here, it starts nothing.
    if (isContributionFork(this.app.db, repo.id)) return false;
    // Production is the default branch and a build preview a commit a writer asked to see
    // (`actions/build_preview.ts`): each is a writer's choice already.
    if (env === "production" || envBuild(env) !== undefined)
      return true;
    const number = envPull(env);
    const pull =
      number === undefined ? undefined : getPull(this.app.db, repo.id, number);
    // A combined preview runs under the head it carries, read from git (#9012).
    const head =
      pull === undefined
        ? commitOid
        : headUnder(repoDir(this.app.reposRoot, repo.ownerName, repo.name), pull, commitOid);
    if (pull !== undefined && pullMayRun(this.app.db, repo, pull, head))
      return true;
    log.info("preview waits for a writer's approval", {
      app: record.slug,
      env,
      commit: commitOid.slice(0, 7),
    });
    return false;
  }

  async wake(record: AppRecord, env: EnvName): Promise<LiveEnv | undefined> {
    const state = this.envs.get(key(record.id, env));
    if (state === undefined) return undefined;
    if (state.waking !== undefined) await state.waking;
    if (state.live !== undefined) return this.liveFor(record, env);
    const asleep = state.asleep;
    if (asleep === undefined || this.stopped) return undefined;
    const repo = getRepoById(this.app.db, record.repoId);
    // Waking runs code without a run row: the owner's standing is asked here.
    if (!repo || !accountActive(this.app.db, repo.ownerId)) return undefined;
    // So is whose code it is: a preview asleep at a head nobody who can
    // write approved — built before the gate, or approved by someone who
    // can no longer write — is taken down, not woken. Approving the head
    // deploys it again.
    if (!this.mayRun(record, repo, env, asleep.commitOid)) {
      await this.teardown(record, env);
      return undefined;
    }
    // A wake starts a process too: past the account's preview limit it stays asleep.
    const full = runningLimitSentence(
      this.app.db,
      "previews",
      "live previews",
      repo.ownerId,
      () => this.livePreviews(repo.ownerId, state),
    );
    if (full !== undefined) {
      log.info("preview stays asleep", { app: record.slug, env, limit: full });
      state.wakeRefused = `This preview stays asleep: its owner is at ${full}. Close a pull or stop a preview to make room.`;
      return undefined;
    }
    state.wakeRefused = undefined;
    state.waking = (async () => {
      const write = (line: string): void => {
        if (asleep.runId !== "")
          appendRunLog(this.app.config.dataDir, asleep.runId, line);
      };
      write("waking: a request came");
      const token = mintAppToken(this.app.db, repo.ownerId, record.slug, env);
      const started = await startProcess({
        dir: asleep.dir,
        dataDir: envDataDir(this.app.config.dataDir, record.id, env),
        manifest: asleep.manifest,
        env,
        url: this.urlFor(record, env),
        commitOid: asleep.commitOid,
        forgeUrl: this.options.forgeUrl,
        identityKey: identityKey(this.app.config.dataDir, record.id),
        ssh: this.sshFor(record, env),
        ...this.secretsFor(repo, record.id, env, token.token),
        feature: this.featureFor(record.id, asleep.dir),
        log: write,
        signal: new AbortController().signal,
        warm: true,
        cell: this.cellFor(record, env),
      }).catch((error: unknown) => {
        revokeAppToken(this.app.db, token.id);
        throw error;
      });
      if (state.asleep !== asleep || !started.ok)
        revokeAppToken(this.app.db, token.id);
      if (state.asleep !== asleep) {
        // Replaced while waking — a deploy landed. What we started is spare.
        if (started.ok) await started.value.handle.stop();
        return;
      }
      if (!started.ok) {
        state.asleep = undefined;
        state.lastError = `did not wake — ${started.error.stage}: ${started.error.message}`;
        write(`failed: ${state.lastError}`);
        return;
      }
      const now = new Date().toISOString();
      const live: Live = {
        commitOid: asleep.commitOid,
        handle: started.value.handle,
        dir: asleep.dir,
        runId: asleep.runId,
        since: now,
        manifest: asleep.manifest,
        servingAt: now,
        tokenId: token.id,
      };
      state.asleep = undefined;
      state.live = live;
      this.awake(state, now);
      state.lastRequestAt = Date.now();
      this.watch(state, repo, live);
      write("awake");
    })().finally(() => {
      state.waking = undefined;
    });
    await state.waking;
    return this.liveFor(record, env);
  }

  /**
   * At boot, an environment whose checkout for this commit is still here
   * is registered asleep rather than deployed. True when it was.
   */
  private settleAsleep(
    record: AppRecord,
    env: EnvName,
    commitOid: string,
  ): boolean {
    const dir = join(
      envDir(this.app.config.dataDir, record.id, env),
      commitOid.slice(0, 7),
    );
    if (!existsSync(join(dir, "package.json"))) return false;
    const read = (name: string): string | undefined => {
      try {
        return readFileSync(join(dir, name), "utf8");
      } catch {
        return undefined;
      }
    };
    const manifest = parseManifest(read("forge.json"), read("package.json"));
    if (!manifest.ok) return false;
    const state = this.envFor(record, env);
    if (state.live !== undefined || state.deploying !== undefined) return true;
    // The deploy that built this checkout, in an earlier life: its log is
    // where the environment's sleeping and waking keep being written.
    const built = listRuns(this.app.db, record.repoId, {
      kind: "deploy",
      limit: 100,
    }).find(
      (r) => r.env === env && r.state === "ok" && r.commitOid === commitOid,
    );
    state.asleep = {
      commitOid,
      dir,
      manifest: manifest.value,
      runId: built?.id ?? "",
      since: new Date().toISOString(),
    };
    state.lastRunId ??= built?.id;
    log.info("asleep from boot", {
      app: record.slug,
      env,
      commit: commitOid.slice(0, 7),
    });
    return true;
  }

  /**
   * When a pull was last touched, if that is longer ago than the idle age:
   * the later of its `updatedAt` (comments, reviews) and the newest deploy
   * run a person caused — a push, an opening, a press of Redeploy, a wake.
   * Undefined when the feature is off, the pull was touched within the age,
   * or someone is deciding it right now (a queued or running run on it).
   */
  private idleSince(repo: Repo, pull: Pull, env: EnvName): string | undefined {
    const age = this.options.idlePullMs ?? 0;
    if (age <= 0 || pull.state !== "open") return undefined;
    const now = Date.now();
    let last = Date.parse(pull.updatedAt);
    if (now - last < age) return undefined;
    const runs = listRuns(this.app.db, repo.id, {
      issueId: pull.id,
      limit: 50,
    });
    if (runs.some((r) => r.state === "queued" || r.state === "running"))
      return undefined;
    for (const r of runs) {
      if (r.kind === "deploy" && r.env === env && TOUCH_REASONS.includes(r.reason))
        last = Math.max(last, Date.parse(r.createdAt));
    }
    return now - last < age ? undefined : new Date(last).toISOString();
  }

  /** At boot: register a preview idle past the age as stopped, no process. */
  private hibernateAtBoot(
    record: AppRecord,
    env: EnvName,
    commitOid: string,
    idleSince: string,
  ): void {
    const state = this.envFor(record, env);
    if (state.live !== undefined || state.deploying !== undefined) return;
    state.dormant = {
      since: new Date().toISOString(),
      idleSince,
      commitOid,
    };
    const built = listRuns(this.app.db, record.repoId, {
      kind: "deploy",
      env,
      limit: 50,
    }).find((r) => r.state === "ok");
    state.lastRunId ??= built?.id;
    log.info("dormant from boot", { app: record.slug, env });
  }

  /** A dormant preview someone asked for deploys again, the ordinary way. */
  rouse(record: AppRecord, env: EnvName): void {
    const state = this.envs.get(key(record.id, env));
    const dormant = state?.dormant;
    if (dormant === undefined) return;
    const repo = getRepoById(this.app.db, record.repoId);
    if (repo) this.requestDeploy(record, repo, env, dormant.commitOid, "wake");
  }

  /** Stop the previews whose pulls have gone quiet; keep everything else. */
  private async hibernate(): Promise<void> {
    if ((this.options.idlePullMs ?? 0) <= 0) return;
    for (const state of [...this.envs.values()]) {
      const number = envPull(state.env);
      if (
        number === undefined ||
        state.dormant !== undefined ||
        state.deploying !== undefined ||
        state.queued !== undefined ||
        state.waking !== undefined ||
        (state.live === undefined && state.asleep === undefined)
      )
        continue;
      const repo = getRepoById(this.app.db, state.app.repoId);
      const pull = repo && getPull(this.app.db, repo.id, number);
      if (!repo || !pull) continue;
      const idleSince = this.idleSince(repo, pull, state.env);
      if (idleSince === undefined) continue;
      const commitOid = state.live?.commitOid ?? state.asleep!.commitOid;
      const runId = state.live?.runId ?? state.asleep!.runId;
      await this.stopEnv(state.app, state.env);
      if (this.stopped || state.live !== undefined || state.queued !== undefined)
        continue;
      state.dormant = {
        since: new Date().toISOString(),
        idleSince,
        commitOid,
      };
      state.lastError = undefined;
      state.lastErrorCommitOid = undefined;
      if (runId !== "")
        appendRunLog(
          this.app.config.dataDir,
          runId,
          `asleep: nobody pushed to or commented on pull #${number} since ${idleSince}; asking for it, or Redeploy, brings it back`,
        );
      log.info("dormant", { app: state.app.slug, env: state.env });
    }
  }

  /** Stop what nobody has asked for lately, and keep it ready to wake. */
  private async sweep(): Promise<void> {
    if (this.stopped) return;
    await this.hibernate();
    const after = this.options.sleepAfterMs ?? SLEEP_AFTER_MS;
    const grace = this.options.busyGraceMs ?? BUSY_GRACE_MS;
    const now = Date.now();
    this.metered(() => beatAwake(this.app.db, new Date(now).toISOString()));
    for (const state of this.envs.values()) {
      const live = state.live;
      // Still running: its credential is still wanted for another window.
      if (live?.tokenId !== undefined)
        renewAppToken(this.app.db, live.tokenId, now);
      const spared = state.keptAwake;
      state.keptAwake = undefined;
      if (
        live === undefined ||
        state.deploying !== undefined ||
        state.queued !== undefined ||
        state.waking !== undefined
      )
        continue;
      const limit =
        state.env === "production" ? after.production : after.preview;
      const last = state.lastRequestAt ?? Date.parse(live.since);
      if (now - last < limit) continue;
      // Idle by the clock; asked whether it is mid-work, and spared while
      // it is — but only for one grace past the window, never forever.
      const busy = busyReason(
        live.handle.pid,
        state.openStreams,
        state.openRequests,
      );
      const overdue = now - last - limit >= grace;
      if (busy !== undefined && !overdue) {
        if (spared !== busy && live.runId !== "")
          appendRunLog(
            this.app.config.dataDir,
            live.runId,
            `kept awake: ${BUSY_WORDS[busy]}`,
          );
        state.keptAwake = busy;
        continue;
      }
      state.live = undefined;
      this.resting(state, now);
      state.asleep = {
        commitOid: live.commitOid,
        dir: live.dir,
        manifest: live.manifest,
        runId: live.runId,
        since: new Date(now).toISOString(),
      };
      if (live.runId !== "")
        appendRunLog(
          this.app.config.dataDir,
          live.runId,
          busy === undefined
            ? `asleep: nothing asked for it in ${Math.round(limit / 60_000)} minutes; the next request wakes it`
            : `asleep: still busy ${Math.round(grace / 60_000)} minutes past its idle window, which is as long as busy keeps an app awake; the next request wakes it`,
        );
      log.info("asleep", { app: state.app.slug, env: state.env });
      revokeAppToken(this.app.db, live.tokenId);
      await live.handle.stop();
    }
    await this.sampleStorage();
  }

  // ---- the meter ----

  /**
   * Run one write to the meter. What an app used is worth recording, never
   * worth taking a deploy, a sleep or a shutdown down with it.
   */
  private metered<T>(write: () => T): T | undefined {
    if (this.app.closing.signal.aborted) return undefined;
    try {
      return write();
    } catch (error) {
      log.error("meter write failed", { error: String(error) });
      return undefined;
    }
  }

  /** The forge is closing: stop the sweeper, end open intervals, then the meter goes quiet. */
  private closeMeter(): void {
    this.stopped = true;
    if (this.sweeper !== undefined) clearInterval(this.sweeper);
    try {
      closeAllAwake(this.app.db, new Date().toISOString());
    } catch (error) {
      log.error("meter write failed", { error: String(error) });
    }
  }

  /** The environment began serving: its awake interval opens, if not open. */
  private awake(state: Environment, at: string): void {
    this.metered(() =>
      openAwake(this.app.db, {
        repoId: state.app.repoId,
        env: state.env,
        placement: this.options.placement ?? "owned",
        at,
      }),
    );
  }

  /** The environment stopped serving: its awake interval closes. */
  private resting(state: Environment, at: number = Date.now()): void {
    this.metered(() =>
      closeAwake(this.app.db, {
        repoId: state.app.repoId,
        env: state.env,
        at: new Date(at).toISOString(),
      }),
    );
  }

  private sampling = false;

  /**
   * Once per `storageEveryMs`: the bytes of each app's `FORGE_APP_DATA`,
   * every environment summed, and of its bare repository.
   */
  private async sampleStorage(): Promise<void> {
    if (this.stopped || this.sampling) return;
    const every = this.options.storageEveryMs ?? SAMPLE_SPAN_MS;
    const last = this.metered(() => lastStorageAt(this.app.db));
    if (last !== undefined && Date.now() - Date.parse(last) < every) return;
    this.sampling = true;
    try {
      const at = new Date().toISOString();
      for (const record of listApps(this.app.db)) {
        const repo = getRepoById(this.app.db, record.repoId);
        if (!repo) continue;
        let dataBytes = 0;
        const root = join(appsRoot(this.app.config.dataDir), record.id);
        if (existsSync(root))
          for (const name of readdirSync(root))
            if (isEnvName(name))
              dataBytes += await dirBytes(
                envDataDir(this.app.config.dataDir, record.id, name),
              );
        const repoBytes = await dirBytes(
          repoDir(this.app.reposRoot, repo.ownerName, repo.name),
        );
        if (this.stopped) return;
        this.metered(() =>
          recordStorage(this.app.db, {
            repoId: record.repoId,
            dataBytes,
            repoBytes,
            at,
          }),
        );
      }
    } finally {
      this.sampling = false;
    }
  }

  async teardown(record: AppRecord, env: EnvName): Promise<void> {
    const k = key(record.id, env);
    const state = this.envs.get(k);
    if (state !== undefined) {
      this.envs.delete(k);
      if (state.queued)
        cancelRun(this.app.db, state.queued.id, "the environment was removed");
      state.deploying?.abort.abort();
      await state.chain.catch(() => {});
      // Null the reference before stopping it: `watch()`'s exit handler
      // only no-ops on a deliberate stop when `state.live` no longer points
      // at the process it is watching. Leaving it set here (as `stopEnv`
      // knows not to) had the exit handler read this as a crash and
      // schedule a restart — resurrecting a torn-down preview seconds
      // after its pull closed, checkout, cloned data and all.
      const live = state.live;
      state.live = undefined;
      this.resting(state);
      revokeAppToken(this.app.db, live?.tokenId);
      if (live) await live.handle.stop();
    }
    removeEnv(this.app.config.dataDir, record.id, env);
  }

  async teardownAll(repoId: string): Promise<void> {
    const states = [...this.envs.values()].filter(
      (s) => s.app.repoId === repoId,
    );
    for (const state of states) await this.teardown(state.app, state.env);
    for (const state of states)
      removeApp(this.app.config.dataDir, state.app.id);
  }

  /** Stop every environment of a repository's app; the data stays. */
  async stopRepo(repoId: string): Promise<void> {
    const states = [...this.envs.values()].filter(
      (s) => s.app.repoId === repoId,
    );
    for (const state of states) await this.stopEnv(state.app, state.env);
  }

  /** Stop an environment's process without removing its data. */
  async stopEnv(record: AppRecord, env: EnvName): Promise<void> {
    const state = this.envs.get(key(record.id, env));
    if (state === undefined) return;
    if (state.queued) cancelRun(this.app.db, state.queued.id, "stopped");
    state.deploying?.abort.abort();
    await state.chain.catch(() => {});
    const live = state.live;
    state.live = undefined;
    this.resting(state);
    state.asleep = undefined;
    revokeAppToken(this.app.db, live?.tokenId);
    if (live) await live.handle.stop();
  }
}

const key = (appId: string, env: EnvName): string => `${appId}/${env}`;

/** The `host:port` destinations a site admin granted this repository's cells. */
export function grantedFor(db: Database, repoId: string): string[] {
  return listEgressGrants(db, repoId).map((g) => g.destination);
}
