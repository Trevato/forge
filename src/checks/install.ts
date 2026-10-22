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

import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "../kernel/result.ts";

/** What an install prints when the machine, not the code, failed it. */
export const TRANSIENT_INSTALL = /Fail extracting tarball|EINTEGRITY|ECONNRESET/;

/** How long a transient install failure waits before its one retry. */
export const INSTALL_RETRY_MS = 2_000;

/** The error prefix of an install the machine failed twice: not the pull's red. */
export const INFRASTRUCTURE = "infrastructure";

/** A lock older than this is a holder that died: a whole install never takes so long. */
export const LOCK_STALE_MS = 15 * 60_000;

const LOCK_POLL_MS = 50;

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
