/**
 * Bring every open kept-fork pull's `combined/N` up to date with the default
 * branch (#9012). One pass per repository at a time: a call made during a
 * pass sets one "again" flag, and when the pass ends exactly one more runs,
 * reading the tip then. The post-receive hook starts one, off its answer, for
 * a push that moves the default branch (`http/server.ts`).
 */

import type { Database } from "bun:sqlite";
import { combine, setFailure } from "../git/combined.ts";
import { repoDir } from "../git/repos.ts";
import { resolveOid } from "../git/merge.ts";
import type { Log } from "../kernel/log.ts";
import { fromKeptFork } from "./landing_kind.ts";
import { listOpenPulls } from "./pulls.ts";
import { getRepoById } from "./repos.ts";

/** What a pass needs of the forge: its rows, where repositories live, a log. */
export interface RecombineForge {
  readonly db: Database;
  readonly reposRoot: string;
  readonly log: Log;
}

const running = new Map<string, { again: boolean; done: Promise<number> }>();
const started = new Map<string, number>();

/** How many runs have been started for the repository: what a test counts. */
export function runsStarted(repoId: string): number {
  return started.get(repoId) ?? 0;
}

/** Resolves when the run now going (if any) has ended; starts and joins none. */
export async function idle(repoId: string): Promise<void> {
  await running.get(repoId)?.done;
}

/** What the page says of an error nobody expected: the detail stays in the log. */
const UNEXPECTED = "The rebuild failed unexpectedly; the forge's log has the detail. Push to the fork to rebuild.";

/** One pass: the tip is read once, each pull combined against it. */
async function pass(forge: RecombineForge, repoId: string): Promise<void> {
  const repo = getRepoById(forge.db, repoId);
  if (repo === undefined) return;
  const dir = repoDir(forge.reposRoot, repo.ownerName, repo.name);
  const baseOid = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
  if (baseOid === undefined) return;
  const pulls = listOpenPulls(forge.db, repoId).filter(
    (p) => p.baseBranch === repo.defaultBranch && fromKeptFork(forge.db, p),
  );
  for (const pull of pulls) {
    try {
      const headOid = await resolveOid(dir, `refs/pull/${pull.number}/head`);
      const made =
        headOid === undefined ? undefined : await combine(dir, { number: pull.number, baseOid, headOid });
      if (made === undefined) {
        forge.log.warn("recombine skipped a pull", { repo: repoId, pull: pull.number });
        await setFailure(
          dir,
          pull.number,
          headOid === undefined
            ? "The rebuild failed: the pull's head is missing from the repository. Push to the fork again to rebuild."
            : "The rebuild failed: git could not merge main into the pull's head. Push to the fork to rebuild it.",
        );
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      forge.log.warn("recombine failed on a pull", { repo: repoId, pull: pull.number, error });
      await setFailure(dir, pull.number, UNEXPECTED).catch(() => undefined);
    }
  }
}

/**
 * Recombine the repository's kept-fork pulls. Answers how many passes this
 * call's run took (1, or 2 when calls arrived meanwhile); a call that joins
 * a running pass answers with that run's count.
 */
export function recombine(forge: RecombineForge, repoId: string): Promise<number> {
  const current = running.get(repoId);
  if (current !== undefined) {
    current.again = true;
    return current.done;
  }
  started.set(repoId, runsStarted(repoId) + 1);
  const state = { again: false, done: Promise.resolve(0) };
  state.done = (async () => {
    let passes = 0;
    try {
      do {
        state.again = false;
        passes++;
        await pass(forge, repoId);
      } while (state.again);
    } finally {
      running.delete(repoId);
    }
    return passes;
  })();
  running.set(repoId, state);
  return state.done;
}
