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

/** Rows that all wait: `since` is when each entered the stage. */
function waitingTally(db: Database, sql: string, ...args: string[]): Tally {
  const r = db
    .query<{ n: number; oldest: string | null }, string[]>(
      `SELECT COUNT(*) AS n, MIN(since) AS oldest FROM (${sql})`,
    )
    .get(...args);
  return { waiting: r?.n ?? 0, active: 0, oldest: r?.oldest ?? null };
}

const READY = `
  SELECT i.created_at AS since
    FROM issue i JOIN repo r ON r.id = i.repo_id
   WHERE i.kind = 'issue' AND i.state = 'open' AND r.autonomy != 'off'
     AND (r.direction_issue_id IS NULL OR r.direction_issue_id != i.id)
     AND NOT EXISTS (SELECT 1 FROM issue_dependency d JOIN issue b ON b.id = d.blocked_by_id
                      WHERE d.issue_id = i.id AND b.state = 'open')
     AND NOT EXISTS (SELECT 1 FROM run x WHERE x.issue_id = i.id AND x.kind = 'agent'
                      AND x.state IN ('queued','running'))
     AND NOT EXISTS (SELECT 1 FROM run x JOIN pull p ON p.head_branch = x.branch
                       JOIN issue pi ON pi.id = p.issue_id AND pi.repo_id = x.repo_id
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
