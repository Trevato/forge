/**
 * Checks stopped for CPU in the last hour (#11617), for /flow's one sentence:
 * named only when they are the lane's main failure, at least as many as every
 * other failed check together. A stop counts whether it was queued again
 * (cancelled, `CPU_STOP_SUMMARY`) or reported red (a second stop in a row).
 * Walks `run_kind_finished` (kind, finished_at): one hour of finished checks.
 */

import type { Database } from "bun:sqlite";
import { CPU_STOP_SUMMARY } from "../core/runs.ts";

const HOUR_MS = 3_600_000;

/** How the watch's stop reads in a red check's summary: `check failed: stopped: used 16.3 cores for 31s, over its limit of 16…`. */
const CPU_RED = /stopped: (?:it )?used \d+(?:\.\d+)? cores for \d+s, over its limit of \d/;

export interface CpuStops {
  /** Checks stopped for CPU in the hour. */
  readonly stopped: number;
  /** Every check that failed in the hour, the stops among them. */
  readonly failed: number;
}

export function cpuStops(db: Database, now = new Date()): CpuStops {
  const since = new Date(now.getTime() - HOUR_MS).toISOString();
  const rows = db
    .query<{ state: string; summary: string }, [string]>(
      `SELECT state, summary FROM run
        WHERE kind = 'check' AND finished_at IS NOT NULL AND finished_at >= ?1
          AND state IN ('failed', 'cancelled')`,
    )
    .all(since);
  let stopped = 0;
  let failed = 0;
  for (const r of rows) {
    const cpu = r.state === "cancelled" ? r.summary === CPU_STOP_SUMMARY : CPU_RED.test(r.summary);
    if (r.state === "failed" || cpu) failed++;
    if (cpu) stopped++;
  }
  return { stopped, failed };
}

/** The reason /flow's sentence carries, or undefined when CPU stops are not the main failure. */
export function cpuStopReason(s: CpuStops): string | undefined {
  if (s.stopped === 0 || s.stopped * 2 < s.failed) return undefined;
  return `checks stopped for CPU: ${s.stopped} of ${s.failed} failed ${s.failed === 1 ? "check" : "checks"} in the last hour`;
}
