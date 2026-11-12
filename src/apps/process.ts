/**
 * One deployment's process: install, then start the app and run its tests
 * side by side, and wait until the app answers. Everything the app is
 * handed is listed here and nothing else reaches it — the forge's own
 * environment carries secrets, and a child inherits exactly what `childEnv`
 * names (rule 8 in docs/APPS.md).
 *
 * Commands run through `sh -c` with an `exec` in front, so the shell
 * replaces itself with the app and a signal to the pid is a signal to the
 * app, not to a shell that would swallow it.
 */

import type { AppManifest } from "./manifest.ts";
import type { EnvName } from "./data.ts";
import { envPull } from "./data.ts";
import { forgeApiUrl } from "./token.ts";
import { backgroundArgv } from "./background.ts";
import { isReservedAppEnvName } from "../core/app_env.ts";
import { isFeatureVarName } from "./feature_env.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { endedLine, liveTree } from "../runs/ended.ts";
import { CANCEL_GRACE_MS, graceKillLine } from "../runs/grace.ts";
import { spellings, stripForgeDirs } from "../runs/paths.ts";
import { seconds } from "./timing.ts";
import { toolchainUse, type ToolchainUse } from "./toolchain.ts";
import { notFoundHint, shellCommand } from "./run_command.ts";
import { floorRefusal } from "../spawn/disk_floor.ts";
import { usedRefusal } from "./disk_guard.ts";
import { cellInstall, meteredInstall, prefillInstallCache, withLock } from "../checks/install.ts";
import {
  commandPid,
  killTree,
  openCell,
  resolveLimits,
  breachLine,
  timeLine,
  type Limits,
  signalTree,
  STEP_HOSTS,
  type Cell,
  type CellSpec,
} from "./contain.ts";

export interface ProcessHandle {
  readonly pid: number;
  readonly port: number;
  /** Resolves with the exit code once the process has ended. */
  readonly exited: Promise<number>;
  /** SIGTERM, a grace period, then SIGKILL. Resolves once it is gone. */
  stop(): Promise<void>;
  /** The cell limit it broke, once it has ended over one (`Cell.breach`). */
  breach?: () => string | undefined;
}

export interface StartInput {
  readonly dir: string;
  readonly dataDir: string;
  readonly manifest: AppManifest;
  readonly env: EnvName;
  readonly url: string;
  readonly commitOid: string;
  readonly forgeUrl: string;
  /** The key the app verifies `x-forge-identity` with (`apps/proxy.ts`). */
  readonly identityKey: string;
  /** The `ssh …` that opens this environment's terminal, when SSH is on. */
  readonly ssh?: string | undefined;
  /** The operator's variables for this app (`core/app_env.ts`). */
  readonly vars?: Record<string, string> | undefined;
  /** An absorbed app's `FORGE_FEATURE` and `FORGE_SETTING_*` (`apps/feature_env.ts`). */
  readonly feature?: Record<string, string> | undefined;
  /** The process's read-only credential into the forge (`apps/token.ts`). */
  readonly forgeToken?: string | undefined;
  readonly log: (line: string) => void;
  /** Aborting cancels whatever step is in flight and fails the start. */
  readonly signal: AbortSignal;
  /**
   * Where this environment's processes are held (`apps/contain.ts`):
   * what to hide and where its home is. Unset where the host cannot hold a
   * cell, and the processes run as plain children.
   */
  readonly cell?: CellBase | undefined;
  /**
   * The checkout was installed and tested when it was first built; a warm
   * start — the forge coming back, or an environment waking — only runs it.
   */
  readonly warm?: boolean | undefined;
  /** Chooses the app's port; tests hold one open to prove the retry. */
  readonly pickPort?: (() => number) | undefined;
  /**
   * The repository's shared bun cache (`checks/install.ts`
   * `checkInstallCache`), the one its checks fill (#7544). The forge fills
   * it on the host from the checkout's lockfile, then the install reads it:
   * read-only inside a cell, under its lock without one. A checkout the
   * fill will not trust (no `bun.lock`) installs as before, into its home.
   */
  readonly installCache?: string | undefined;
}

