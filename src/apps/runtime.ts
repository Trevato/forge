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

import { sshCommand } from "../ssh/command.ts";
import { appHostSuffix } from "./host.ts";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app.ts";
import { getAppByRepo, listApps, type AppRecord } from "../core/apps.ts";
import { resolveAppEnv } from "../core/app_env.ts";
import type { ForgeEvent } from "../core/events.ts";
import { announceRun } from "../actions/runs.ts";
import { getPull, listPulls, type Pull } from "../core/pulls.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import {
  cancelRun,
  claimRun,
  createRun,
  failOrphanedRuns,
  finishRun,
  type Run,
} from "../core/runs.ts";
import { Gate } from "../git/env.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { createLog } from "../kernel/log.ts";
import { appendRunLog } from "../runs/log.ts";
import { exportTree, readFileAt } from "./checkout.ts";
import {
  appsRoot,
  ensureEnvData,
  envDataDir,
  envDir,
  envPull,
  isEnvName,
  previewEnv,
  removeApp,
  removeEnv,
  type EnvName,
} from "./data.ts";
import { parseManifest, type AppManifest } from "./manifest.ts";
import { startProcess, type ProcessHandle } from "./process.ts";

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
}

export type EnvState = "stopped" | "deploying" | "running" | "failed";

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
  readonly error?: string | undefined;
}

interface Live {
  readonly commitOid: string;
  readonly handle: ProcessHandle;
  readonly dir: string;
  readonly runId: string;
  readonly since: string;
  /** How this checkout runs — its `tty` is what an ssh session opens. */
  readonly manifest: AppManifest;
}

/** A running environment, as a terminal session needs it. */
export interface LiveEnv {
  readonly env: EnvName;
  readonly dir: string;
  readonly dataDir: string;
  readonly port: number;
  readonly commitOid: string;
  readonly url: string;
  readonly tty: string | null;
}

interface Environment {
  readonly app: AppRecord;
  readonly env: EnvName;
  live?: Live | undefined;
  /** The deploy in flight, if one is. */
  deploying?: { run: Run; abort: AbortController } | undefined;
  /** The next deploy, waiting its turn; replaced by a newer request. */
  queued?: Run | undefined;
  chain: Promise<void>;
  lastError?: string | undefined;
  lastRunId?: string | undefined;
  /** Crash restarts in the current window, for backing off. */
  restarts: number[];
}

const RESTART_WINDOW_MS = 10 * 60_000;
const RESTART_MAX = 3;
const RESTART_BACKOFF_MS = [2_000, 10_000, 30_000];

const runtimes = new WeakMap<App, AppsRuntime>();

/** The runtime serving this forge, if apps are on. */
export const appsRuntime = (app: App): AppsRuntime | undefined =>
  runtimes.get(app);

export class AppsRuntime {
  private readonly envs = new Map<string, Environment>();
  private readonly gate: Gate;
  private unsubscribe: (() => void) | undefined;
  private stopped = false;

  constructor(
    readonly app: App,
    readonly options: RuntimeOptions,
  ) {
    this.gate = new Gate(options.concurrency ?? 2);
    runtimes.set(app, this);
  }

  // ---- addressing ----

  hostFor(slug: string, env: EnvName): string {
    const label = env === "production" ? slug : `${slug}--${env.slice(5)}`;
    return `${label}${appHostSuffix(this.options.domain)}`;
  }

  /**
   * The exact command that opens an environment's terminal — the app is the
   * login, the forge is the host — or undefined when SSH is off.
   */
  sshFor(record: AppRecord, env: EnvName): string | undefined {
    const login =
      env === "production" ? record.slug : `${record.slug}--${env.slice(5)}`;
    return sshCommand(this.app, login);
  }

