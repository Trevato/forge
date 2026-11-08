/**
 * The queued agent runs the dispatcher chose not to start on its last pass,
 * and which policy held each: a shut valve, the week's pace, an account at its
 * limit. Policy, not a fault: vitals leaves them out of "the agent queue has
 * waited" and names how many each cause holds (#9403), as it leaves out the
 * checks a red main holds.
 *
 * Process memory, per database, replaced whole by each dispatcher pass: the
 * one place the dispatcher and vitals share state. A pass older than
 * `HELD_FRESH_MS` is ignored, so a dispatcher that stopped cannot hide its
 * queue behind the last thing it said.
 */

import type { Database } from "bun:sqlite";

/** A dispatcher pass runs every 5 s; one not heard from in two minutes has stopped. */
export const HELD_FRESH_MS = 2 * 60_000;

/** Why the dispatcher held a run. */
export type HoldCause = "valve" | "pace" | "limit";

/** How vitals names each cause: "2 by a shut valve". */
export const HOLD_WORDS: Readonly<Record<HoldCause, string>> = {
  valve: "a shut valve",
  pace: "the week's pace",
  limit: "an account limit",
};

interface Pass {
  readonly at: number;
  readonly held: ReadonlyMap<string, HoldCause>;
}

const passes = new WeakMap<Database, Pass>();

/** One pass's holds, replacing the last: run id → the policy that held it. */
export function noteHeld(db: Database, held: ReadonlyMap<string, HoldCause>, at = Date.now()): void {
  passes.set(db, { at, held: new Map(held) });
}

/** The holds of the latest pass, when it is fresh; empty otherwise. */
export function heldRuns(db: Database, now = Date.now()): ReadonlyMap<string, HoldCause> {
  const pass = passes.get(db);
  if (pass === undefined || now - pass.at > HELD_FRESH_MS || pass.at - now > HELD_FRESH_MS) return new Map();
  return pass.held;
}