/** What a caller knows about a cell; the rest comes from the manifest. */
export interface CellBase {
  /** The forge's data directory and home: empty inside. */
  readonly hide: readonly string[];
  /** The environment's own home: writable, kept across deploys. */
  readonly home: string;
  /** Told of an undeclared host reached while egress is only reported. */
  readonly onUndeclared?: ((host: string, port: number) => void) | undefined;
  /** Entries an owner allowed since the cell started, and told of each refusal (`apps/egress_refused.ts`). */
  readonly allowed?: (() => readonly string[]) | undefined;
  readonly onRefused?: ((host: string, port: number, isPrivate: boolean) => void) | undefined;
  /** Private `host:port` destinations a site admin granted this repository. */
  readonly granted?: readonly string[] | undefined;
  /** The egress mode, as the forge's setting says at this start. */
  readonly egressMode?: "enforce" | "report" | undefined;
  /** Whose cell, for the machine sampler: `app:<slug>/<env>`. */
  readonly label?: string | undefined;
  /** Whose repository the cell runs, for the npm registry tally (`apps/egress.ts`). */
  readonly repoId?: string | undefined;
}

export type StartStage = "install" | "test" | "start" | "ready";

export interface StartError {
  readonly stage: StartStage;
  readonly message: string;
}

export interface StartedProcess {
  readonly handle: ProcessHandle;
  /**
   * The `test` step's outcome. Already running by the time this resolves —
   * it started alongside `start`, not before it — so a caller that wants a
   * fast preview can swap the handle in now and await this afterwards.
   * `ok()` immediately when the manifest has no `test`.
   */
  readonly tested: Promise<Result<void, string>>;
}

const STEP_TIMEOUT_MS = 10 * 60_000;
const STOP_GRACE_MS = 5_000;
const HEALTH_INTERVAL_MS = 250;

/**
 * The way out of the cell this forge runs in (`apps/contain.ts` sets them).
 * A child forge's cell has no route but its proxy, so a process the child
 * starts without them (its crew's Claude Code) reaches nothing: every model
 * call ended ENETUNREACH. Where the forge runs in no cell they are unset.
 */
export const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"] as const;

/**
 * The environment every child starts from. Explicit, and short: the path,
 * the home, who the operator is (the macOS keychain answers to `USER`, and
 * Claude Code's own login lives there), a locale, a temp dir, and the
 * proxy that is the only way out of the forge's own cell.
 */
export function childEnv(
  extra: Record<string, string>,
): Record<string, string> {
  const base: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "/",
    LANG: process.env["LANG"] ?? "C.UTF-8",
  };
  for (const name of ["USER", "LOGNAME", "TMPDIR", ...PROXY_VARS]) {
    const value = process.env[name];
    if (value !== undefined) base[name] = value;
  }
  return { ...base, ...extra };
}

/** What an app is told about where it runs. */
export function appEnv(input: {
  port: number;
  dataDir: string;
  env: EnvName;
  url: string;
  commitOid: string;
  forgeUrl: string;
  /** The key the app verifies `x-forge-identity` with. */
  identityKey: string;
  /** The exact `ssh …` that opens this environment's terminal, if any. */
  ssh?: string | undefined;
  /** The operator's variables: an admin password, an API key. */
  vars?: Record<string, string> | undefined;
  /** An absorbed app's settings, as the forge keeps them (`apps/feature_env.ts`). */
  feature?: Record<string, string> | undefined;
  /** A read-only forge token for this process (`apps/token.ts`). */
  forgeToken?: string | undefined;
  /** A pinned toolchain's PATH and homes (`apps/toolchain.ts`). */
  toolchain?: Record<string, string> | undefined;
}): Record<string, string> {
  const pull = envPull(input.env);
  // The operator's variables go underneath everything the forge names, so
  // a stored `PORT` or `FORGE_APP_DATA` can never redirect the app. The
  // write path refuses those names; this is the same rule kept where it
  // matters, in case that path is ever bypassed.
  const env = {
    ...operatorVars(input.vars),
    ...featureVars(input.feature),
    ...childEnv({
      ...input.toolchain,
      PORT: String(input.port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      FORGE_APP_ENV: input.env === "production" ? "production" : "preview",
      FORGE_APP_DATA: input.dataDir,
      FORGE_APP_URL: input.url,
      FORGE_APP_COMMIT: input.commitOid,
      FORGE_URL: input.forgeUrl,
      FORGE_API_URL: forgeApiUrl(input.forgeUrl),
      FORGE_APP_IDENTITY_KEY: input.identityKey,
      // Read-only, the owner's, gone when this process is: what a page
      // inside the app reads the forge with. Never sent to a browser.
      ...(input.forgeToken === undefined
        ? {}
        : { FORGE_TOKEN: input.forgeToken }),
      ...(pull === undefined ? {} : { FORGE_APP_PULL: String(pull) }),
      // Printed verbatim by an app that tells people how to reach its
      // terminal; a guessed form (`you@app.host`) reaches the forge instead.
      ...(input.ssh === undefined ? {} : { FORGE_APP_SSH: input.ssh }),
    }),
  };
  // The operator's login name is for the keychain (an agent's Claude Code
  // needs it); an app has no business knowing it, and a guest in a chat
  // should not be greeted by it.
  delete env["USER"];
  delete env["LOGNAME"];
  return env;
}

/** An absorbed app's settings: only the names a feature owns, never one the forge sets itself. */
function featureVars(vars: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars ?? {})) if (isFeatureVarName(name)) out[name] = value;
  return out;
}

