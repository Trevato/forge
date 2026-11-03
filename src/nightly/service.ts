/**
 * The nightly jobs as a service: each waits for its slot (`slots.ts`), runs
 * once (`run.ts`) and files what the Forgejo workflows filed before: the
 * `Flaky:` and `Red:` issues, the quarantine pull. One job at a time, so a
 * hunt never runs beside the outside run; a job that waits behind another
 * still keeps its own slot, so it is not owed again when it ends. On unless
 * the forge lacks what it needs (a token for the hunt's author, the cells to
 * run repository code in) or is a preview, whose copy of the data would
 * file twice. What each job last did is kept (`stamps.ts`) and shown
 * (`says.ts`).
 */

import type { App } from "../app.ts";
import { crewOffInPreview } from "../crew/preview.ts";
import { getRepo } from "../core/repos.ts";
import { createLog } from "../kernel/log.ts";
import { ownRepoPath } from "../kernel/own_repo.ts";
import { JOBS, type Job } from "./jobs.ts";
import { proposeQuarantine } from "./propose.ts";
import { type Ran, runJob } from "./run.ts";
import { lastSlot, owed, untilNext } from "./slots.ts";
import { readLast, writeLast } from "./stamps.ts";

const log = createLog("nightly");

/** What a job does when it runs: the seams a test replaces. */
export interface Doing {
  readonly run: (job: Job, signal: AbortSignal) => Promise<Ran | { readonly error: string }>;
  /** The branch of the pull the job opened, if it opened one. */
  readonly propose: (job: Job, ran: Ran, now: number) => Promise<string | undefined>;
}

export interface NightlyHandle {
  /** Run one job now, as its slot would. */
  readonly run: (name: Job["name"]) => Promise<void>;
  readonly stop: () => Promise<void>;
}

/** The real thing: the forge's own repository, a cell, a pull as its owner. */
function doing(app: App, options: { readonly forgeUrl: string; readonly token: string }): Doing {
  const repoOf = () => {
    const [owner = "", name = ""] = ownRepoPath().split("/");
    return getRepo(app.db, owner, name);
  };
  return {
    run: async (job, signal) => {
      const repo = repoOf();
      if (repo === undefined) return { error: `${ownRepoPath()} is not on this forge` };
      return runJob(app, repo, job, { forgeUrl: options.forgeUrl, token: options.token, signal });
    },
    propose: async (job, ran, now) => {
      const repo = repoOf();
      if (repo === undefined || job.proposes === undefined) return undefined;
      return proposeQuarantine(app, repo, ran, job.proposes.path, job.proposes.branchPrefix, now);
    },
  };
}

const says = (ran: Ran, branch: string | undefined): string =>
  (ran.failed.length === 0 ? "every step finished" : `failed: ${ran.failed.join(", ")}`) +
  (branch === undefined ? "." : `; quarantine pull on ${branch}.`);

export function startNightly(
  app: App,
  options: {
    readonly forgeUrl: string;
    readonly token: string | undefined;
    readonly doing?: Doing;
    readonly now?: () => number;
  },
): NightlyHandle | undefined {
  const token = options.token;
  if (token === undefined || token === "") {
    log.info("nightly jobs are off: no FORGE_TOKEN");
    return undefined;
  }
  if (crewOffInPreview()) return undefined;
  const now = options.now ?? Date.now;
  const does = options.doing ?? doing(app, { forgeUrl: options.forgeUrl, token });
  const abort = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let going: Promise<unknown> = Promise.resolve();

  const run = (name: Job["name"]): Promise<void> => {
    const job = JOBS.find((j) => j.name === name)!;
    // The slot is read when the run is asked for, not when it gets its turn.
    const slot = lastSlot(job.slot, now());
    const turn = going.then(async () => {
      if (abort.signal.aborted) return;
      const startedAt = now();
      writeLast(app.config.dataDir, job.name, { slot, startedAt, says: "began" });
      const end = (said: string): void =>
        writeLast(app.config.dataDir, job.name, { slot, startedAt, finishedAt: now(), says: said });
      log.info("started", { job: job.name });
      const ran = await does.run(job, abort.signal);
      if ("error" in ran) {
        log.warn("not run", { job: job.name, error: ran.error });
        return end(`not run: ${ran.error}.`);
      }
      const branch =
        job.proposes !== undefined && !ran.failed.includes("quarantine")
          ? await does.propose(job, ran, now())
          : undefined;
      log.info("finished", { job: job.name, failed: ran.failed.join(", "), pull: branch ?? "" });
      end(abort.signal.aborted ? `stopped by a restart; ${says(ran, branch)}` : says(ran, branch));
    });
    going = turn.catch((error) => log.error("failed", { job: job.name, error: String(error) }));
    return going as Promise<void>;
  };

  const wait = (job: Job): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      void run(job.name).finally(() => !abort.signal.aborted && wait(job));
    // A second past the slot: a timer that fires early would read yesterday's.
    }, untilNext(job.slot, now()) + 1_000);
    timers.add(timer);
  };
  for (const job of JOBS) {
    // A forge that was down at the slot runs the job on waking.
    if (owed(job.slot, readLast(app.config.dataDir, job.name)?.slot, now())) void run(job.name);
    wait(job);
  }
  return {
    run,
    stop: async () => {
      abort.abort();
      for (const t of timers) clearTimeout(t);
      await going;
    },
  };
}
