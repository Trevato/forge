/**
 * A check's install step (#5093): the package manager's own flake is not the
 * pull's fault. Concurrent installs into one bun cache race on extracting the
 * same tarball (`Fail extracting tarball`), and a registry stream cut short
 * reads the same way, or as `EINTEGRITY` / `ECONNRESET`.
 *
 * - **No racing on a shared cache.** A check in a cell has a home of its own,
 *   so its cache is its own: nothing is shared, and a pull's install never
 *   fills a cache another check reads. A check that runs uncontained would
 *   otherwise share the forge's `~/.bun` with every check of every
 *   repository; it gets its repository's own cache instead
 *   (`<data>/check-install/<repo>/bun`), and installs into it one at a time,
 *   under a lock file beside it — across checks, gates and forges alike.
 * - **A transient failure is retried once**, after {@link INSTALL_RETRY_MS}.
 *   Failing the same way twice is {@link INFRASTRUCTURE}: the service queues
 *   the check again and the merge queue reads it as cut off, never as red.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { meterEgress } from "../apps/egress.ts";
import { formatBytes } from "../core/storage.ts";
import { noteInstall } from "../efficiency/installs.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { fillable } from "./fillable.ts";
import { lend } from "./install_evict.ts";

/** What an install prints when the machine, not the code, failed it. */
export const TRANSIENT_INSTALL = /Fail extracting tarball|EINTEGRITY|ECONNRESET/;

/** How long a transient install failure waits before its one retry. */
export const INSTALL_RETRY_MS = 2_000;

/** The error prefix of an install the machine failed twice: not the pull's red. */
export const INFRASTRUCTURE = "infrastructure";

/** A lock older than this is a holder that died: a whole install never takes so long. */
export const LOCK_STALE_MS = 15 * 60_000;

const LOCK_POLL_MS = 50;

/**
 * The one line an install step logs about the registry (#7546): `0 B` on a
 * warm cache. A cell's figure is what its egress proxy received from the
 * registry; uncontained, nothing is logged.
 */
export function installFetchedLine(bytes: number): string {
  return `install fetched ${formatBytes(Math.max(0, bytes))} from the registry`;
}

/** More than this from the npm registry in one install is the shared cache missing (#8382). */
export const NPM_MISS_BYTES = 1024 * 1024;

/**
 * The line a contained install's log ends with when its cell received more
 * than `NPM_MISS_BYTES` from the npm registry; none under it.
 */
export function npmMissLine(npmBytes: number): string | undefined {
  if (!(npmBytes > NPM_MISS_BYTES)) return undefined;
  const mib = npmBytes / NPM_MISS_BYTES;
  return `install fetched ${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MiB from the npm registry; the shared cache missed`;
}

/**
 * Run a contained install `step` with its cell's egress proxy metered by
 * `label`, the registry's bytes attributed to `repoId` (#8382). After the
 * step — in `finally`, so a failed, aborted or throwing install logs too —
 * `write` gets `installFetchedLine` when `fetched` asks for it (a check's
 * #7546 line), then `npmMissLine` when the registry sent more than a MiB.
 * With no `label` the install is uncontained: nothing is metered or logged.
 */
export async function meteredInstall<T>(
  label: string | undefined,
  repoId: string | undefined,
  step: () => Promise<T>,
  write: (line: string) => void,
  options: { readonly fetched?: boolean } = {},
): Promise<T> {
  if (label === undefined) return step();
  const meter = meterEgress(label, repoId);
  try {
    return await step();
  } finally {
    const fetched = meter.stop();
    if (options.fetched === true) write(installFetchedLine(fetched));
    const missed = npmMissLine(meter.npm());
    if (missed !== undefined) write(missed);
    noteInstall(missed !== undefined); // the hit-rate counter the efficiency watcher reads (#7558)
  }
}

export type InstallOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly infrastructure: boolean };

/** The first line of an install's output that says the failure was transient. */
export function transientLine(lines: readonly string[]): string | undefined {
  return lines.find((line) => TRANSIENT_INSTALL.test(line));
}

/** A repository's bun cache for its uncontained checks; the lock file sits beside it. */
export function checkInstallCache(dataDir: string, repoId: string): string {
  return join(dataDir, "check-install", repoId.replace(/[^A-Za-z0-9_-]/g, "_"), "bun");
}

/** The registry a fill fetches from unless the forge's own environment names another. */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

/**
 * A contained `bun install` links nothing from the read-only cache: hardlinks
 * cannot cross a bind onto another device, so it copies instead. Applied to
 * every contained install, on purpose: whether cache and cell share a device
 * is the host's layout, not something to probe per check, and copying a warm
 * cache costs milliseconds against a network install. Every `bun install` in
 * the command is asked, so `cd x && bun install` copies too.
 */
