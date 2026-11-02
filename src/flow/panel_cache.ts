/**
 * The flow panel's figures, kept per database so a second `/boards` load reads none
 * of them again. A value holds while the write clock (`core/write_clock.ts`) stands
 * still, and for 30 s at most (the figures are windows of time, so they age too).
 * Kept apart by who asks: an agent's public-only answer is never an admin's.
 * Read it only after the viewer's rights are known.
 */

import type { Database } from "bun:sqlite";
import { writeStamp } from "../core/write_clock.ts";
import { conflictedPulls, rebaseLane, type ConflictedPull, type RebaseLane } from "./conflicted.ts";
import { readPile, type Pile } from "./pile.ts";
import { reviewersBusy, type ReviewerLoad } from "./reviewing.ts";
import { requestedWaits, type RequestedWaits } from "./requested.ts";
import { idlePullsCached, type IdlePull } from "./idle_pulls.ts";
import { readParked, type Parked } from "./parked.ts";
import { readLeadTime, type LeadTime } from "./lead_time.ts";
import { readBuildYield, type BuildYield } from "./build_yield.ts";
import { readReviewLatency, type ReviewLatency } from "./review_latency.ts";
import { readOpeners, type Opener } from "./openers.ts";

export const PANEL_TTL_MS = 30_000;

/** Who is asking: an `agent` sees public repositories only; the `owner` sees all. */
export type PanelViewer = "owner" | "agent";

export interface PanelFigures {
  readonly pile: Pile;
  readonly conflicted: ConflictedPull[];
  readonly lane: RebaseLane;
  readonly requested: RequestedWaits;
  readonly reviewing: ReviewerLoad[];
  readonly idle: IdlePull[];
  readonly parked: Parked;
  readonly lead: LeadTime;
  readonly yielded: BuildYield;
  readonly latency: ReviewLatency | null;
  readonly openers: Opener[];
}

/** Every reader the panel's figures come from, run once. */
export function readPanelFigures(db: Database, now: Date, publicOnly: boolean): PanelFigures {
  const conflicted = conflictedPulls(db, publicOnly);
  return {
    pile: readPile(db, publicOnly),
    conflicted,
    lane: rebaseLane(db, conflicted),
    requested: requestedWaits(db, publicOnly),
    reviewing: reviewersBusy(db, publicOnly),
    idle: idlePullsCached(db, now, publicOnly),
    parked: readParked(db, now, publicOnly),
    lead: readLeadTime(db, now, publicOnly),
    yielded: readBuildYield(db, now, publicOnly),
    latency: readReviewLatency(db, now, publicOnly),
    openers: readOpeners(db, now, publicOnly),
  };
}

interface Entry {
  readonly at: number;
  readonly stamp: string;
  readonly figures: PanelFigures;
}

const kept = new WeakMap<Database, Map<PanelViewer, Entry>>();

/** The panel's figures for `viewer`: the kept ones while nothing was written and under 30 s old. */
export function panelFigures(db: Database, viewer: PanelViewer, now = new Date()): PanelFigures {
  const mine = kept.get(db) ?? new Map<PanelViewer, Entry>();
  kept.set(db, mine);
  const stamp = writeStamp(db);
  const t = now.getTime();
  const hit = mine.get(viewer);
  if (stamp !== undefined && hit && hit.stamp === stamp && t >= hit.at && t - hit.at < PANEL_TTL_MS) return hit.figures;
  const figures = readPanelFigures(db, now, viewer !== "owner");
  if (stamp === undefined) mine.delete(viewer);
  else mine.set(viewer, { at: t, stamp, figures });
  return figures;
}
