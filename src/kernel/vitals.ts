/**
 * The forge's standing: is it fine, and if not, what is off. Only what needs
 * a person now is a need; a setting that is not the default is a note on its
 * own page (`web/pages/capacity.ts`), never here. Plain data in,
 * plain data out — the disk under `FORGE_DATA`, this process's memory, the
 * queue, runs that stopped making progress, and how many apps are serving,
 * asleep or previewed. A fixed handful of queries however many runs and
 * apps there are; nothing is cached, nothing shelled out.
 */

import type { Database } from "bun:sqlite";
import { statfsSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { refusedInternal, type RefusedLedger } from "./internal_refused.ts";
import { recentErrors, type ErrorLedger, type ErrorLine } from "./log.ts";
import {
  budgetFailures,
  leaseLapsed,
  listRunning,
  queueDepth,
} from "../core/runs.ts";
import { STALE_AFTER_MS } from "../runs/lease.ts";

/** Free disk under this share of the volume is something to say. */
export const DISK_FREE_MIN = 0.1;
/** This many error lines in an hour is a burst worth saying. */
export const ERROR_BURST = 20;
/** A run still running this long after it started is stuck even if it breathes. */
export const NO_PROGRESS_MS = 6 * 3_600_000;
/** A run that has waited this long to start is a queue that is not moving. */
export const QUEUE_WAIT_MAX_MS = 30 * 60_000;

export interface EnvCount {
  readonly env: string;
  readonly state: string;
}

/** How many finished checks the median is taken over. */
export const MEDIAN_OVER = 20;

/** The check lane: one at a time, so depth times the median is the wait. */
export interface Lane {
  readonly queued: number;
  readonly running: { pull: number | null; since: string } | null;
  readonly medianMinutes: number | null;
  readonly clearsInMinutes: number | null;
}

export interface Vitals {
  readonly ok: boolean;
  readonly needs: string[];
  readonly disk: { freeBytes: number; totalBytes: number };
  readonly memory: {
    rssBytes: number;
    hostFreeBytes: number;
    hostTotalBytes: number;
  };
  readonly queue: Record<string, number>;
  readonly lane: Lane;
  readonly stuck: {
    runId: string;
    repo: string;
    issue: number | null;
    since: string;
  }[];
  readonly apps: { serving: number; asleep: number; previews: number };
  readonly errors: { lastHour: number; latest: ErrorLine[] };
  readonly at: string;
}

export interface VitalsInput {
  readonly db: Database;
  /** The directory holding the forge's data: its volume is the one measured. */
  readonly dataDir: string;
  /** Every environment the runtime holds, when one is up. */
  readonly envs?: readonly EnvCount[];
  readonly now?: number;
  /** One forge's own signals (`App.signals`). */
  readonly signals: { errors: ErrorLedger; refused: RefusedLedger };
}

/** The lane as one line (no label; callers add their own), or null when nothing is queued. */
export function laneLine(lane: Lane, now = Date.now()): string | null {
  if (lane.queued === 0) return null;
  const parts = [`${lane.queued} check${lane.queued === 1 ? "" : "s"} queued`];
  if (lane.running !== null) {
    const age = Math.max(
      0,
      Math.round((now - new Date(lane.running.since).getTime()) / 60_000),
    );
    parts.push(
      `running ${lane.running.pull === null ? "a check" : `#${lane.running.pull}`} for ${age} min`,
    );
  }
  if (lane.medianMinutes !== null) parts.push(`median ${lane.medianMinutes} min`);
  if (lane.clearsInMinutes !== null)
    parts.push(
      `clears in ~${lane.clearsInMinutes >= 120 ? `${Math.round(lane.clearsInMinutes / 60)} h` : `${lane.clearsInMinutes} min`}`,
    );
  return parts.join(" · ");
}

/** Depth, the running check, and the median of the last finished ones. */
function readLane(
  db: Database,
  running: ReturnType<typeof listRunning>,
  now: number,
): Lane {
  const queued =
    db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM run WHERE kind = 'check' AND state = 'queued'",
      )
      .get()?.n ?? 0;
  const first = running.find(
    (r) => r.run.kind === "check" && !leaseLapsed(r.run, STALE_AFTER_MS, now),
  );
  const durations = db
    .query<{ ms: number }, [number]>(
      `SELECT (julianday(finished_at) - julianday(started_at)) * 86400000 AS ms
       FROM run WHERE kind = 'check' AND state IN ('ok','failed')
         AND started_at IS NOT NULL AND finished_at IS NOT NULL
       ORDER BY finished_at DESC LIMIT ?1`,
    )
    .all(MEDIAN_OVER)
    .map((r) => r.ms)
    .sort((a, b) => a - b);
  const mid = durations.length >> 1;
  const medianMs =
    durations.length === 0
      ? null
      : durations.length % 2
        ? durations[mid]!
        : (durations[mid - 1]! + durations[mid]!) / 2;
  const medianMinutes = medianMs === null ? null : Math.round(medianMs / 60_000);
  return {
    queued,
    running: first
      ? {
          pull: first.issue,
          since: first.run.startedAt ?? first.run.createdAt,
        }
      : null,
    medianMinutes,
    clearsInMinutes:
      medianMinutes === null || queued === 0 ? null : queued * medianMinutes,
  };
}

