/**
 * The anonymous spawn limit: a stranger may start at most this many child
 * forges in any 24 hours, keyed by their client bucket (`http/peer.ts`), and
 * all strangers together at most a global number. The count is a table in the
 * forge's database under FORGE_APP_DATA, so a restart does not clear it.
 * Signed-in callers are not counted here.
 */

import type { Database } from "bun:sqlite";
import { clientBucket } from "../http/peer.ts";

/** Anonymous spawns allowed per client in any 24 hours. */
export const ANON_SPAWNS_PER_DAY = 3;
/** Anonymous spawns allowed from everyone together in any 24 hours. */
// 30 turned strangers away on any day the link was shared; what bounds a surge is the machine
// (forges awake at once, and the sleep that follows), not a daily count.
export const ANON_SPAWNS_GLOBAL_PER_DAY = 2_000;
const DAY_MS = 86_400_000;

export interface RateLimit {
  /** True when another anonymous spawn may be made now. */
  readonly allowed: boolean;
  /** When the oldest counted spawn leaves the window, ISO. */
  readonly resetsAt: string;
}

/** Whether this request's client may anonymously spawn now. */
export function checkAnonSpawn(db: Database, request: Request, now = Date.now()): RateLimit {
  const since = now - DAY_MS;
  db.query("DELETE FROM anon_spawn WHERE at <= ?").run(since);
  const mine = db
    .query("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM anon_spawn WHERE bucket = ?")
    .get(clientBucket(request)) as { n: number; oldest: number | null };
  const all = db.query("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM anon_spawn").get() as {
    n: number;
    oldest: number | null;
  };
  const clientFull = mine.n >= ANON_SPAWNS_PER_DAY;
  const globalFull = all.n >= ANON_SPAWNS_GLOBAL_PER_DAY;
  const oldest = (clientFull ? mine.oldest : globalFull ? all.oldest : null) ?? now;
  return { allowed: !clientFull && !globalFull, resetsAt: new Date(oldest + DAY_MS).toISOString() };
}

/** Count an anonymous spawn against this request's client. */
export function noteAnonSpawn(db: Database, request: Request, now = Date.now()): void {
  db.query("INSERT INTO anon_spawn (bucket, at) VALUES (?, ?)").run(clientBucket(request), now);
}

/** Forget every counted spawn (tests). */
export function resetAnonSpawns(db: Database): void {
  db.exec("DELETE FROM anon_spawn");
}
