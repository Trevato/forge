/**
 * Mirroring, with something to look at while it happens.
 *
 * Mirroring a repository is a clone, a hook install, and an import of every
 * label, issue, pull and comment on it. That takes seconds on a small repo
 * and much longer on a real one, and doing it inside a request meant a UI
 * that froze with nothing to say. So the work runs as a job and reports
 * where it is; a surface subscribes and renders the stage.
 *
 * The registry is deliberately in memory. Invariant 4 says nothing lives
 * only in the database that git could rebuild — the converse is also true:
 * *progress* is not state worth persisting. A restart mid-mirror leaves a
 * half-fetched repo the next sync completes, and a job row that survived it
 * would only be a lie about a process that no longer exists. What is durable
 * is what always was: the repo row, the `repo.mirrored` and `push` events,
 * and `fetch_error` when it fails.
 */

import type { Repo } from "../core/repos.ts";
import { id } from "../kernel/id.ts";

/**
 * Where a mirror has got to. The order is the order they happen in, and a
 * job only ever moves forward through it; `done` and `failed` are terminal.
 */
export type MirrorStage =
  | "creating"
  | "fetching"
  | "labels"
  | "issues"
  | "pulls"
  | "comments"
  | "done"
  | "failed";

const ORDER: readonly MirrorStage[] = [
  "creating",
  "fetching",
  "labels",
  "issues",
  "pulls",
  "comments",
  "done",
];

export interface MirrorJob {
  readonly id: string;
  readonly originId: string;
  readonly fullName: string;
  readonly stage: MirrorStage;
  /** Human detail for the stage: "42 issues", "receiving objects: 61%". */
  readonly detail: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  /** Set on `done`: the local repository the mirror became. */
  readonly repo?: Repo;
  /** Set on `failed`: a scrubbed reason, safe to show and to log. */
  readonly error?: string;
}

export type JobListener = (job: MirrorJob) => void;

/**
 * Finished jobs are kept so a UI that asks a moment late still learns the
 * outcome; the cap is what stops a long-lived process accumulating them.
 */
const MAX_JOBS = 64;

const jobs = new Map<string, MirrorJob>();
const listeners = new Map<string, Set<JobListener>>();

const terminal = (stage: MirrorStage): boolean =>
  stage === "done" || stage === "failed";

/** Start tracking a mirror. The caller runs the work and reports stages. */
export function createJob(originId: string, fullName: string): MirrorJob {
  const job: MirrorJob = {
    id: id(),
    originId,
    fullName,
    stage: "creating",
    detail: "",
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  prune();
  return job;
}

export const getJob = (jobId: string): MirrorJob | undefined => jobs.get(jobId);

/**
 * The job already mirroring this remote, if one is running. A second start
 * for the same repository joins it rather than racing it — two clones into
 * the same namespace is how you get `widgets` and `widgets-2` from one
 * double-click.
 */
export function runningJob(
  originId: string,
  fullName: string,
): MirrorJob | undefined {
  for (const job of jobs.values()) {
    if (
      job.originId === originId &&
      job.fullName.toLowerCase() === fullName.toLowerCase() &&
      !terminal(job.stage)
    )
      return job;
  }
  return undefined;
}

/** Every job, newest first — what a "what is running?" view renders. */
export const listJobs = (): MirrorJob[] =>
  [...jobs.values()].sort((a, b) => b.id.localeCompare(a.id));

/**
 * Move a job on. A terminal job never moves again: a late stage report from
 * a job that already failed must not resurrect it as "importing issues".
 */
export function advance(
  jobId: string,
  patch: Partial<Omit<MirrorJob, "id" | "originId" | "fullName" | "startedAt">>,
): MirrorJob | undefined {
  const current = jobs.get(jobId);
  if (current === undefined || terminal(current.stage)) return current;
  const stage = patch.stage ?? current.stage;
  // Stages only ever move forward; an out-of-order report is dropped rather
  // than rendered as the mirror going backwards.
  if (ORDER.indexOf(stage) < ORDER.indexOf(current.stage) && stage !== "failed")
    return current;
  const next: MirrorJob = {
    ...current,
    ...patch,
    stage,
    ...(terminal(stage) ? { finishedAt: new Date().toISOString() } : {}),
  };
  jobs.set(jobId, next);
  notify(next);
  return next;
}

/**
 * Watch a job. The listener is called once immediately with the job as it
 * stands — a subscriber that arrives after the first stage must not have to
 * poll to find out where things are — and on every change after.
 */
export function subscribe(jobId: string, listener: JobListener): () => void {
  const current = jobs.get(jobId);
  const set = listeners.get(jobId) ?? new Set<JobListener>();
  set.add(listener);
  listeners.set(jobId, set);
  if (current !== undefined) safely(listener, current);
  return () => {
    const live = listeners.get(jobId);
    if (live === undefined) return;
    live.delete(listener);
    if (live.size === 0) listeners.delete(jobId);
  };
}

/**
 * Resolve when a job stops moving. The mirror runs detached, so anything
 * that needs the repository rather than the progress — the synchronous
 * `mirrorRepo` path, a test, a script — waits here instead of polling.
 * An unknown job resolves immediately with `undefined`: it either never
 * existed or has already been pruned, and neither is worth hanging on.
 */
export function settled(jobId: string): Promise<MirrorJob | undefined> {
  const current = jobs.get(jobId);
  if (current === undefined || terminal(current.stage))
    return Promise.resolve(current);
  return new Promise((resolve) => {
    const stop = subscribe(jobId, (job) => {
      if (!terminal(job.stage)) return;
      stop();
      resolve(job);
    });
  });
}

function notify(job: MirrorJob): void {
  for (const listener of listeners.get(job.id) ?? []) safely(listener, job);
  if (terminal(job.stage)) {
    // Nothing more will ever arrive on this job, so nothing should still be
    // holding a closure over the stream that was watching it.
    listeners.delete(job.id);
  }
}

/** A subscriber's throw is the subscriber's problem, never the mirror's. */
function safely(listener: JobListener, job: MirrorJob): void {
  try {
    listener(job);
  } catch {
    // A listener that throws is dropped from this delivery, not from the set:
    // it is a UI, and the next stage may well reach it fine.
  }
}

/** Drop the oldest finished jobs once the registry is full. */
function prune(): void {
  if (jobs.size <= MAX_JOBS) return;
  for (const [key, job] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (terminal(job.stage)) jobs.delete(key);
  }
  // Still full means everything is running; drop the oldest anyway rather
  // than grow without bound.
  while (jobs.size > MAX_JOBS) {
    const oldest = jobs.keys().next();
    if (oldest.done) break;
    jobs.delete(oldest.value);
  }
}

/** Test seam: forget every job. */
export function resetJobs(): void {
  jobs.clear();
  listeners.clear();
}
