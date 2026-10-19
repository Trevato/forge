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
import { statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";
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
import { BUDGETS } from "./budgets.ts";
import { lastMirror, mirrorNeed } from "../snapshot/mirror.ts";
import { lastSnapshotOutcome, snapshotNeed } from "../snapshot/outcome.ts";
import { drillNeed, firstSeen as drillFirstSeen, lastVerdict } from "../snapshot/verdict.ts";
import { proofNeed } from "../release/prove.ts";
import { behindStanding } from "../release/behind.ts";
import { newestDrills } from "../core/domain_drills.ts";
import { DOMAINS } from "./domains.ts";
import { domainDrillNeeds } from "./domain_drill.ts";
import { heldChecks, redSentence } from "../checks/red_main.ts";
import { flakeHref, sharedCause, sharedSentence, sharedTests } from "../checks/shared_red.ts";

/** Free disk under this share of the volume is something to say. */
export const DISK_FREE_MIN = 0.1;
/** This many error lines in an hour is a burst worth saying. */
export const ERROR_BURST = 20;
/** A run still running this long after it started is stuck even if it breathes. */
export const NO_PROGRESS_MS = 6 * 3_600_000;
/** A run that has waited this long to start is a queue that is not moving. */
export const QUEUE_WAIT_MAX_MS = 30 * 60_000;
/** Said when snapshots share the volume they are a copy of and nothing copies them off it. */
export const SNAPSHOTS_ON_STATE_VOLUME =
  "Snapshots are kept on the forge's own volume and mirrored nowhere: losing the volume loses them too.";

export interface EnvCount {
  readonly env: string;
  readonly state: string;
}

/**
 * One cause of the forge being off: the `needs` sentence, a `cause` key that
 * holds for as long as its condition does (`disk`, `errors`, `internal`,
 * `queue:<kind>`, `release`, `stuck:<runId>`, `red:<repoId>`, `shared:<repoId>:<test>`), when it began by the forge's own evidence
 * (the oldest evidence the forge holds, else the first time this process saw
 * it, held until the cause clears; `at` is never the answer to a repeat
 * call), and where to look.
 */
export interface Degraded {
  readonly cause: string;
  readonly sentence: string;
  readonly since: string;
  readonly href: string;
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
  readonly degraded: Degraded[];
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

/** What a volume holds and has free. */
export interface DiskReading {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

/** The volume under `dir`, as the operating system reports it. */
export function statDisk(dir: string): DiskReading {
  const fs = statfsSync(dir);
  return {
    freeBytes: Number(fs.bavail) * Number(fs.bsize),
    totalBytes: Number(fs.blocks) * Number(fs.bsize),
  };
}

export interface VitalsInput {
  readonly db: Database;
  /** The directory holding the forge's data: its volume is the one measured. */
  readonly dataDir: string;
  /** Every environment the runtime holds, when one is up. */
  readonly envs?: readonly EnvCount[];
  readonly now?: number;
  /** The address people reach this forge at, named in the drill commands. */
  readonly forgeUrl?: string;
  /** Reads the disk under `dataDir`; `statDisk` unless a test gives it a reading. */
  readonly disk?: (dir: string) => DiskReading;
  /** The free-disk share below which the disk is a need; `DISK_FREE_MIN` unless a test says. */
  readonly diskFreeMin?: number;
  /** One forge's own signals (`App.signals`). */
  readonly signals: { errors: ErrorLedger; refused: RefusedLedger };
  /** Where snapshots go: the directory, when the store is one, and whether an off-box mirror copies them. */
  readonly snapshots?: { readonly dir?: string; readonly mirrored: boolean } | undefined;
}

/** The device a path lives on, read from it or its nearest parent that exists. */
function deviceOf(path: string): number | undefined {
  for (let at = path; ; at = dirname(at)) {
    try {
      return statSync(at).dev;
    } catch {
      if (dirname(at) === at) return undefined;
    }
  }
}

/** Whether two paths live on one volume: what loses one loses the other. */
export function sharesVolume(a: string, b: string): boolean {
  const da = deviceOf(a);
  return da !== undefined && da === deviceOf(b);
}

/**
 * Per forge (keyed by its error ledger, one per `App.signals`): cause → when
 * it was first seen; a cause that clears is dropped.
 * Stamped from the real clock, never from `input.now`: a caller asking about
 * another instant must not move when a cause began.
 */
const firstSeenByForge = new WeakMap<ErrorLedger, Map<string, string>>();

/** When a cause began as a person says it: "just now", "12 min ago", "3 h ago", else the day. */
export function sinceWords(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const minutes = Math.max(0, Math.floor((now - t) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return iso.slice(0, 10);
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

/**
 * The lane's one sentence, with its cause: how many wait, since when, and
 * what the lane is doing — "22 checks wait behind one lane; the oldest since
 * 04:13; the lane runs #1212 for 31 min (limit 60)".
 */
export function laneSentence(
  queued: number,
  oldest: string,
  lane: Lane,
  now: number,
): string {
  const since = new Date(oldest).toISOString().slice(11, 16);
  const head = `${queued} check${queued === 1 ? "" : "s"} ${queued === 1 ? "waits" : "wait"} behind one lane; the oldest since ${since}`;
  if (lane.running === null) return `${head}; the lane runs nothing.`;
  const age = Math.max(
    0,
    Math.round((now - new Date(lane.running.since).getTime()) / 60_000),
  );
  const what = lane.running.pull === null ? "a check" : `#${lane.running.pull}`;
  return `${head}; the lane runs ${what} for ${age} min (limit ${BUDGETS.gate / 60_000}).`;
}

export function vitals(input: VitalsInput): Vitals {
  const now = input.now ?? Date.now();
  const at = new Date(now).toISOString();
  const needs: string[] = [];
  const degraded: Degraded[] = [];
  let firstSeen = firstSeenByForge.get(input.signals.errors);
  if (!firstSeen) firstSeenByForge.set(input.signals.errors, (firstSeen = new Map()));
  const need = (
    cause: string,
    sentence: string,
    evidence: string | undefined,
    href: string,
  ) => {
    let since = firstSeen.get(cause);
    if (since === undefined || (evidence !== undefined && evidence < since)) {
      since = evidence ?? new Date().toISOString();
      firstSeen.set(cause, since);
    }
    needs.push(sentence);
    degraded.push({ cause, sentence, since, href });
  };

  const disk = (input.disk ?? statDisk)(input.dataDir);
  if (disk.totalBytes > 0 && disk.freeBytes / disk.totalBytes < (input.diskFreeMin ?? DISK_FREE_MIN))
    need(
      "disk",
      `Disk is nearly full: ${Math.round((disk.freeBytes / disk.totalBytes) * 100)}% free.`,
      undefined,
      "/settings/capacity",
    );

  // Snapshots on the volume they copy, and no mirror, share its one point of failure.
  const snaps = input.snapshots;
  if (
    snaps?.dir !== undefined &&
    !snaps.mirrored &&
    sharesVolume(input.dataDir, snaps.dir)
  )
    need("snapshots", SNAPSHOTS_ON_STATE_VOLUME, undefined, "/settings/backups");

  const running = listRunning(input.db);
  const lane = readLane(input.db, running, now);
  const queue: Record<string, number> = {};
  for (const row of queueDepth(input.db, now)) {
    queue[row.kind] = row.queued;
    const waited = now - new Date(row.oldest).getTime();
    if (row.kind === "check" && waited > BUDGETS.laneWait)
      need(
        "queue:check",
        laneSentence(row.queued, row.oldest, lane, now),
        new Date(row.oldest).toISOString(),
        "/settings/capacity",
      );
    else if (row.kind !== "check" && waited > QUEUE_WAIT_MAX_MS)
      need(
        `queue:${row.kind}`,
        `The ${row.kind} queue has waited over ${QUEUE_WAIT_MAX_MS / 60_000} minutes.`,
        new Date(row.oldest).toISOString(),
        "/settings/capacity",
      );
  }

  const stuck: Vitals["stuck"] = [];
  for (const { run, repo, issue } of running) {
    const started = new Date(run.startedAt ?? run.createdAt).getTime();
    if (
      leaseLapsed(run, BUDGETS.heartbeat, now) ||
      now - started > NO_PROGRESS_MS
    )
      stuck.push({
        runId: run.id,
        repo,
        issue,
        since: run.heartbeatAt ?? run.startedAt ?? run.createdAt,
      });
  }
  for (const s of stuck)
    need(
      `stuck:${s.runId}`,
      now - new Date(s.since).getTime() > BUDGETS.heartbeat &&
      now - new Date(s.since).getTime() < 24 * 3_600_000
        ? `Run ${s.runId} is stuck: no heartbeat for ${Math.round((now - new Date(s.since).getTime()) / 60_000)} min (limit ${BUDGETS.heartbeat / 60_000}).`
        : `Run ${s.runId} is stuck: it has not moved ${sinceWords(s.since, now)}.`,
      s.since,
      `/${s.repo}/runs/${s.runId}`,
    );

  // A run killed twice for its budget is a card, for a day.
  for (const run of budgetFailures(
    input.db,
    new Date(now - 24 * 3_600_000).toISOString(),
  ))
    need(
      `budget:${run.id}`,
      `A run was killed twice: ${run.summary}.`,
      run.finishedAt ?? undefined,
      "/settings/capacity",
    );

  // A red main holding its pulls' checks is one card, naming the test.
  for (const { red, held } of heldChecks(input.db))
    need(
      `red:${red.repoId}`,
      redSentence(red, held),
      red.since,
      `/${red.repo}/runs/${red.runId}`,
    );

  // A test failing on many pulls in the hour is one card, not a park per pull.
  for (const shared of sharedTests(input.db, now))
    need(sharedCause(shared), sharedSentence(shared), shared.since, flakeHref(input.db, shared));

  // A red restore drill, or none in eight days, is a card until a drill passes.
  const drill = lastVerdict(input.dataDir);
  const owed = drillNeed(drill, now, () => drillFirstSeen(input.dataDir));
  if (owed !== undefined)
    need("drill", owed.sentence, owed.since, "/settings/backups");

  // A domain whose drill is red or eight days old is a card with the command that runs it.
  for (const owed of domainDrillNeeds(
    newestDrills(input.db),
    now,
    drillFirstSeen(input.dataDir),
    input.forgeUrl ?? "http://localhost",
    DOMAINS,
  ))
    need(owed.cause, owed.sentence, owed.since, "/");

  // A snapshot that failed is a card from that morning until one lands.
  const failing = snapshotNeed(lastSnapshotOutcome(input.dataDir));
  if (failing !== undefined) need("snapshot-failed", failing.sentence, failing.since, "/settings/backups");

  // A snapshot that did not land off the box, or a mirror a day behind, is a card until it does.
  const behind = mirrorNeed(lastMirror(input.dataDir), now);
  if (behind !== undefined) need("mirror", behind.sentence, behind.since, "/settings/backups");

  // A release the forge could not prove against its own public URL is a card until a release does.
  const unproven = proofNeed(input.dataDir);
  if (unproven !== undefined) need("release", unproven.sentence, unproven.since, "/board");

  // Production serving a version older than a release main has had over an hour is a card until they match.
  const lagging = behindStanding(now);
  if (lagging !== undefined) need("release:behind", `${lagging.sentence}.`, lagging.since, "/board");

  const apps = { serving: 0, asleep: 0, previews: 0 };
  for (const e of input.envs ?? []) {
    if (e.env !== "production") apps.previews++;
    else if (e.state === "asleep") apps.asleep++;
    else if (e.state === "running") apps.serving++;
  }

  const seen = recentErrors(5, now, input.signals.errors);
  if (seen.lastHour >= ERROR_BURST)
    need(
      "errors",
      `${seen.lastHour} errors in the last hour (${ERROR_BURST} or more is a burst).`,
      seen.oldest,
      "/settings/capacity#errors",
    );

  const refused = refusedInternal(now, input.signals.refused);
  if (refused.lastHour > 0)
    need(
      "internal",
      `${refused.lastHour} internal call${refused.lastHour === 1 ? "" : "s"} without the boot secret refused in the last hour${refused.latest ? ` (latest ${refused.latest.method} ${refused.latest.path})` : ""}.`,
      refused.oldest,
      "/settings/capacity#internal",
    );

  for (const cause of firstSeen.keys())
    if (!degraded.some((d) => d.cause === cause)) firstSeen.delete(cause);

  return {
    ok: needs.length === 0,
    needs,
    degraded,
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
    at,
  };
}
