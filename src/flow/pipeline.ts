/**
 * The forge's pipeline as stages, read from what it already keeps (runs,
 * issues, pulls, reviews): how much is in each stage now, how long its
 * oldest waiting item has waited, and the capacity that limits it (#1554).
 * The stage whose oldest waiting item has waited longest is the bottleneck.
 *
 * Beside `stage.ts`, which follows one repository's issues, this is the
 * forge's work as a whole: runs queued and running, against the capacity
 * that limits them.
 *
 * A stage holds items that are *waiting* (queued for the next worker) and
 * items that are *active* (being worked). Only waiting items can make a
 * stage the bottleneck: a check that takes twenty minutes is working, a
 * check that waits twenty minutes to start is the limit.
 *
 * Pure data, forge-wide, no authorization: `/flow` is a forge admin's.
 */

import type { Database } from "bun:sqlite";
import { capacityValue } from "../core/capacity.ts";

export const PIPELINE = [
  "ready",
  "building",
  "check-queue",
  "checking",
  "review",
  "approved",
  "landed",
  "live",
] as const;
export type PipelineKey = (typeof PIPELINE)[number];

export const STAGE_LABEL: Record<PipelineKey, string> = {
  ready: "Ready",
  building: "Building",
  "check-queue": "Check queue",
  checking: "Checking",
  review: "Review",
  approved: "Approved",
  landed: "Landed",
  live: "Live",
};

/** What each stage holds, in one line under its name. */
export const STAGE_HOLDS: Record<PipelineKey, string> = {
  ready: "Open, unblocked issues in autonomous repositories with nothing in flight on them",
  building: "Agent runs (not reviews), queued for a builder or running",
  "check-queue": "Checks queued to start",
  checking: "Checks running",
  review: "Review runs, queued for a reviewer or running",
  approved: "Open pulls whose latest verdict is an approval, waiting to land",
  landed: "Pulls merged into an app's default branch in the last week with no production deploy since",
  live: "Production deploys that went live in the last 24 hours",
};

export interface PipelineStage {
  readonly key: PipelineKey;
  /** Queued for the next worker. */
  readonly waiting: number;
  /** Being worked, or (live) done. */
  readonly active: number;
  /** When the oldest waiting item entered the stage, or null when nothing waits. */
  readonly oldestWaiting: string | null;
  /** What limits the stage, in words ("crew runs at once 2"), or null when nothing in the forge does. */
  readonly capacity: string | null;
}

const DAY_MS = 24 * 3_600_000;

interface Tally {
  waiting: number;
  active: number;
  oldest: string | null;
}

/** Runs of `kind` in flight; queued ones paused on a limit (`not_before` ahead) are not waiting for a worker. */
function runTally(db: Database, kind: string, where: string, now: string): Tally {
  return db
    .query<Tally, [string, string]>(
      `SELECT COALESCE(SUM(state = 'queued'), 0) AS waiting,
              COALESCE(SUM(state = 'running'), 0) AS active,
              MIN(CASE WHEN state = 'queued' THEN created_at END) AS oldest
         FROM run
        WHERE kind = ?1 AND state IN ('queued','running')
          AND (state = 'running' OR not_before IS NULL OR not_before <= ?2)
          AND ${where}`,
    )
    .get(kind, now) ?? { waiting: 0, active: 0, oldest: null };
}

/**
 * How long a waiting stage's count is reused. The ready count walks every open
 * issue with its blockers and runs (1.6 s on production, 2026-11-13) and was
 * asked for about fifteen times a minute by health, flow, the crew tick and
 * every open screen: 48 of every 120 seconds of the forge's one thread. The
 * stage a person looks at changes by the minute, not the second. Off under
 * `bun test` (NODE_ENV=test), where a test writes a row and reads the count.
 */
export const WAITING_REUSE_MS = process.env["NODE_ENV"] === "test" ? 0 : 20_000;

const waitingKept = new WeakMap<Database, Map<string, { at: number; tally: Tally }>>();

/** Rows that all wait: `since` is when each entered the stage. */
function waitingTally(db: Database, sql: string, ...args: string[]): Tally {
  if (WAITING_REUSE_MS === 0) return countWaiting(db, sql, ...args);
  let kept = waitingKept.get(db);
  if (kept === undefined) waitingKept.set(db, (kept = new Map()));
  // A `since` cutoff argument moves every call; the stage, not the instant, is the key.
  const hit = kept.get(sql);
  const now = Date.now();
  if (hit !== undefined && now - hit.at < WAITING_REUSE_MS) return hit.tally;
  const tally = countWaiting(db, sql, ...args);
  kept.set(sql, { at: now, tally });
  return tally;
}