/** The operator's variables minus any name the forge owns. */
function operatorVars(
  vars: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars ?? {})) {
    if (!isReservedAppEnvName(name)) out[name] = value;
  }
  return out;
}

/** A stack frame in any of the languages a step's runtime might throw from. */
const STACK_FRAME_RE = /^at\s/;
/** A runtime's version banner, printed after an uncaught error — `Bun v1.3.14 (Linux x64 baseline)`. */
const VERSION_BANNER_RE = /^\S+ v[\d.]+ *\(/;
/**
 * A line that reads as an error rather than context around one — anchored
 * at the start, so a source line merely mentioning `Error` (`throw new
 * Error(...)`, echoed above the frames) is not mistaken for the message.
 */
const ERROR_LINE_RE = /^[A-Za-z]*Error\b/i;
const TAIL_LINES = 20;
/** A shell's code for a child a signal ended: 128 + the signal's number. */
const SIGNAL_CODES: Readonly<Record<number, NodeJS.Signals>> = {
  129: "SIGHUP",
  130: "SIGINT",
  137: "SIGKILL",
  143: "SIGTERM",
};
/** What `runStep` says of a step a signal no one here sent ended (#6722). */
const KILLED = / was killed by SIG[A-Z]+$/;

/**
 * Whether a step's error is a signal from outside ending it — the pod
 * going, the kernel's OOM killer — not the step's own exit (#6722).
 */
export function killedStep(error: string): boolean {
  return KILLED.test(error);
}
const REASON_MAX = 300;

/**
 * The reason a person would read out of a step's failed output: the first
 * line that isn't a blank, a stack frame, or a version banner, and reads as
 * an error — the message, printed before the frames that bury it. Falls
 * back to the tail when nothing qualifies, since some failures (a plain
 * `exit 1`) never print one.
 */
export function failureReason(recent: readonly string[]): string {
  for (const raw of recent) {
    const line = raw.trim();
    if (
      line === "" ||
      STACK_FRAME_RE.test(line) ||
      VERSION_BANNER_RE.test(line)
    )
      continue;
    if (ERROR_LINE_RE.test(line)) return truncate(line);
  }
  return truncate(recent.slice(-3).join(" | "));
}

function truncate(line: string): string {
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX)}…` : line;
}

/**
 * Signal a process group: a negative pid is the leader and everything it
 * started that has not left the group. Nothing left of it is not an error.
 */
export function signalGroup(leader: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-leader, signal);
  } catch {
    // the group is already gone
  }
}

/**
 * Run a step to completion, streaming its output. A non-zero exit, a
 * timeout, or an abort is an Err with the reason a person would want.
 */
export async function runStep(
  name: string,
  command: string,
  options: {
    cwd: string;
    env: Record<string, string>;
    log: (line: string) => void;
    signal: AbortSignal;
    timeoutMs?: number;
    /** Run inside a cell (`apps/contain.ts`) instead of as a plain child. */
    cell?: CellSpec | undefined;
    /**
     * Set for a build step (install, test): its limits. The time is the
     * step's bound, and a stop by any limit is one line saying which.
     */
    build?: Limits | undefined;
  },
): Promise<Result<void, string>> {
  // Below the parent's disk floor no step's cell starts: it would write into the last room (#10873).
  if (options.cell !== undefined) {
    const floor = floorRefusal(options.cwd);
    if (floor !== undefined) {
      options.log(`${name} not started: ${floor}`);
      return err(floor);
    }
    // At 80% used none starts either (#11799): the check is queued again, not failed.
    const used = usedRefusal(options.cwd);
    if (used !== undefined) {
      options.log(`${name} ${used}`);
      return err(`${name} ${used}`);
    }
  }
  options.log(`$ ${command}`);
  // A step is background work: the forge's own pages outrank it (#3319).
  const cell: Cell | undefined =
    options.cell === undefined
      ? undefined
      : openCell({ ...options.cell, background: true }, options.log);
  const proc = Bun.spawn(backgroundArgv(cell?.argv(command) ?? ["/bin/sh", "-c", command]), {
    cwd: options.cwd,
    env: cell?.env(options.env) ?? options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Without a cell, the step leads a process group of its own, so a
    // cancel reaches what its shell started (an install script, a test
    // worker), not just the shell. A cell's tree dies with bubblewrap.
    detached: cell === undefined,
  });
  const kill = (): void => {
    if (cell === undefined) signalGroup(proc.pid, "SIGKILL");
    else proc.kill("SIGKILL");
  };
  // Once the shell has gone, so has the rest of its group: nothing a step
  // started runs on in the checkout after the step has ended.
  void proc.exited.then(() => {
    if (cell === undefined) signalGroup(proc.pid, "SIGKILL");
  });
  const recent: string[] = [];
  const dirs = spellings([options.cwd]);
  const scrub = (raw: string): void => {
    const line = stripForgeDirs(dirs, raw);
    recent.push(line);
    if (recent.length > TAIL_LINES) recent.shift();
    options.log(line);
  };
  const timeoutMs = options.timeoutMs ?? options.build?.timeMs ?? STEP_TIMEOUT_MS;
  let why: string | undefined;
  // A killed process's pipes are not guaranteed to close on their own
  // (see `pump`); this stops the reads directly the same moment the kill
  // is sent, so a step in flight never outlives its own cancellation.
  const stopReading = new AbortController();
  const timer = setTimeout(() => {
    why =
      options.build === undefined
        ? `${name} took longer than ${Math.round(timeoutMs / 1000)}s`
        : timeLine({ ...options.build, timeMs: timeoutMs });
    if (options.build !== undefined) options.log(why);
    kill();
    stopReading.abort();
  }, timeoutMs);
  // A cancel asks first: SIGTERM to the group (or to the tree inside a
  // cell), then SIGKILL once the grace has run out, if the leader is still
  // up. While the grace lasts, the pipes stay open, so the step's last
  // words reach the log.
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    why = `${name} cancelled`;
    options.log(endedLine(liveTree(proc.pid).length));
    if (cell === undefined) signalGroup(proc.pid, "SIGTERM");
    else signalTree(proc.pid, "SIGTERM");
    graceTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        options.log(graceKillLine());
        if (cell === undefined) signalGroup(proc.pid, "SIGKILL");
        else killTree(proc.pid);
      }
      stopReading.abort();
    }, CANCEL_GRACE_MS);
  };
  if (options.signal.aborted) onAbort();
  else options.signal.addEventListener("abort", onAbort, { once: true });
  cell?.watch(proc.pid, (breach) => {
    why = (options.build && breachLine(breach, options.build)) || `${name} stopped: it ${breach}`;
    killTree(proc.pid);
    stopReading.abort();
  });
  try {
    const [, , code] = await Promise.all([
      pump(proc.stdout, scrub, stopReading.signal),
      pump(proc.stderr, scrub, stopReading.signal),
      proc.exited,
    ]);
    if (why !== undefined) return err(why);
    // The kernel's OOM kill at the cell's cap is a breach no watch tick saw.
    const kernel = code === 0 ? undefined : cell?.breach();
    if (kernel !== undefined)
      return err((options.build && breachLine(kernel, options.build)) || `${name} stopped: it ${kernel}`);
    // Ended by a signal this run never sent: no verdict of the step's own.
    const killer = code === 0 ? undefined : (proc.signalCode ?? SIGNAL_CODES[code]);
    if (killer !== undefined) return err(`${name} was killed by ${killer}`);
    if (code !== 0) {
      const reason = recent.length > 0 ? ` — ${failureReason(recent)}` : "";
      return err(`${name} exited with code ${code}${reason}`);
    }
    return ok();
  } finally {
    clearTimeout(timer);
    clearTimeout(graceTimer);
    options.signal.removeEventListener("abort", onAbort);
    cell?.close();
  }
}

/** What a build step of this deploy is held to: the defaults, with forge.json's `limits.time` able to lower the time. */
export function stepLimits(input: Pick<StartInput, "manifest">): Limits {
  // A build keeps the step's own memory and cores: `app.limits.memory` and
  // `app.limits.cpus` hold the running app, and a 128 MiB web app still
  // needs room for `bun install`. Only `app.limits.time` reaches a build,
  // and only to lower it.
  return resolveLimits("step", { timeMs: input.manifest.limits?.timeMs });
}

/** The cell a step of this deploy runs in: the checkout and the home, the registry and what the app declared. */
export function stepCell(input: StartInput, use?: ToolchainUse): CellSpec | undefined {
  const base = input.cell;
  if (base === undefined) return undefined;
  return {
    ...(use === undefined ? {} : { reveal: use.reveal }),
    dir: input.dir,
    writable: [],
    home: base.home,
    hide: base.hide,
    egress: [...STEP_HOSTS, ...(input.manifest.egress ?? [])],
    reach: [input.forgeUrl],
    limits: stepLimits(input),
    onUndeclared: base.onUndeclared,
    allowed: base.allowed,
    onRefused: base.onRefused,
    egressMode: base.egressMode,
    label: base.label,
  };
}

/** The forge's own `BUN_CONFIG_REGISTRY`, when its environment names one. */
function forgeRegistry(): Record<string, string> {
  const registry = process.env["BUN_CONFIG_REGISTRY"];
  return registry === undefined || registry === "" ? {} : { BUN_CONFIG_REGISTRY: registry };
}

/** How an install step runs: plain data, so its composition is testable without a cell. */
export interface InstallPlan {
  readonly command: string;
  readonly env: Record<string, string>;
  readonly cell: CellSpec | undefined;
  /** The lock it holds while it runs, if any. */
  readonly lock: string | undefined;
}

/**
 * The install once the fill has answered (#7544): from the repository's
 * shared cache when it `filled`, else into the environment's own home as
 * before. Inside a cell only the cache is added to its view, read-only;
 * uncontained, the install could write the cache, so it takes its turn
 * under the cache's lock.
 */
export function installPlan(
  command: string,
  input: StartInput,
  env: Record<string, string>,
  filled: boolean,
  use?: ToolchainUse,
): InstallPlan {
  const cache = input.installCache;
  const cell = stepCell(input, use);
  if (cache === undefined || !filled) return { command, env, cell, lock: undefined };
  if (cell !== undefined)
    return { ...cellInstall(command, env, cache), cell: { ...cell, reveal: [...(cell.reveal ?? []), cache] }, lock: undefined };
  return { command, env: { ...env, BUN_INSTALL_CACHE_DIR: cache }, cell: undefined, lock: `${cache}.lock` };
}

/**
 * The install step. The cache is an optimisation: a fill that fails (the
 * registry unreachable, the lock cancelled, a timeout) is logged and the
 * install runs into the environment's home, as it did before the cache.
 */
async function install(
  command: string,
  input: StartInput,
  env: Record<string, string>,
  use?: ToolchainUse,
): Promise<Result<void, string>> {
  let filled = false;
  if (input.installCache !== undefined) {
    const fill = await prefillInstallCache({
      cache: input.installCache,
      dir: input.dir,
      env,
      log: input.log,
      signal: input.signal,
      timeoutMs: STEP_TIMEOUT_MS,
    });
    if (fill.ok) filled = fill.value;
    else input.log(`cache not filled: ${fill.error}`);
  }
  const plan = installPlan(command, input, env, filled, use);
  const step = (): Promise<Result<void, string>> =>
    runStep("install", plan.command, { cwd: input.dir, env: plan.env, log: input.log, signal: input.signal, cell: plan.cell, build: stepLimits(input) });
  if (plan.lock !== undefined) {
    const held = await withLock(plan.lock, step, { signal: input.signal });
    return held.ok ? held.value : held;
  }
  // A contained install is metered by its cell's label (#8382): more than
  // a MiB from the registry is the shared cache missing, and says so, even
  // when the install failed or was aborted.
  return meteredInstall(plan.cell?.label, input.cell?.repoId, step, input.log);
}

/**
 * Install, then start the app and run its tests side by side, and wait for
 * the app to answer on its port. Returns as soon as it does — `tested`
 * keeps running and is the caller's to await — so a preview is never held
 * behind its own test suite. On failure the process (if it started) and the
 * test step (if one was running) are both already gone.
 */
export async function startProcess(
  input: StartInput,
): Promise<Result<StartedProcess, StartError>> {
  const { manifest, log } = input;
  // Below the parent's disk floor no app starts, contained or not (#10873).
  const floor = floorRefusal(input.dataDir);
  if (floor !== undefined) {
    log(`not started: ${floor}`);
    return err({ stage: "start", message: floor });
  }
  const scratch = input.cell?.home ?? input.dir;
  const used = toolchainUse(manifest.toolchain, scratch);
  if (!used.ok) return err({ stage: "install", message: used.error });
  const use = used.value;
  const stepEnv = childEnv({
    ...use?.env,
    CI: "1",
    FORGE_APP_ENV: input.env === "production" ? "production" : "preview",
    // A mirror the forge itself is pointed at is the one the fill and the
    // install fetch from (`checks/install.ts` DEFAULT_REGISTRY otherwise).
    ...forgeRegistry(),
  });

  if (manifest.install !== null && input.warm !== true) {
    const installed = await install(manifest.install, input, stepEnv, use);
    if (!installed.ok)
      return err({ stage: "install", message: installed.error });
  }
  if (input.signal.aborted)
    return err({ stage: "start", message: "cancelled" });

  // `test` starts here, alongside the app below, and is aborted on its own
  // signal — a start failure must not leave it running past its run, and
  // neither may the caller's abort after this function has already returned.
  const testAbort = new AbortController();
  if (input.signal.aborted) testAbort.abort();
  else
    input.signal.addEventListener("abort", () => testAbort.abort(), {
      once: true,
    });
  const tested: Promise<Result<void, string>> =
    manifest.test === null || input.warm === true
      ? Promise.resolve(ok())
      : runStep("test", manifest.test, {
          cwd: input.dir,
          env: stepEnv,
          log,
          signal: testAbort.signal,
          cell: stepCell(input, use),
          build: stepLimits(input),
        });

  // The port is chosen, then released, then bound by the app: another
  // process can take it in between. An app that dies on an address-in-use
  // error is started again on a fresh port (`startOnFreshPort`).
  const pick = input.pickPort ?? freePort;
  const launch = async (port: number): Promise<Launch> => {
    log(`$ ${manifest.run}  (PORT=${port})`);
    const spawnedAt = Date.now();
    let firstOutputAt: number | undefined;
    const cell: Cell | undefined =
      input.cell === undefined
        ? undefined
        : openCell(
            {
              dir: input.dir,
              writable: [input.dataDir],
              home: input.cell.home,
              hide: input.cell.hide,
              ...(use === undefined ? {} : { reveal: use.reveal }),
              egress: manifest.egress ?? [],
              granted: input.cell.granted,
              reach: [input.forgeUrl],
              limits: resolveLimits("app", manifest.limits),
              listen: port,
              onUndeclared: input.cell.onUndeclared,
              allowed: input.cell.allowed,
              onRefused: input.cell.onRefused,
              egressMode: input.cell.egressMode,
              label: input.cell.label,
            },
            log,
          );
    const command = shellCommand(manifest.run);
    const env = appEnv({
      toolchain: use?.env,
      port,
      dataDir: input.dataDir,
      env: input.env,
      url: input.url,
      commitOid: input.commitOid,
      forgeUrl: input.forgeUrl,
      identityKey: input.identityKey,
      ssh: input.ssh,
      vars: input.vars,
      feature: input.feature,
      forgeToken: input.forgeToken,
    });
    const proc = Bun.spawn(cell?.argv(command) ?? ["/bin/sh", "-c", command], {
      cwd: input.dir,
      env: cell?.env(env) ?? env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Without a cell, the app leads a process group of its own, so what it
      // starts can be signalled with it (`signalGroup`). A cell's tree is
      // bubblewrap's, walked by `signalTree` and `killTree`.
      detached: cell === undefined,
    });
    // The cell's sockets and watch end with the process, however it ends.
    // Without a cell, so does the rest of its group: a child that outlived
    // the app, stopped or crashed, is not left running on its data.
    // Read before the cell closes: its cgroup's OOM count goes with it.
    let breach: string | undefined;
    void proc.exited.then(() => {
      breach = cell?.breach();
      cell?.close();
      if (cell === undefined) signalGroup(proc.pid, "SIGKILL");
    });
    cell?.watch(proc.pid, () => killTree(proc.pid));
    // Output is pumped for the life of the process, not just the start.
    const recent: string[] = [];
    const dirs = spellings([input.dir, input.dataDir]);
    const remember = (raw: string): void => {
      firstOutputAt ??= Date.now();
      const line = stripForgeDirs(dirs, raw);
      recent.push(line);
      if (recent.length > 20) recent.shift();
      log(line);
    };
    const drained = Promise.all([pump(proc.stdout, remember), pump(proc.stderr, remember)]);

    let inner: number | undefined;
    const handle: ProcessHandle = {
      // In a cell, the app's own pid rather than bubblewrap's: what has
      // children when the app is busy (`apps/busy.ts`).
      get pid() {
        if (cell === undefined) return proc.pid;
        inner ??= commandPid(proc.pid);
        return inner ?? proc.pid;
      },
      port,
      exited: proc.exited,
      breach: () => breach,
      stop: async () => {
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        // In a cell the pid is bubblewrap's, which passes no signal on: the
        // app itself is asked, so it shuts down the way it would anywhere.
        if (cell === undefined) signalGroup(proc.pid, "SIGTERM");
        else signalTree(proc.pid, "SIGTERM");
        const gone = await Promise.race([
          proc.exited.then(() => true),
          Bun.sleep(STOP_GRACE_MS).then(() => false),
        ]);
        if (!gone) {
          if (cell === undefined) signalGroup(proc.pid, "SIGKILL");
          else killTree(proc.pid);
          await proc.exited;
        }
      },
    };

    const ready = await waitUntilReady({
      port,
      path: manifest.health,
      timeoutMs: manifest.ready * 1000,
      exited: proc.exited,
      signal: input.signal,
    });
    if (!ready.ok) {
      await handle.stop();
      // The exit can be seen before the pumps deliver its last lines, the
      // address-in-use one among them; a pipe a child holds open is not waited on.
      await Promise.race([drained, Bun.sleep(DRAIN_CAP_MS)]);
      const hint = notFoundHint(recent);
      const tail =
        (recent.length > 0 ? ` — ${failureReason(recent)}` : "") +
        (hint === undefined ? "" : ` (${hint})`);
      return {
        error: { stage: ready.error.stage, message: ready.error.message + tail },
        portTaken: ready.error.exited && recent.some((line) => ADDRESS_IN_USE_RE.test(line)),
      };
    }
    return { handle, spawnedAt, firstOutputAt };
  };
  const launched = await startOnFreshPort(launch, pick, input.signal, log);
  if ("error" in launched) {
    // The app never came up: the test step running beside it has nothing
    // left to verify, and must not outlive this failed run.
    testAbort.abort();
    await tested.catch(() => {});
    return err(launched.error);
  }
  const { handle, spawnedAt, firstOutputAt } = launched;
  log(`ready: ${input.url}`);
  // How the process's own share of the start divides: the time until it
  // first said anything (the runtime loading the app, the app's own boot
  // work) and the time until its health path answered.
  log(
    `timing: answered ${seconds(Date.now() - spawnedAt)} after the process was started${firstOutputAt === undefined ? "" : ` — its first output after ${seconds(firstOutputAt - spawnedAt)}`}`,
  );
  return ok({ handle, tested });
}

/**
 * Poll the health path until the app answers. Any HTTP answer below 500
 * counts — a 404 on `/` is an app that is up and has no root page — and an
 * exit, an abort, or the deadline is a failure with the reason.
 */
async function waitUntilReady(input: {
  port: number;
  path: string;
  timeoutMs: number;
  exited: Promise<number>;
  signal: AbortSignal;
}): Promise<Result<void, StartError & { readonly exited: boolean }>> {
  const deadline = Date.now() + input.timeoutMs;
  let exitCode: number | undefined;
  void input.exited.then((code) => {
    exitCode = code;
  });
  let lastStatus: number | undefined;
  while (Date.now() < deadline) {
    if (input.signal.aborted)
      return err({ stage: "start", message: "cancelled", exited: false });
    if (exitCode !== undefined)
      return err({
        stage: "start",
        message: `exited with code ${exitCode} before answering`,
        exited: true,
      });
    try {
      const response = await fetch(
        `http://127.0.0.1:${input.port}${input.path}`,
        {
          signal: AbortSignal.timeout(2_000),
          redirect: "manual",
        },
      );
      lastStatus = response.status;
      await response.body?.cancel();
      if (response.status < 500) return ok();
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(HEALTH_INTERVAL_MS);
  }
  return err({
    stage: "ready",
    exited: false,
    message:
      lastStatus === undefined
        ? `no answer on ${input.path} within ${Math.round(input.timeoutMs / 1000)}s`
        : `${input.path} answered ${lastStatus} for ${Math.round(input.timeoutMs / 1000)}s`,
  });
}