export function copying(command: string): string {
  return command.replace(/\bbun install\b(?![^&;|]*--backend)/g, "bun install --backend=copyfile");
}

/** What a contained install runs: the command, and the cache env it reads. */
export function cellInstall(
  command: string,
  env: Record<string, string>,
  warm: string | undefined,
): { readonly command: string; readonly env: Record<string, string> } {
  return warm === undefined
    ? { command, env }
    : { command: copying(command), env: { ...env, BUN_INSTALL_CACHE_DIR: warm } };
}

/**
 * How long a fill may run: never past half the lock's staleness, or another
 * process would take the lock mid-fill and two fills would write the cache.
 */
export function fillTimeoutMs(requested: number | undefined): number {
  return Math.min(requested ?? Number.POSITIVE_INFINITY, LOCK_STALE_MS / 2);
}

/**
 * Why a lockfile may not fill the shared cache, or undefined when it may: the
 * fill runs outside a cell, so it fetches only from the pinned registry. A
 * binary lockfile cannot be read, and a URL elsewhere or a git dependency
 * would make the forge fetch from a host the pull chose.
 */
export function lockfileRefusal(dir: string, registry: string): string | undefined {
  if (existsSync(join(dir, "bun.lockb")) && !existsSync(join(dir, "bun.lock")))
    return "only a binary bun.lockb, which cannot be checked against the registry";
  if (!existsSync(join(dir, "bun.lock"))) return "no bun lockfile in the checkout";
  const text = readFileSync(join(dir, "bun.lock"), "utf8");
  for (const url of text.match(/[a-z+]+:\/\/[^"\s]+/gi) ?? [])
    if (!url.startsWith(registry)) return `the lockfile names ${url.slice(0, 80)}, not the registry`;
  if (/[@"'/](?:github|gitlab|bitbucket|git|ssh|git\+\w+):/i.test(text))
    return "the lockfile has a git dependency";
  // Every package by name and version with a sha512 integrity, or no fill:
  // a file, link or workspace dependency, or a patch, is read on the host.
  const manifest = existsSync(join(dir, "package.json")) ? readFileSync(join(dir, "package.json"), "utf8") : "{}";
  const strict = fillable(manifest, text, registry);
  return strict.ok ? undefined : strict.error;
}

/**
 * Fill the shared cache on the host before a contained install (#7543): the
 * cell binds the cache read-only, so only the forge writes it. Installs the
 * commit's lockfile into a scratch copy of the checkout (no `node_modules`,
 * no `.git`, and no `bunfig.toml` or `.npmrc`: the pull does not choose the
 * registry) with `--frozen-lockfile --ignore-scripts`, so no lifecycle script
 * runs outside a cell and the only host fetched is the pinned registry
 * (`BUN_CONFIG_REGISTRY` of `env`, else {@link DEFAULT_REGISTRY}). Holds the
 * same lock uncontained installs hold. A package the forge cannot fetch fails
 * here, with the install's own output, and releases the lock.
 *
 * The cell reads the cache without the lock while a later fill may write
 * it. That is safe because bun writes each package to a temp name in the
 * cache and renames it into place, so a reader sees a whole entry or none,
 * and a package the lockfile names was filled before this cell started.
 *
 * Answers whether it filled. False (a lockfile it will not trust, or none) is
 * not a failure: the cell then installs into a cache of its own.
 */
export async function prefillInstallCache(options: {
  readonly cache: string;
  readonly dir: string;
  readonly env: Record<string, string>;
  readonly log: (line: string) => void;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number | undefined;
}): Promise<Result<boolean, string>> {
  const { cache, dir, log, signal } = options;
  const registry = (options.env["BUN_CONFIG_REGISTRY"] ?? DEFAULT_REGISTRY).replace(/\/?$/, "/");
  const refusal = lockfileRefusal(dir, registry);
  if (refusal !== undefined) {
    log(`cache not filled: ${refusal}`);
    return ok(false);
  }
  mkdirSync(cache, { recursive: true });
  const held = await withLock(
    `${cache}.lock`,
    async (): Promise<Result<boolean, string>> => {
      const scratch = mkdtempSync(join(tmpdir(), "prefill-"));
      try {
        cpSync(dir, scratch, {
          recursive: true,
          filter: (path) => !/(^|\/)(node_modules|\.git|bunfig\.toml|\.npmrc)$/.test(path),
        });
        const proc = Bun.spawn(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], {
          cwd: scratch,
          env: { ...options.env, BUN_CONFIG_REGISTRY: registry, BUN_INSTALL_CACHE_DIR: cache },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const stop = (): void => proc.kill();
        signal.addEventListener("abort", stop, { once: true });
        const timer = setTimeout(stop, fillTimeoutMs(options.timeoutMs));
        const lines = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
          const text = await new Response(stream).text();
          for (const line of text.split("\n")) if (line.trim() !== "") log(line);
        };
        try {
          await Promise.all([lines(proc.stdout), lines(proc.stderr)]);
          const code = await proc.exited;
          if (code !== 0) return err(`filling the install cache exited ${code}`);
          lend(cache, dir);
          return ok(true);
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", stop);
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    { signal },
  );
  return held.ok ? held.value : held;
}

/**
 * Run `attempt` (one install, its output lines handed to `log`), and once
 * more after `retryMs` when it failed with a {@link TRANSIENT_INSTALL} line.
 * A failure without one is the code's, answered at once.
 */
export async function installWithRetry(
  attempt: (log: (line: string) => void) => Promise<Result<void, string>>,
  options: {
    readonly log: (line: string) => void;
    readonly signal: AbortSignal;
    readonly retryMs?: number | undefined;
  },
): Promise<InstallOutcome> {
  let transient: string | undefined;
  for (let tries = 0; tries < 2; tries++) {
    const lines: string[] = [];
    const ran = await attempt((line) => {
      lines.push(line);
      options.log(line);
    });
    if (ran.ok) return { ok: true };
    transient = transientLine(lines);
    if (transient === undefined || options.signal.aborted)
      return { ok: false, error: ran.error, infrastructure: false };
    if (tries === 0) {
      const wait = options.retryMs ?? INSTALL_RETRY_MS;
      options.log(`install hit a transient failure (${transient.trim()}); retrying once in ${wait / 1000}s`);
      if (!(await sleep(wait, options.signal)))
        return { ok: false, error: ran.error, infrastructure: false };
    }
  }
  return {
    ok: false,
    error: `${INFRASTRUCTURE}: install failed twice — ${transient?.trim() ?? ""}`,
    infrastructure: true,
  };
}

/**
 * Run `fn` holding the lock file at `path`, made with `wx` so exactly one
 * holder at a time, across processes. A lock whose holder is gone (its pid
 * dead on this machine, or older than `staleMs`) is taken over. Answers an
 * Err, without running `fn`, when `signal` aborts the wait.
 */
export async function withLock<T>(
  path: string,
  fn: () => Promise<T>,
  options: { readonly signal: AbortSignal; readonly staleMs?: number | undefined },
): Promise<Result<T, string>> {
  // Holders in this process queue in memory, so a release hands over at
  // once; the file is what holds other processes out.
  const before = local.get(path) ?? Promise.resolve();
  let release = (): void => {};
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = before.then(() => mine);
  local.set(path, tail);
  try {
    if (!(await settledBefore(before, options.signal)))
      return err("cancelled waiting for the install lock");
    return await holdFile(path, fn, options);
  } finally {
    release();
    if (local.get(path) === tail) local.delete(path);
  }
}

const local = new Map<string, Promise<void>>();

async function holdFile<T>(
  path: string,
  fn: () => Promise<T>,
  options: { readonly signal: AbortSignal; readonly staleMs?: number | undefined },
): Promise<Result<T, string>> {
  mkdirSync(dirname(path), { recursive: true });
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  for (;;) {
    if (options.signal.aborted) return err("cancelled waiting for the install lock");
    try {
      writeFileSync(path, `${process.pid} ${Date.now()}\n`, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Taking over a dead holder's lock can race another waiter doing the
    // same; that only happens after a crash, and costs one overlap at worst.
    if (stale(path, staleMs)) rmSync(path, { force: true });
    else await sleep(LOCK_POLL_MS, options.signal);
  }
  try {
    return ok(await fn());
  } finally {
    rmSync(path, { force: true });
  }
}

function stale(path: string, staleMs: number): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return false;
  if (Date.now() - stat.mtimeMs > staleMs) return true;
  let pid = Number.NaN;
  try {
    pid = Number.parseInt(readFileSync(path, "utf8"), 10);
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Wait for `before`; false when `signal` aborted it first. */
function settledBefore(before: Promise<void>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const stop = (): void => resolve(false);
    signal.addEventListener("abort", stop, { once: true });
    void before.then(() => {
      signal.removeEventListener("abort", stop);
      resolve(true);
    });
  });
}

/** Wait `ms`; false when `signal` aborted it first. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve(true);
    }, ms);
    const stop = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}
