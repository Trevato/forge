/**
 * What has left its window goes, in small slices on a pace (#12052, part of #11973).
 *
 * Five jobs, each a slice of bounded rows and so of bounded time, none holding a
 * transaction open past it, each named to the perf job watch (`perf/jobs.ts`) so a
 * stall is blamed on it:
 *
 * - `retention-events`: the age rule (`system/retention_events.ts`), 200 rows walked a slice;
 * - `retention-live`: wake-up events (`run.shard`, `usage.delta`, `backup.progress`) past
 *   hours, not 30 days (`pruneLiveEvents`), 400 rows a slice;
 * - `retention-samples`: the machine's history (`system/retention_samples.ts`), 600 rows a slice;
 * - `landed-backfill`: `deploy_landed` from the rows of the old ledger, 60 pulls a slice, then
 *   an hourly pass for the deploys an older release recorded meanwhile;
 * - `retention-deploys`: the old ledger's rows past the window (`system/retention_deploys.ts`),
 *   250 rows a slice, and only once `landed-backfill` has had a full pass.
 *
 * The pace is the cost of the slice: after a slice of `t` ms with more behind it, the next
 * waits `t * (1 / DUTY - 1)` (at least `MIN_GAP_MS`), so a job takes at most `DUTY` of the thread
 * whatever a slice costs there, and a slower disk or a bigger table lengthens the wait, never
 * the stall. With nothing behind, a job looks again after its own idle gap. A slice that
 * throws is logged and tried again at the idle gap. Every job reads and writes only the
 * database, so the same jobs run on the serving thread (`inline`) or on the engine's Worker
 * (`engine/duties.ts` starts them on whichever thread runs the engine, never both).
 *
 * The write clock (`core/write_clock.ts`) is what tells a page cache that anything was written: a
 * slice a few times a second for hours would keep every cache cold. A write nothing shows is left out
 * of it (`quietly`) on the serving thread's connection, and a commit of the engine's connection cannot
 * be left out. So the three jobs that only drain rows no page reads (`retention-samples`,
 * `retention-live`, `retention-deploys`) are the serving thread's always (`local`), and the two whose
 * writes are meaningful (`retention-events`: a feed shows what it leaves; `landed-backfill`: ask-to-live
 * shows what it writes) are the engine's thread's when it has one (`engine`).
 */

import type { App } from "../app.ts";
import { backfillLanded, LANDED_SLICE } from "../core/carried.ts";
import { pillarWindowStart } from "../core/pillars.ts";
import { quietly } from "../core/write_clock.ts";
import { withoutWaiting } from "../kernel/db.ts";
import { during } from "../perf/jobs.ts";
import { limitValue } from "../settings/limits.ts";
import { deployRetention } from "./retention_deploys.ts";
import {
  LIVE_SLICE_ROWS,
  pruneEvents,
  pruneLiveEvents,
  TICK_ROWS,
} from "./retention_events.ts";
import { pruneSamples, ROW_CAP } from "./retention_samples.ts";

/** The share of the thread one job may take while it has work behind it. */
export const DUTY = 0.05;
/** The least wait between two slices of one job. */
export const MIN_GAP_MS = 100;
/** How long a job with nothing behind it waits to look again. */
export const IDLE_MS = 15_000;
/** How long the backfill waits between passes, once a pass has found nothing more. */
export const BACKFILL_EVERY_MS = 60 * 60_000;

/** What one slice did: rows it touched, and whether more is due right away. */
export interface Slice {
  readonly did: number;
  readonly more: boolean;
}

/** The wait before the next slice of a job whose slice just took `elapsedMs`. */
export function gapAfter(
  elapsedMs: number,
  more: boolean,
  idleMs: number = IDLE_MS,
): number {
  return more
    ? Math.max(MIN_GAP_MS, Math.ceil(elapsedMs * (1 / DUTY - 1)))
    : idleMs;
}

/**
 * No two slices run back to back: after any slice, every job waits out `QUIET_X` times what it took (at
 * least `MIN_GAP_MS`) before it starts one, so a loop that is asked for a page between two slices is
 * never made to wait for both.
 */
export const QUIET_X = 3;

/** One job's work: a slice at `now`, and how long to wait when it has nothing behind it. */
export interface Job {
  slice(now: number): Slice;
  readonly idleMs: number;
}

/** The jobs of one forge. They keep their place between slices, per app. */
export interface Retention {
  readonly events: Job;
  readonly live: Job;
  readonly samples: Job;
  readonly backfill: Job;
  readonly deploys: Job;
  /** Whether `deploy_landed` has had a full pass from the old ledger. */
  landedReady(): boolean;
}

