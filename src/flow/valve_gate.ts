/**
 * The valves applied to the queue: the one place the crew's next start and
 * the page's preview both ask, so what the page says it will do is what the
 * next tick does. Reads the stored valves and this week's starts, nothing else.
 */

import type { Database } from "bun:sqlite";
import type { Run } from "../core/runs.ts";
import { throughValves, type Gated } from "./valve.ts";
import { readLevels, startsThisWeek } from "./valve_store.ts";

/** Queued runs through the valves; with no valve turned, the queue as it came. */
export function gateQueue(db: Database, queued: readonly Run[], now = Date.now()): Gated<Run> {
  const levels = readLevels(db);
  if (levels.size === 0) return { order: [...queued], held: [], yielding: [] };
  return throughValves(
    queued,
    (r) => ({ repoId: r.repoId, resumed: r.attempt > 0 }),
    levels,
    startsThisWeek(db, now),
  );
}
