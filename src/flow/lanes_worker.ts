/**
 * The worker side of the new home's lanes (`lanes.ts`): read the picture on a
 * read-only handle of its own, so the forge's one thread never walks the
 * runs, the issues or the crew's order to draw a lane. The same pattern as
 * `pipeline_worker.ts`: the thread posts a job and receives the answer.
 *
 * The fast part runs for every job; the slow part (the crew's order for what
 * is asked next, the figures, the alarms) is kept `SLOW_MS` and only re-read
 * when it is older.
 */

import { Database } from "bun:sqlite";
import { compose, readFast, readSlow, SLOW_MS, type LanePicture, type Slow } from "./lanes_read.ts";

/** What the worker is asked. */
export interface LaneJob {
  readonly id: number;
  readonly path: string;
  readonly now: number;
  /** The write clock the thread read when it asked; handed back on the picture. */
  readonly stamp: string | undefined;
  readonly dataDir: string;
  readonly ceilingUsd: number | null;
}

/** What it answers: the picture and what each part cost, or why it could not. */
export interface LaneAnswer {
  readonly id: number;
  readonly picture?: LanePicture;
  readonly fastMs?: number;
  /** The slow part's cost, or null when the kept one served. */
  readonly slowMs?: number | null;
  readonly error?: string;
}

declare const self: Worker;

const handles = new Map<string, Database>();
const kept = new Map<string, { at: number; slow: Slow }>();

self.onmessage = (e: MessageEvent<LaneJob>) => {
  const { id, path, now, stamp, dataDir, ceilingUsd } = e.data;
  try {
    let db = handles.get(path);
    if (db === undefined) {
      db = new Database(path, { readonly: true });
      db.run("PRAGMA busy_timeout = 5000");
      handles.set(path, db);
    }
    const t0 = performance.now();
    const fast = readFast(db, new Date(now));
    const fastMs = performance.now() - t0;
    let slowMs: number | null = null;
    let slow = kept.get(path);
    if (slow === undefined || now - slow.at >= SLOW_MS) {
      const t1 = performance.now();
      try {
        slow = { at: now, slow: readSlow(db, new Date(now), { dataDir, ceilingUsd }) };
        kept.set(path, slow);
      } catch (error) {
        // The last slow part keeps serving; a failing read is tried again with the next job.
        if (slow === undefined) throw error;
      }
      slowMs = performance.now() - t1;
    }
    postMessage({ id, picture: compose(fast, slow?.slow, now, stamp), fastMs, slowMs } satisfies LaneAnswer);
  } catch (error) {
    postMessage({ id, error: String(error) } satisfies LaneAnswer);
  }
};
