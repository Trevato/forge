/**
 * A run's lease. The process working a run says so every so often, and a
 * run whose holder has gone quiet is nobody's: the forge that finds it
 * fails it honestly and, for an agent's task, queues the task again.
 *
 * The lease is what lets two forges share a data directory for a moment —
 * a release's new process coming up beside the old one — without the new
 * one mistaking the old one's live work for a crash's leftovers. The old
 * process stops its own work and says so before it goes; the lease covers
 * the window in between, and the crash that never says anything.
 */

import type { Database } from "bun:sqlite";
import { heartbeatRuns } from "../core/runs.ts";

/** How often a held lease is renewed. */
export const HEARTBEAT_MS = 15_000;
/** How long without a renewal before a running run counts as abandoned. */
export const STALE_AFTER_MS = 90_000;

const held = new Map<Database, Set<string>>();
let timer: ReturnType<typeof setInterval> | undefined;

function renewAll(): void {
  for (const [db, ids] of held) {
    if (ids.size === 0) continue;
    try {
      heartbeatRuns(db, [...ids]);
    } catch {
      // A closed database is a forge that has already gone; nothing to renew.
    }
  }
}

/**
 * Hold a run's lease until the returned release is called. Renewals ride
 * one timer for every run this process holds; the timer does not keep the
 * process alive on its own.
 */
export function holdLease(db: Database, runId: string): () => void {
  let ids = held.get(db);
  if (ids === undefined) {
    ids = new Set();
    held.set(db, ids);
  }
  ids.add(runId);
  heartbeatRuns(db, [runId]);
  if (timer === undefined) {
    timer = setInterval(renewAll, HEARTBEAT_MS);
    timer.unref();
  }
  return () => {
    const set = held.get(db);
    if (set === undefined) return;
    set.delete(runId);
    if (set.size === 0) held.delete(db);
    if (held.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** The runs this process holds the lease of on `db`: whatever else is renewed is another forge's. */
export function heldRuns(db: Database): ReadonlySet<string> {
  return held.get(db) ?? new Set();
}