function countWaiting(db: Database, sql: string, ...args: string[]): Tally {
  const r = db
    .query<{ n: number; oldest: string | null }, string[]>(
      `SELECT COUNT(*) AS n, MIN(since) AS oldest FROM (${sql})`,
    )
    .get(...args);
  return { waiting: r?.n ?? 0, active: 0, oldest: r?.oldest ?? null };
}

// CROSS JOIN keeps SQLite's order: the repositories that run themselves, then
// their open issues by `issue_repo_kind_state_number`, never every issue
// (#7896); and the ask's runs, their branch's pulls by `pull_head_branch`,
// then each pull's issue, never every open issue (#3693).
//
// `since` is when the issue became ready, not when it was opened (#11834): the
// latest of its opening, the close of a blocker that held it, and the end of
// the last agent run on it. An old issue whose blocker closed an hour ago has
// waited an hour for a builder, not fifty-six days.
const READY = `
  SELECT MAX(i.created_at,
             COALESCE((SELECT MAX(b.closed_at) FROM issue_dependency d JOIN issue b ON b.id = d.blocked_by_id
                        WHERE d.issue_id = i.id), ''),
             COALESCE((SELECT MAX(COALESCE(x.finished_at, x.created_at)) FROM run x
                        WHERE x.issue_id = i.id AND x.kind = 'agent'), '')) AS since
    FROM repo r CROSS JOIN issue i ON i.repo_id = r.id
   WHERE i.kind = 'issue' AND i.state = 'open' AND r.autonomy != 'off'
     AND (r.direction_issue_id IS NULL OR r.direction_issue_id != i.id)
     AND NOT EXISTS (SELECT 1 FROM issue_dependency d JOIN issue b ON b.id = d.blocked_by_id
                      WHERE d.issue_id = i.id AND b.state = 'open')
     AND NOT EXISTS (SELECT 1 FROM run x WHERE x.issue_id = i.id AND x.kind = 'agent'
                      AND x.state IN ('queued','running'))
     AND NOT EXISTS (SELECT 1 FROM run x CROSS JOIN pull p ON p.head_branch = x.branch
                       CROSS JOIN issue pi ON pi.id = p.issue_id AND pi.repo_id = x.repo_id
                      WHERE x.issue_id = i.id AND x.kind = 'agent' AND x.branch != ''
                        AND pi.state = 'open')`;

const APPROVED = `
  SELECT v.created_at AS since
    FROM issue i JOIN pull p ON p.issue_id = i.id
    JOIN review v ON v.id = (SELECT id FROM review WHERE issue_id = i.id AND state != 'commented'
                              ORDER BY created_at DESC, id DESC LIMIT 1)
   WHERE i.state = 'open' AND v.state = 'approved'`;

const LANDED = `
  SELECT p.merged_at AS since
    FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
    JOIN app a ON a.repo_id = r.id
   WHERE p.merged_at >= ?1 AND p.base_branch = r.default_branch
     AND NOT EXISTS (SELECT 1 FROM run d WHERE d.repo_id = r.id AND d.kind = 'deploy'
                      AND d.env = 'production' AND d.created_at >= p.merged_at)`;

