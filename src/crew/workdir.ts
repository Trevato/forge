/**
 * Where an agent's clones live: `<data>/crew/<agent>/<repo id>/<issue n>/`,
 * for as long as the pull is open. One file, so the runner, the dispatcher
 * and the sandbox policy agree on the layout without importing each other.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Agent } from "../core/agents.ts";
import type { Repo } from "../core/repos.ts";

export const crewRoot = (dataDir: string): string => join(dataDir, "crew");

export function workdirFor(
  dataDir: string,
  agent: Agent,
  repo: Repo,
  issueNumber: number,
): string {
  return join(
    crewRoot(dataDir),
    agent.user.username,
    repo.id,
    String(issueNumber),
  );
}

const claimed = new Set<string>();

/** Whether a live run in this process holds `dir`. */
export const isClaimed = (dir: string): boolean => claimed.has(dir);

/**
 * The directory a run works in. The issue's own clone when no other live run
 * holds it (a paused run resumes in the tree it left); otherwise a directory
 * of the run's own beside it, so two runs on one issue never share a clone.
 * `release` frees the claim and removes a run-owned directory.
 */
export function claimWorkdir(
  base: string,
  runId: string,
): { dir: string; own: boolean; release: () => Promise<void> } {
  const own = claimed.has(base);
  const dir = own ? `${base}.run-${runId.replace(/[^A-Za-z0-9]/g, "")}` : base;
  claimed.add(dir);
  return {
    dir,
    own,
    release: async () => {
      claimed.delete(dir);
      if (own) await removeClone(dir).catch(() => {});
    },
  };
}

/**
 * Every repository's install caches, side by side: `<data>/crew/.cache/`.
 * Not an agent's name (a username cannot start with a dot), so no agent's
 * directory is mistaken for it.
 */
export const cacheRoot = (dataDir: string): string =>
  join(crewRoot(dataDir), ".cache");

/**
 * Bun's install cache for one repository: shared by every run on it, never
 * by two repositories, so a private repository's packages stay with it.
 */
export function installCacheDir(dataDir: string, repoId: string): string {
  return join(cacheRoot(dataDir), repoId, "bun");
}

/** A removed repository takes its cache with it. */
export async function removeInstallCache(
  dataDir: string,
  repoId: string,
): Promise<void> {
  await rm(join(cacheRoot(dataDir), repoId), { recursive: true, force: true });
}

/**
 * Remove a clone without blocking the event loop: a leftover process still
 * writing into it makes a removal fail with ENOTEMPTY, so it is tried again
 * a few times, awaiting between tries. Rejects with the last error if the
 * clone will not go; the caller says so loudly. `remove` is the removal
 * itself, replaceable for a test.
 */
export async function removeClone(
  dir: string,
  tries = 5,
  delayMs = 100,
  remove: (dir: string) => Promise<unknown> = (d) =>
    rm(d, { recursive: true, force: true }),
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await remove(dir);
      return;
    } catch (error) {
      if (attempt >= tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

const LOCKFILES = ["bun.lock", "bun.lockb"];
const INSTALLED_MARK = join("node_modules", ".forge-lock-hash");

/** Runs `bun install` in a directory with the given env; resolves to its exit code and stderr. */
export type InstallRunner = (
  dir: string,
  env: Record<string, string>,
) => Promise<{ code: number; stderr: string }>;

/** How long an install may take before it is killed and the run starts without it. */
export const INSTALL_TIMEOUT_MS = 120_000;

/**
 * What an install sees of the forge's environment: a repository's package.json
 * is untrusted, so no FORGE_* variable, key or token goes with it.
 */
export function installEnv(
  cacheDir: string,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return {
    PATH: base["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: join(dirname(cacheDir), "home"),
    TMPDIR: base["TMPDIR"] ?? "/tmp",
    BUN_INSTALL_CACHE_DIR: cacheDir,
  };
}

/** Run a command with exactly `env`; killed after `timeoutMs` and reported as a failure. */
export async function runBounded(
  argv: string[],
  dir: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(argv, {
    cwd: dir,
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [stderr, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return timedOut
      ? { code, stderr: `timed out after ${timeoutMs} ms` }
      : { code, stderr };
  } finally {
    clearTimeout(timer);
  }
}

const bunInstall: InstallRunner = (dir, env) =>
  runBounded(
    ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
    dir,
    env,
    INSTALL_TIMEOUT_MS,
  );

/** The run log's line for an install's outcome, if it has one. */
export function installNote(result: {
  installed: boolean;
  error?: string;
}): string | undefined {
  if (result.error !== undefined)
    return `dependency install failed: ${result.error}`;
  return result.installed ? "dependencies installed" : undefined;
}

/**
 * Install a clone's dependencies from the repository's shared cache before the
 * agent starts, so the type check has its types. Only a repository with a
 * package.json and a lockfile is installed; a workdir whose node_modules was
 * installed for the same lockfile hash is left alone. Never throws: a failure
 * comes back as a message for the log, and the run starts regardless.
 */
export async function installDependencies(
  dir: string,
  cacheDir: string,
  run: InstallRunner = bunInstall,
): Promise<{ installed: boolean; error?: string }> {
  try {
    const lock = LOCKFILES.map((name) => join(dir, name)).find((p) =>
      existsSync(p),
    );
    if (lock === undefined || !existsSync(join(dir, "package.json")))
      return { installed: false };
    const hash = new Bun.CryptoHasher("sha256")
      .update(readFileSync(lock))
      .digest("hex");
    const mark = join(dir, INSTALLED_MARK);
    if (existsSync(mark) && readFileSync(mark, "utf8") === hash)
      return { installed: false };
    const env = installEnv(cacheDir);
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(env["HOME"]!, { recursive: true });
    const result = await run(dir, env);
    if (result.code !== 0)
      return {
        installed: false,
        error: `bun install exited ${result.code}: ${result.stderr.slice(0, 200)}`,
      };
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(mark, hash);
    return { installed: true };
  } catch (error) {
    return { installed: false, error: String(error) };
  }
}