  urlFor(record: AppRecord, env: EnvName): string {
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

  /** Every environment of an app, production first. */
  status(record: AppRecord): EnvStatus[] {
    const out: EnvStatus[] = [];
    for (const state of this.envs.values()) {
      if (state.app.id === record.id) out.push(this.describe(state));
    }
    // Production first, then previews by pull number — a number, not a
    // string, so `pull-10` follows `pull-9`.
    return out.sort((a, b) =>
      a.env === "production"
        ? -1
        : b.env === "production"
          ? 1
          : (envPull(a.env) ?? 0) - (envPull(b.env) ?? 0),
    );
  }

  private describe(state: Environment): EnvStatus {
    const url = this.urlFor(state.app, state.env);
    if (state.deploying !== undefined) {
      return {
        env: state.env,
        state: "deploying",
        commitOid: state.deploying.run.commitOid,
        url,
        ...(state.live === undefined ? {} : { port: state.live.handle.port }),
        runId: state.deploying.run.id,
        ...(state.live === undefined ? {} : { since: state.live.since }),
      };
    }
    if (state.live !== undefined) {
      return {
        env: state.env,
        state: "running",
        commitOid: state.live.commitOid,
        url,
        port: state.live.handle.port,
        runId: state.live.runId,
        since: state.live.since,
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

  /** Rebuild every environment from git and the open pulls, then listen. */
  async start(): Promise<void> {
    const orphaned = failOrphanedRuns(this.app.db);
    if (orphaned > 0) log.info("failed orphaned runs", { count: orphaned });
    this.unsubscribe = this.app.bus.subscribe((event) => {
      // Never let an event handler's rejection reach the bus.
      this.onEvent(event).catch((error) =>
        log.error("apps event handler failed", {
          kind: event.kind,
          error: String(error),
        }),
      );
    });
    const known = new Set<string>();
    for (const record of listApps(this.app.db)) {
      known.add(record.id);
      const repo = getRepoById(this.app.db, record.repoId);
      if (!repo) continue;
      await this.reconcileApp(record, repo, "boot");
    }
    this.pruneDirs(known);
  }

  /** Stop every process. The rows stay; a restart brings them back. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    const stops: Promise<void>[] = [];
    for (const state of this.envs.values()) {
      state.deploying?.abort.abort();
      if (state.queued)
        cancelRun(this.app.db, state.queued.id, "the forge stopped");
      if (state.live) stops.push(state.live.handle.stop());
      // Abort only cancels the step in flight; the `execute()` continuation
      // chained onto `state.chain` still runs afterwards to record the
      // outcome (`finishRun`, `announceRun`). Wait for it too, or it can
      // touch `this.app.db` after a caller who awaited `stop()` closes it.
      stops.push(state.chain.catch(() => {}));
    }
    await Promise.all(stops);
    runtimes.delete(this.app);
  }

  /**
   * Make the environments match the repository: production at the default
   * branch, a preview per open pull, and nothing for pulls that closed
   * while the forge was away.
   */
  async reconcileApp(
    record: AppRecord,
    repo: Repo,
    reason: string,
  ): Promise<void> {
    const dir = repoDir(this.app.reposRoot, repo.ownerName, repo.name);
    const tip = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
    if (tip !== undefined)
      this.requestDeploy(record, repo, "production", tip, reason);
    const open = new Set<EnvName>(["production"]);
    for (const pull of listPulls(this.app.db, repo.id, {
      state: "open",
      limit: 200,
    })) {
      const env = previewEnv(pull.number);
      open.add(env);
      const head = await this.pullHead(dir, pull);
      if (head !== undefined)
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

  private async pullHead(dir: string, pull: Pull): Promise<string | undefined> {
    const ref = pull.crossRepo
      ? `refs/pull/${pull.number}/head`
      : `refs/heads/${pull.headBranch}`;
    return (await resolveOid(dir, ref)) ?? (pull.headOid || undefined);
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
          for (const pull of listPulls(this.app.db, repo.id, {
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
      case "pull.opened":
      case "pull.reopened": {
        const pull = this.pullFromEvent(repo, event);
        if (!pull) return;
        const head = await this.pullHead(dir, pull);
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
    if (this.stopped) return undefined;
    const state = this.envFor(record, env);
    if (
      state.live?.commitOid === commitOid &&
      state.deploying === undefined &&
      state.queued === undefined &&
      reason !== "restart" &&
      reason !== "redeploy"
    ) {
      return undefined;
    }
    if (state.deploying?.run.commitOid === commitOid && reason !== "redeploy") {
      return state.deploying.run;
    }
    const issue =
      env === "production" ? undefined : this.pullIssueId(repo, env);
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
    state.chain = state.chain.then(async () => {
      if (state.queued?.id !== run.id) return; // superseded
      state.queued = undefined;
      await this.execute(state, repo, run);
    });
    return run;
  }

  private pullIssueId(repo: Repo, env: EnvName): string | undefined {
    const pull = getPull(this.app.db, repo.id, Number(env.slice(5)));
    return pull?.id;
  }

  private envFor(record: AppRecord, env: EnvName): Environment {
    const k = key(record.id, env);
    let state = this.envs.get(k);
    if (state === undefined) {
      state = { app: record, env, chain: Promise.resolve(), restarts: [] };
      this.envs.set(k, state);
    }
    return state;
  }

  private async execute(
    state: Environment,
    repo: Repo,
    run: Run,
  ): Promise<void> {
    const claimed = claimRun(this.app.db, run.id);
    if (!claimed) return; // cancelled meanwhile
    const abort = new AbortController();
    state.deploying = { run: claimed, abort };
    state.lastRunId = run.id;
    const write = (line: string): void =>
      appendRunLog(this.app.config.dataDir, run.id, line);
    announceRun(this.app, claimed);
    write(
      `deploy ${state.env} of ${repo.ownerName}/${repo.name} at ${run.commitOid.slice(0, 7)} (${run.reason})`,
    );

    const outcome = await this.gate.run(() =>
      this.bringUp(state, repo, run, write, abort.signal),
    );

    state.deploying = undefined;
    if (outcome.ok) {
      const previous = state.live;
      state.live = outcome.value;
      state.lastError = undefined;
      if (previous !== undefined) {
        write(
          `stopping the previous deployment (${previous.commitOid.slice(0, 7)})`,
        );
        await previous.handle.stop();
        if (previous.dir !== outcome.value.dir)
          rmSync(previous.dir, { recursive: true, force: true });
      }
      this.watch(state, repo, outcome.value);
      const url = this.urlFor(state.app, state.env);
      const done = finishRun(this.app.db, run.id, {
        state: "ok",
        summary: `running at ${url}`,
      });
      write(`done: ${url}`);
      if (done) announceRun(this.app, done);
    } else {
      state.lastError = outcome.error;
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
    }
  }

  private async bringUp(
    state: Environment,
    repo: Repo,
    run: Run,
    write: (line: string) => void,
    signal: AbortSignal,
  ): Promise<{ ok: true; value: Live } | { ok: false; error: string }> {
    const bare = repoDir(this.app.reposRoot, repo.ownerName, repo.name);
    const [forgeJson, packageJson] = await Promise.all([
      readFileAt(bare, run.commitOid, "forge.json"),
      readFileAt(bare, run.commitOid, "package.json"),
    ]);
    const manifest = parseManifest(forgeJson, packageJson);
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
    write(`checking out ${run.commitOid.slice(0, 7)}`);
    const exported = await exportTree(bare, run.commitOid, dir);
    if (!exported.ok) return { ok: false, error: exported.error };

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

    const started = await startProcess({
      dir,
      dataDir,
      manifest: manifest.value,
      env: state.env,
      url: this.urlFor(state.app, state.env),
      commitOid: run.commitOid,
      forgeUrl: this.options.forgeUrl,
      ssh: this.sshFor(state.app, state.env),
      // Read at start, never cached: a change is a redeploy, and the
      // process that comes up is the one that sees it.
      vars: resolveAppEnv(
        this.app.db,
        this.app.config.dataDir,
        state.app.id,
      ),
      log: write,
      signal,
    });
    if (!started.ok) {
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
        handle: started.value,
        dir,
        runId: run.id,
        since: new Date().toISOString(),
        manifest: manifest.value,
      },
    };
  }

  /** The running environment a terminal session would attach to, if any. */
  liveFor(record: AppRecord, env: EnvName): LiveEnv | undefined {
    const state = this.envs.get(key(record.id, env));
    const live = state?.live;
    if (state === undefined || live === undefined) return undefined;
    return {
      env,
      dir: live.dir,
      dataDir: envDataDir(this.app.config.dataDir, record.id, env),
      port: live.handle.port,
      commitOid: live.commitOid,
      url: this.urlFor(record, env),
      tty: live.manifest.tty,
    };
  }

  /** When a live process ends on its own, say so and bring it back — bounded. */
  private watch(state: Environment, repo: Repo, live: Live): void {
    live.handle.exited
      .then((code) => {
        if (this.stopped || state.live !== live) return; // replaced or stopped on purpose
        state.live = undefined;
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
              "restart",
            );
        }, delay);
      })
      .catch(() => {});
  }

  // ---- tearing down ----

  /** Stop an environment and remove everything it owned, data included. */
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

  /** Stop an environment's process without removing its data. */
  async stopEnv(record: AppRecord, env: EnvName): Promise<void> {
    const state = this.envs.get(key(record.id, env));
    if (state === undefined) return;
    if (state.queued) cancelRun(this.app.db, state.queued.id, "stopped");
    state.deploying?.abort.abort();
    await state.chain.catch(() => {});
    const live = state.live;
    state.live = undefined;
    if (live) await live.handle.stop();
  }
}

const key = (appId: string, env: EnvName): string => `${appId}/${env}`;
