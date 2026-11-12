/**
 * A run's displayed state, worked out from what it did and never reported by
 * the run itself (#8707, after Linear's agent sessions). One function: the
 * row's state, how long since it last acted, and whether its plan asks a
 * person something.
 *
 *   waiting      queued, not started
 *   working      running and heard from lately
 *   needs input  its plan asks a person a question
 *   failed       ended failed
 *   done         ended ok, or cancelled
 *   silent       running and nothing seen for `SILENT_MS`
 */

import type { Database } from "bun:sqlite";
import { getIssuePlan, getIssuePlans } from "../core/issue_plans.ts";
import type { Run } from "../core/runs.ts";
import { lastActivity } from "./activity.ts";

export const SILENT_MS = 10 * 60_000;

export const SHOWN_STATES = ["waiting", "working", "needs input", "failed", "done", "silent"] as const;
export type ShownState = (typeof SHOWN_STATES)[number];

export interface StateFacts {
  readonly now: Date;
  /** The run's plan asks a person something. */
  readonly asking?: boolean;
  /** When the run last acted (ms); the log's own clock when left out. */
  readonly lastActivityAt?: number | undefined;
}

/** The ms instant a running run was last seen to act: its log, else its start. */
export function activityOf(run: Run, seen?: number | undefined): number {
  const started = Date.parse(run.startedAt ?? run.createdAt);
  return Math.max(started, seen ?? lastActivity(run.id) ?? 0);
}

export function runState(run: Run, facts: StateFacts): ShownState {
  switch (run.state) {
    case "failed":
      return "failed";
    case "ok":
    case "cancelled":
      return "done";
    case "queued":
      return facts.asking === true ? "needs input" : "waiting";
    case "running":
      if (facts.asking === true) return "needs input";
      return facts.now.getTime() - activityOf(run, facts.lastActivityAt) > SILENT_MS ? "silent" : "working";
  }
}

/** The state to show for `run`, reading its plan for a question when it is still going. */
export function shownState(db: Database, run: Run, now: Date = new Date()): ShownState {
  const going = run.state === "queued" || run.state === "running";
  const plan = going && run.kind === "agent" && run.issueId !== null ? getIssuePlan(db, run.issueId) : undefined;
  return runState(run, { now, asking: plan !== undefined && plan.ask !== "" && plan.runId === run.id });
}

/**
 * The state to show for each of `runs`, with one read of the plans of the
 * issues that still-going agent runs are on, not one per row.
 */
export function shownStates(db: Database, runs: readonly Run[], now: Date = new Date()): Map<string, ShownState> {
  const ids = [
    ...new Set(
      runs.flatMap((r) =>
        (r.state === "queued" || r.state === "running") && r.kind === "agent" && r.issueId !== null ? [r.issueId] : [],
      ),
    ),
  ];
  const plans = getIssuePlans(db, ids);
  const out = new Map<string, ShownState>();
  for (const r of runs) {
    const plan = r.issueId === null ? undefined : plans.get(r.issueId);
    const asking = plan !== undefined && plan.ask !== "" && plan.runId === r.id;
    out.set(r.id, runState(r, { now, asking }));
  }
  return out;
}
