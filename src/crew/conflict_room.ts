/**
 * How many bring-up-to-date runs the conflict sweep may start now (#4459).
 *
 * Each one ends in a push, and every push is a full check. When a landing
 * touches a file many open pulls share (docs/DESIGN.md §5d), it conflicts
 * all of them at once: one tick queued 17 conflict runs, and their 17
 * checks went into the lane together, so the oldest waited past its
 * budget, and the load made the checks flake into retries. Main often
 * moved again before they finished, which conflicted the same pulls once
 * more.
 *
 * So the sweep starts a run only when the lane has a slot for the check
 * it will push: check slots, minus the checks queued and running, minus
 * the conflict runs already in flight (each of those will push one). One
 * run in flight is always allowed, so a busy lane slows the sweep but
 * never stops it. A pull left out waits for a later tick, and if main
 * moves meanwhile, one merge brings it past both landings.
 *
 * The finishing pass (`finishing.ts`) asks the same room for approved
 * pulls: it queues before the sweep, and the sweep counts its runs as in
 * flight, so between them a tick never starts more than the lane holds
 * (#4784).
 */

import type { Database } from "bun:sqlite";
import { capacityValue } from "../core/capacity.ts";

export function conflictRoom(
  /** Checks the forge runs at once (`checks.concurrency`). */
  slots: number,
  /** Check runs queued or running. */
  checks: number,
  /** Bring-up-to-date runs queued or running. */
  inFlight: number,
): number {
  const room = slots - checks - inFlight;
  return Math.max(room, inFlight === 0 ? 1 : 0);
}

/** `conflictRoom` from what the forge holds now. */
export function readConflictRoom(db: Database): number {
  const row = db
    .query<{ checks: number; conflicts: number }, []>(
      `SELECT
         COALESCE(SUM(kind = 'check'), 0) AS checks,
         COALESCE(SUM(kind = 'agent' AND reason = 'conflict'), 0) AS conflicts
       FROM run WHERE state IN ('queued','running')`,
    )
    .get();
  const slots = Number(capacityValue(db, "checks.concurrency"));
  return conflictRoom(
    Number.isInteger(slots) && slots > 0 ? slots : 1,
    row?.checks ?? 0,
    row?.conflicts ?? 0,
  );
}
