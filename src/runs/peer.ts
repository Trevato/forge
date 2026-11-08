/**
 * Another forge still working this database (#6957). A roll stops the old
 * pod and starts the new one on the same data, and since #6732 the old one
 * keeps its gates and crew runs going through its drain: it keeps writing.
 * bun:sqlite waits for the write lock on the one thread, up to
 * `busy_timeout` a statement, so a new forge that starts its own gates and
 * ticks beside it stalls every request behind the old one's writes: 0.7.278
 * failed readiness for minutes that way.
 *
 * The old forge says it is there the way it always has: it renews the leases
 * of the runs it holds (`lease.ts`). A running run renewed within
 * `PEER_FRESH_MS` that this process does not hold is that forge's, whatever
 * its version. `waitForPeer` lets the listener answer and holds the rest of
 * the boot until no such run is left, or `PEER_WAIT_MAX_MS` has passed (the
 * platform has stopped the old pod by then).
 */

import type { Database } from "bun:sqlite";
import type { Log } from "../kernel/log.ts";
import { HEARTBEAT_MS, heldRuns } from "./lease.ts";

/** Two renewals missed: the lease is not being kept. */
export const PEER_FRESH_MS = 2 * HEARTBEAT_MS;
/** The pod's grace (charts/app, 720 s): an old pod is gone by then. A drain is 10 s (`src/drain.ts`); this is the ceiling for a run that ignores it. */
export const PEER_WAIT_MAX_MS = 720_000;
const POLL_MS = 5_000;

/** Running runs whose lease another process renewed within `PEER_FRESH_MS` of `now`. */
export function peerRuns(db: Database, now = Date.now()): number {
  const here = heldRuns(db);
  const rows = db
    .query<{ id: string }, [string]>("SELECT id FROM run WHERE state = 'running' AND heartbeat_at >= ?1")
    .all(new Date(now - PEER_FRESH_MS).toISOString());
  return rows.filter((r) => !here.has(r.id)).length;
}

export interface PeerWait {
  readonly pollMs?: number;
  readonly maxMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<unknown>;
}

/** How the wait ended: nobody was there, they finished, or the ceiling passed. */
export type PeerOutcome = "alone" | "gone" | "waited out";

/** Resolve once no other forge's run is live on `db`; said in the log when it waits at all. */
export async function waitForPeer(db: Database, log: Log, opts: PeerWait = {}): Promise<PeerOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? Bun.sleep;
  const maxMs = opts.maxMs ?? PEER_WAIT_MAX_MS;
  const started = now();
  let live = peerRuns(db, started);
  if (live === 0) return "alone";
  log.warn("another forge still works this database: this one serves, and starts its own work once it lets go", {
    runs: live,
    maxSeconds: Math.round(maxMs / 1000),
  });
  while (live > 0) {
    if (now() - started >= maxMs) {
      log.warn("another forge still works this database; starting beside it", { runs: live });
      return "waited out";
    }
    await sleep(opts.pollMs ?? POLL_MS);
    live = peerRuns(db, now());
  }
  log.info("the other forge let go of this database; starting work", { waitedSeconds: Math.round((now() - started) / 1000) });
  return "gone";
}
