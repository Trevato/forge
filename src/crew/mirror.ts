/**
 * A bare mirror of each repository, so a second clone of it borrows the
 * objects already on disk. It lives at `<data>/crew/.mirrors/<repo id>`:
 * one per repository id, never shared, so a private repository's objects
 * never reach another's clone. The sandbox denies it with the other agents'
 * directories (it is an entry of `crew/` that is not the agent's own).
 *
 * The clone borrows with `--reference-if-able` and `--dissociate`: it copies
 * what it borrowed and keeps no link, so a deleted mirror breaks nothing. A
 * mirror that cannot be fetched is skipped, and the clone is a plain one. A
 * mirror whose objects git finds damaged is dropped, and the clone is plain.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "../git/env.ts";
import { createLog } from "../kernel/log.ts";
import { crewRoot } from "./workdir.ts";

const log = createLog("mirror");

export const mirrorDir = (dataDir: string, repoId: string): string =>
  join(crewRoot(dataDir), ".mirrors", repoId);

// One chain per repository: two fetches into one mirror never overlap.
const chains = new Map<string, Promise<unknown>>();

function exclusive<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(job, job);
  const tail = run.catch(() => undefined);
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/** Fetch into the mirror, or rebuild it; the mirror's path, or undefined. Hold the chain. */
async function refresh(
  dir: string,
  url: string,
  opts: { env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
): Promise<string | undefined> {
  if (existsSync(join(dir, "HEAD"))) {
    const fetched = await runGit(
      ["fetch", "--quiet", "--prune", "--force", url, "+refs/*:refs/*"],
      { ...opts, cwd: dir },
    );
    if (fetched.ok) return dir;
    // A cancelled fetch is not a broken mirror: keep what is good.
    if (opts.signal?.aborted) return undefined;
    rmSync(dir, { recursive: true, force: true });
  }
  if (opts.signal?.aborted) return undefined;
  mkdirSync(join(dir, ".."), { recursive: true });
  const made = await runGit(
    ["clone", "--quiet", "--mirror", "--", url, dir],
    opts,
  );
  if (made.ok) return dir;
  rmSync(dir, { recursive: true, force: true });
  return undefined;
}

/** Git's wording for a damaged object store; a timeout kill or a dead origin says none of it. */
const damaged = (stderr: string): boolean =>
  /bad object|corrupt|inflate|did not receive expected object|missing object|unable to parse|invalid object|checkout failed/i.test(
    stderr,
  );

const validId = (repoId: string): boolean => /^[A-Za-z0-9_-]+$/.test(repoId);

/**
 * Delete the repository's mirror, through the same chain as the fetches, so
 * one already running finishes first and none can recreate it afterwards (the
 * repository is gone, so a later fetch fails).
 */
function removeMirror(dataDir: string, repoId: string): Promise<void> {
  if (!validId(repoId)) return Promise.resolve();
  return exclusive(repoId, async () => {
    rmSync(mirrorDir(dataDir, repoId), { recursive: true, force: true });
  });
}

/** `removeMirror` without waiting for it: a failure is logged, never thrown. */
export function dropMirror(dataDir: string, repoId: string): void {
  removeMirror(dataDir, repoId).catch((error) =>
    log.warn("a deleted repository's mirror would not go", {
      repo: repoId,
      error: String(error),
    }),
  );
}

/**
 * `git clone` of `url` into `dir`, borrowing from the repository's mirror
 * when there is one. The clone runs inside the chain: a rebuild of the mirror
 * cannot delete it while it is being read. `dir` must be fresh: a fallback
 * removes whatever the failed clone left there.
 */
export async function cloneWithMirror(input: {
  dataDir: string;
  repoId: string;
  url: string;
  dir: string;
  env: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): ReturnType<typeof runGit> {
  const opts = {
    env: input.env,
    timeoutMs: input.timeoutMs ?? 5 * 60_000,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  const plain = () =>
    runGit(["clone", "--quiet", "--", input.url, input.dir], opts);
  if (!validId(input.repoId)) return plain();
  return exclusive(input.repoId, async () => {
    const mirror = await refresh(mirrorDir(input.dataDir, input.repoId), input.url, opts);
    if (mirror === undefined) return plain();
    const borrowed = await runGit(
      ["clone", "--quiet", "--reference-if-able", mirror, "--dissociate", "--", input.url, input.dir],
      opts,
    );
    if (borrowed.ok || input.signal?.aborted) return borrowed;
    // A timeout (SIGKILL, empty stderr) or an unreachable origin is not the mirror's fault.
    if (!damaged(borrowed.error.stderr)) return borrowed;
    // A damaged mirror costs one slower clone, never the run.
    log.warn("a clone from the mirror failed; dropping it and cloning plain", {
      repo: input.repoId,
      error: borrowed.error.stderr.split("\n")[0] ?? "",
    });
    rmSync(input.dir, { recursive: true, force: true });
    rmSync(mirror, { recursive: true, force: true });
    return plain();
  });
}
