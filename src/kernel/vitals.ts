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
import { recentErrors, type ErrorLine } from "./log.ts";
import { leaseLapsed, listRunning, queueDepth } from "../core/runs.ts";
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

  const queue: Record<string, number> = {};
  for (const row of queueDepth(input.db, now)) {
    queue[row.kind] = row.queued;
    if (now - new Date(row.oldest).getTime() > QUEUE_WAIT_MAX_MS)
      needs.push(
        `The ${row.kind} queue has waited over ${QUEUE_WAIT_MAX_MS / 60_000} minutes.`,
      );
  }

  const stuck: Vitals["stuck"] = [];
  for (const { run, repo, issue } of listRunning(input.db)) {
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

  const apps = { serving: 0, asleep: 0, previews: 0 };
  for (const e of input.envs ?? []) {
    if (e.env !== "production") apps.previews++;
    else if (e.state === "asleep") apps.asleep++;
    else if (e.state === "running") apps.serving++;
  }

  const seen = recentErrors(5, now);
  if (seen.lastHour >= ERROR_BURST)
    needs.push(
      `${seen.lastHour} errors in the last hour (${ERROR_BURST} or more is a burst).`,
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
    stuck,
    apps,
    errors: { lastHour: seen.lastHour, latest: seen.latest },
    at: new Date(now).toISOString(),
  };
}