/** How many more times an app that lost its port is started on a fresh one. */
export const PORT_RETRIES = 2;
/** How long a failed start waits for the app's last output to arrive. */
const DRAIN_CAP_MS = 1_000;
const ADDRESS_IN_USE_RE = /address (?:already )?in use|EADDRINUSE|port \d+ in use/i;

/** One start of the app on one port: up, or the error and whether the port was lost. */
type Launch =
  | {
      readonly handle: ProcessHandle;
      readonly spawnedAt: number;
      readonly firstOutputAt: number | undefined;
    }
  | { readonly error: StartError; readonly portTaken: boolean };

/** Launch on a picked port; while the app lost it to another process, on a fresh one, up to PORT_RETRIES more times. */
async function startOnFreshPort(
  launch: (port: number) => Promise<Launch>,
  pick: () => number,
  signal: AbortSignal,
  log: (line: string) => void,
): Promise<Launch> {
  let launched = await launch(pick());
  for (let retry = 0; retry < PORT_RETRIES; retry++) {
    if (!("error" in launched) || !launched.portTaken || signal.aborted) break;
    log("the port was taken before the app bound it; starting again on another");
    launched = await launch(pick());
  }
  return launched;
}

/** A port the OS says is free right now. */
export function freePort(): number {
  const probe = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(""),
  });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
}

/**
 * Read a stream as lines, calling `onLine` for each; never throws. A killed
 * process's pipe does not always signal end-of-stream on its own — `signal`
 * cancels the read directly, or a caller racing a dead process would wait on
 * a stream that never closes.
 */
export async function pump(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  let carry = "";
  const reader = stream.getReader();
  const onAbort = (): void => void reader.cancel().catch(() => {});
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });
      let at = carry.indexOf("\n");
      while (at !== -1) {
        onLine(carry.slice(0, at).replace(/\r$/, ""));
        carry = carry.slice(at + 1);
        at = carry.indexOf("\n");
      }
    }
    carry += decoder.decode();
    if (carry !== "") onLine(carry);
  } catch {
    // The process went away mid-read; whatever arrived was delivered.
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