function liveTally(db: Database, since: string): Tally {
  const r = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM run
        WHERE kind = 'deploy' AND env = 'production' AND serving_at >= ?1`,
    )
    .get(since);
  return { waiting: 0, active: r?.n ?? 0, oldest: null };
}

function tally(db: Database, key: PipelineKey, now: Date): Tally {
  const iso = now.toISOString();
  switch (key) {
    case "ready":
      return waitingTally(db, READY);
    case "building":
      return runTally(db, "agent", "reason != 'review'", iso);
    case "check-queue":
      return runTally(db, "check", "state = 'queued'", iso);
    case "checking":
      return runTally(db, "check", "state = 'running'", iso);
    case "review":
      return runTally(db, "agent", "reason = 'review'", iso);
    case "approved":
      return waitingTally(db, APPROVED);
    case "landed":
      return waitingTally(db, LANDED, new Date(now.getTime() - 7 * DAY_MS).toISOString());
    case "live":
      return liveTally(db, new Date(now.getTime() - DAY_MS).toISOString());
  }
}

/** The autonomous repositories' slots added up, and how many repositories. */
function slots(db: Database): { slots: number; repos: number } {
  const r = db
    .query<{ slots: number | null; repos: number }, []>(
      `SELECT SUM(autonomy_slots) AS slots, COUNT(*) AS repos FROM repo WHERE autonomy != 'off'`,
    )
    .get();
  return { slots: r?.slots ?? 0, repos: r?.repos ?? 0 };
}

const auto = (v: string) => (v === "" ? "auto" : v);

/** What limits each stage, read now: the capacity settings and the repositories' slots. */
function capacities(db: Database): Record<PipelineKey, string | null> {
  const crew = `crew runs at once ${auto(capacityValue(db, "crew.concurrency"))}`;
  const checks = `checks at once ${auto(capacityValue(db, "checks.concurrency"))}`;
  const s = slots(db);
  return {
    ready: `${s.slots} slot${s.slots === 1 ? "" : "s"} in ${s.repos} autonomous ${s.repos === 1 ? "repository" : "repositories"}`,
    building: crew,
    "check-queue": checks,
    checking: checks,
    review: crew,
    approved: null,
    landed: null,
    live: null,
  };
}

/** Every stage, left to right, as it is now. */
export function readPipeline(db: Database, now = new Date()): PipelineStage[] {
  const cap = capacities(db);
  return PIPELINE.map((key) => {
    const t = tally(db, key, now);
    return {
      key,
      waiting: t.waiting,
      active: t.active,
      oldestWaiting: t.oldest,
      capacity: cap[key],
    };
  });
}

/** The stage whose oldest waiting item has waited longest; undefined when nothing waits. */
export function bottleneck(stages: readonly PipelineStage[]): PipelineStage | undefined {
  let worst: PipelineStage | undefined;
  for (const s of stages)
    if (
      s.oldestWaiting !== null &&
      (worst?.oldestWaiting == null || s.oldestWaiting < worst.oldestWaiting)
    )
      worst = s;
  return worst;
}

/** A span of milliseconds as a person reads it: 45s, 12m, 3h 5m, 2d 4h. */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** How long a stage's oldest waiting item has waited, or null when nothing waits. */
export const waited = (s: PipelineStage, now: number): string | null =>
  s.oldestWaiting === null ? null : span(now - Date.parse(s.oldestWaiting));

/** The one sentence naming the bottleneck, or saying nothing waits: the page, the terminal and MCP all say this. */
export function verdict(stages: readonly PipelineStage[], now = Date.now()): string {
  const worst = bottleneck(stages);
  if (worst === undefined) return "Nothing is waiting: every stage is empty or being worked.";
  const n = worst.waiting;
  return `${STAGE_LABEL[worst.key]} is the bottleneck: its oldest has waited ${waited(worst, now) ?? ""}, ${n} ${n === 1 ? "waits" : "wait"}${worst.capacity === null ? "" : `, ${worst.capacity}`}.`;
}

/** The window the per-step numbers are read over (#7784). */
export const STEP_WINDOW_DAYS = 30;

/** One measured step of the path: what it is, and how long and how often red it has been. */
export interface StepStat {
  readonly key: "pull-check" | "review" | "gate" | "main-check" | "release" | "boot" | "verify";
  readonly label: string;
  /** Finished runs counted (green + red); cancelled ones are no verdict and not counted. */
  readonly runs: number;
  readonly failed: number;
  /** Median of finished − started, in ms; null when nothing finished or the step keeps no trace. */
  readonly medianMs: number | null;
  /** failed / runs, or null with no runs. */
  readonly redRate: number | null;
  /** Why there is no number, when there is none to read. */
  readonly note: string | null;
  /** What a red outcome means for this step: a check that failed is "red"; a review run that failed "errored" (a changes-asked verdict is not counted here). */
  readonly redWord: "red" | "errored";
}

interface Timed {
  state: string;
  ms: number | null;
}

/** Median of the sorted middle: the mean of the two middle values for an even count. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

function stat(key: StepStat["key"], label: string, rows: readonly Timed[], note: string | null = null): StepStat {
  const done = rows.filter((r) => r.state === "ok" || r.state === "failed");
  const failed = done.filter((r) => r.state === "failed").length;
  const times = done.flatMap((r) => (r.ms !== null && r.ms >= 0 ? [r.ms] : []));
  return {
    key,
    label,
    runs: done.length,
    failed,
    medianMs: median(times),
    redRate: done.length === 0 ? null : failed / done.length,
    note,
    redWord: "red",
  };
}

const MS = `(julianday(x.finished_at) - julianday(x.started_at)) * 86400000.0`;

/**
 * Each step's median time and red rate over the last 30 days, from the runs
 * table (`run`) and the merge-queue gate's trace (`check_gate`,
 * kept a week and without a verdict, so time only). `publicOnly` reads public
 * repositories alone, for a reader who must not learn what private ones hold.
 *
 *   time = finished_at − started_at; red rate = failed ÷ (ok + failed)
 */
export function readStepStats(db: Database, now = new Date(), publicOnly = false): StepStat[] {
  const since = new Date(now.getTime() - STEP_WINDOW_DAYS * DAY_MS).toISOString();
  const vis = publicOnly ? `AND r.visibility = 'public'` : "";
  const runs = (from: string, where: string): Timed[] =>
    db
      .query<Timed, [string]>(
        `SELECT x.state AS state, CASE WHEN x.started_at IS NULL THEN NULL ELSE ${MS} END AS ms
           FROM ${from} x JOIN repo r ON r.id = x.repo_id
          WHERE x.finished_at >= ?1 AND x.state IN ('ok','failed') ${vis} AND ${where}`,
      )
      .all(since);
  const verifyLane = `x.env IN ('verify','verify-bisect')`;
  const gate = db
    .query<{ ms: number }, [string]>(
      `SELECT ${MS} AS ms FROM check_gate x JOIN repo r ON r.id = x.repo_id
        WHERE x.finished_at IS NOT NULL AND x.finished_at >= ?1 ${vis}`,
    )
    .all(since);
  const gateStat = stat("gate", "Merge-queue gate", []);
  return [
    stat("pull-check", "Pull check", runs("run", `x.kind = 'check' AND x.issue_id IS NOT NULL AND NOT ${verifyLane}`)),
    { ...stat("review", "Review run", runs("run", `x.kind = 'agent' AND x.reason = 'review'`)), redWord: "errored" },
    {
      ...gateStat,
      runs: gate.length,
      medianMs: median(gate.map((g) => g.ms)),
      note: "time only: the gate keeps no verdict, and only the last week",
    },
    stat("main-check", "Main's check", runs("run", `x.kind = 'check' AND x.issue_id IS NULL AND x.env = r.default_branch`)),
    stat("release", "Release build", runs("run", `x.kind = 'deploy' AND x.env = 'production'`)),
    {
      ...stat("boot", "Boot check", []),
      note: "runs inside the release build: a failed boot is a failed release build",
    },
    stat("verify", "Verify", runs("run", `x.kind = 'check' AND ${verifyLane}`)),
  ];
}

/** A step as a figure and a note under it: "8m" over "25% red (1 of 4)", or "—" over why there is no number. */
export function statParts(s: StepStat): { value: string; note: string } {
  const value = s.medianMs === null ? "—" : span(s.medianMs);
  if (s.medianMs === null && s.redRate === null) return { value, note: s.note ?? `no runs in the last ${STEP_WINDOW_DAYS} days` };
  const red = s.redRate === null ? (s.note ?? "no verdict kept") : `${Math.round(s.redRate * 100)}% ${s.redWord} (${s.failed} of ${s.runs})`;
  return { value, note: red };
}

/** "median 12m · 8% red (1 of 12)", or why there is no number: the terminal and MCP say this. */
export function statWords(s: StepStat): string {
  const p = statParts(s);
  return s.medianMs === null && s.redRate === null ? p.note : `median ${p.value} · ${p.note}`;
}

const stepCache = new WeakMap<Database, { minute: number; publicOnly: boolean; stats: StepStat[] }>();

/** `readStepStats` held for the minute it was read in, per database: the open page runs it at most once a minute, however often it is asked. */
export function cachedStepStats(db: Database, now = new Date(), publicOnly = false): StepStat[] {
  const minute = Math.floor(now.getTime() / 60_000);
  const kept = stepCache.get(db);
  if (kept !== undefined && kept.minute === minute && kept.publicOnly === publicOnly) return kept.stats;
  const stats = readStepStats(db, now, publicOnly);
  stepCache.set(db, { minute, publicOnly, stats });
  return stats;
}