export function retentionJobs(app: App): Retention {
  const db = app.db;
  let filled = false;
  let cursor: { at: string; id: string } | undefined;
  const trimDeploys = deployRetention(
    db,
    undefined,
    () => limitValue(db, "retention.deploy_pull_days"),
    () => filled,
  );
  return {
    landedReady: () => filled,
    events: {
      idleMs: IDLE_MS,
      slice(now) {
        const r = withoutWaiting(db, () =>
          pruneEvents(
            db,
            now,
            TICK_ROWS,
            limitValue(db, "retention.event_days") * 86_400_000,
          ),
        );
        return { did: r.deleted, more: r.more };
      },
    },
    live: {
      idleMs: IDLE_MS,
      slice(now) {
        const r = withoutWaiting(db, () =>
          pruneLiveEvents(db, now, LIVE_SLICE_ROWS),
        );
        return { did: r.deleted, more: r.more };
      },
    },
    samples: {
      idleMs: IDLE_MS,
      slice(now) {
        const r = pruneSamples(db, now, ROW_CAP);
        return { did: r.deleted + r.rolled, more: r.more };
      },
    },
    backfill: {
      idleMs: BACKFILL_EVERY_MS,
      slice(now) {
        const r = backfillLanded(
          db,
          pillarWindowStart(new Date(now)),
          LANDED_SLICE,
          cursor,
        );
        cursor = r.next;
        // The end of a pass is the end of the window's pulls: the ledger may go.
        if (r.next === undefined) filled = true;
        return { did: r.filled, more: r.next !== undefined };
      },
    },
    deploys: {
      idleMs: IDLE_MS,
      slice(now) {
        const r = quietly(db, () => withoutWaiting(db, () => trimDeploys(new Date(now))));
        return r === undefined
          ? { did: 0, more: false }
          : { did: r.deleted, more: r.more };
      },
    },
  };
}

/**
 * Start the retention jobs `which` names (`local`: the quiet drains; `engine`: the two with meaningful writes); the returned function stops them all. The backfill's
 * first slice runs at once, the way a boot sweep does; the others are staggered
 * so no two first slices meet.
 */
export function startRetention(app: App, which: { local: boolean; engine: boolean }): () => void {
  const jobs = retentionJobs(app);
  let stopped = false;
  /** When the last slice of any job ended, plus the quiet it asks (`performance.now` ms). */
  let quietUntil = 0;
  /** Whether another job's slice is too recent: then `rearm` the job for when it is not. */
  const held = (rearm: (delay: number) => void): boolean => {
    const wait = quietUntil - performance.now();
    if (wait <= 0) return false;
    rearm(Math.ceil(wait));
    return true;
  };
  /** Each job's one pending timer. */
  const pending: (ReturnType<typeof setTimeout> | undefined)[] = [];
  const work = (job: Job, what: string): number => {
    const started = performance.now();
    try {
      const r = job.slice(Date.now());
      const took = performance.now() - started;
      quietUntil = performance.now() + Math.max(MIN_GAP_MS, took * QUIET_X);
      return gapAfter(took, r.more, job.idleMs);
    } catch (error) {
      app.log.warn(`${what} failed`, { error: String(error) });
      return job.idleMs;
    }
  };
  const backfill = (delay: number): void => {
    pending[0] = setTimeout(() => {
      if (stopped) return;
      if (held(backfill)) return;
      during("landed-backfill", () => backfill(work(jobs.backfill, "deploy landing backfill")));
    }, delay);
  };
  const live = (delay: number): void => {
    pending[1] = setTimeout(() => {
      if (stopped) return;
      if (held(live)) return;
      during("retention-live", () => live(work(jobs.live, "live event prune")));
    }, delay);
  };
  const events = (delay: number): void => {
    pending[2] = setTimeout(() => {
      if (stopped) return;
      if (held(events)) return;
      during("retention-events", () => events(work(jobs.events, "event prune")));
    }, delay);
  };
  const samples = (delay: number): void => {
    pending[3] = setTimeout(() => {
      if (stopped) return;
      if (held(samples)) return;
      during("retention-samples", () => samples(work(jobs.samples, "machine sample prune")));
    }, delay);
  };
  const deploys = (delay: number): void => {
    pending[4] = setTimeout(() => {
      if (stopped) return;
      if (held(deploys)) return;
      during("retention-deploys", () => deploys(work(jobs.deploys, "deploy ledger trim")));
    }, delay);
  };
  if (which.engine) {
    backfill(0);
    events(3_000);
  }
  if (which.local) {
    live(1_000);
    samples(5_000);
    deploys(7_000);
  }
  return () => {
    stopped = true;
    for (const timer of pending) if (timer !== undefined) clearTimeout(timer);
  };
}