export function vitals(input: VitalsInput): Vitals {
  const now = input.now ?? Date.now();
  const needs: string[] = [];

  const fs = statfsSync(input.dataDir);
  const disk = {
    freeBytes: Number(fs.bavail) * Number(fs.bsize),
    totalBytes: Number(fs.blocks) * Number(fs.bsize),
  };
  if (disk.totalBytes > 0 && disk.freeBytes / disk.totalBytes < DISK_FREE_MIN)
    needs.push(
      `Disk is nearly full: ${Math.round((disk.freeBytes / disk.totalBytes) * 100)}% free.`,
    );

  const running = listRunning(input.db);
  const lane = readLane(input.db, running, now);
  const queue: Record<string, number> = {};
  for (const row of queueDepth(input.db, now)) {
    queue[row.kind] = row.queued;
    if (now - new Date(row.oldest).getTime() > QUEUE_WAIT_MAX_MS)
      needs.push(
        row.kind === "check"
          ? [
              `The check queue has waited over ${QUEUE_WAIT_MAX_MS / 60_000} minutes`,
              laneLine(lane, now),
              "one lane, checks run one at a time",
            ]
              .filter((part) => part !== null)
              .join("; ") + "."
          : `The ${row.kind} queue has waited over ${QUEUE_WAIT_MAX_MS / 60_000} minutes.`,
      );
  }

  const stuck: Vitals["stuck"] = [];
  for (const { run, repo, issue } of running) {
    const started = new Date(run.startedAt ?? run.createdAt).getTime();
    if (leaseLapsed(run, STALE_AFTER_MS, now) || now - started > NO_PROGRESS_MS)
      stuck.push({
        runId: run.id,
        repo,
        issue,
        since: run.heartbeatAt ?? run.startedAt ?? run.createdAt,
      });
  }
  if (stuck.length > 0)
    needs.push(
      `${stuck.length} run${stuck.length === 1 ? " is" : "s are"} stuck.`,
    );

  // A run killed twice for its budget is a card, for a day.
  for (const run of budgetFailures(
    input.db,
    new Date(now - 24 * 3_600_000).toISOString(),
  ))
    needs.push(`A run was killed twice: ${run.summary}.`);

  const apps = { serving: 0, asleep: 0, previews: 0 };
  for (const e of input.envs ?? []) {
    if (e.env !== "production") apps.previews++;
    else if (e.state === "asleep") apps.asleep++;
    else if (e.state === "running") apps.serving++;
  }

  const seen = recentErrors(5, now, input.signals.errors);
  if (seen.lastHour >= ERROR_BURST)
    needs.push(
      `${seen.lastHour} errors in the last hour (${ERROR_BURST} or more is a burst).`,
    );

  const refused = refusedInternal(now, input.signals.refused);
  if (refused.lastHour > 0)
    needs.push(
      `${refused.lastHour} internal call${refused.lastHour === 1 ? "" : "s"} without the boot secret refused in the last hour${refused.latest ? ` (latest ${refused.latest.method} ${refused.latest.path})` : ""}.`,
    );

  return {
    ok: needs.length === 0,
    needs,
    disk,
    memory: {
      rssBytes: process.memoryUsage().rss,
      hostFreeBytes: freemem(),
      hostTotalBytes: totalmem(),
    },
    queue,
    lane,
    stuck,
    apps,
    errors: { lastHour: seen.lastHour, latest: seen.latest },
    at: new Date(now).toISOString(),
  };
}
