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
 *
 * The checks counted are the rebases' own, not every check (#6140): a
 * rebase's check goes before any other in the lane (`checks/
 * finishing_first.ts`), so a new build's check does not stand in front of
 * it. Counting those let new builds keep the room at one, and 64 approved
 * pulls drained one at a time.
 */

import type { Database } from "bun:sqlite";
import { rebasesFirst } from "../checks/finishing_first.ts";
import { capacityValue } from "../core/capacity.ts";
import { listActive } from "../core/runs.ts";

export function conflictRoom(
  /** Checks the forge runs at once (`checks.concurrency`). */
  slots: number,
  /** Rebases' check runs queued or running: the ones ahead of the next. */
  checks: number,
  /** Bring-up-to-date runs queued or running. */
  inFlight: number,
): number {
  const room = slots - checks - inFlight;
  return Math.max(room, inFlight === 0 ? 1 : 0);
}

/** What the lane holds for rebases now, and the room left: the tick line's and /flow's words (#6140). */
export interface ConflictLane {
  /** Bring-up-to-date runs queued or running. */
  readonly runs: number;
  /** Rebases' checks queued or running. */
  readonly checks: number;
  readonly room: number;
}

/** The lane from what the forge holds now. */
export function readConflictLane(db: Database): ConflictLane {
  const runs = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM run
        WHERE kind = 'agent' AND reason = 'conflict' AND state IN ('queued','running')`,
    )
    .get()!.n;
  const checks = rebasesFirst(db, listActive(db, "check")).rebases.length;
  const slots = Number(capacityValue(db, "checks.concurrency"));
  return { runs, checks, room: conflictRoom(Number.isInteger(slots) && slots > 0 ? slots : 1, checks, runs) };
}

/** `conflictRoom` from what the forge holds now. */
export function readConflictRoom(db: Database): number {
  return readConflictLane(db).room;
}
