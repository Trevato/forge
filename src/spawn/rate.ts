/**
 * The anonymous spawn limit: a stranger may start at most this many child
 * forges in any 24 hours, keyed by their client bucket (`http/peer.ts`).
 * A light guard against abuse, not a durable ledger — it lives in memory,
 * so a restart clears it, which is fine for a rate limit. Signed-in
 * callers are not counted here.
 */

import { clientBucket } from "../http/peer.ts";

/** Anonymous spawns allowed per client in any 24 hours. */
export const ANON_SPAWNS_PER_DAY = 3;
const DAY_MS = 86_400_000;

/** When each counted spawn happened, oldest first, per client bucket. */
const seen = new Map<string, number[]>();

const prune = (bucket: string, now: number): number[] => {
  const kept = (seen.get(bucket) ?? []).filter((t) => now - t < DAY_MS);
  if (kept.length === 0) seen.delete(bucket);
  else seen.set(bucket, kept);
  return kept;
};

export interface RateLimit {
  /** True when another anonymous spawn may be made now. */
  readonly allowed: boolean;
  /** When the oldest counted spawn leaves the window, ISO. */
  readonly resetsAt: string;
}

/** Whether this request's client may anonymously spawn now. */
export function checkAnonSpawn(request: Request, now = Date.now()): RateLimit {
  const bucket = clientBucket(request);
  const kept = prune(bucket, now);
  const oldest = kept[0] ?? now;
  return {
    allowed: kept.length < ANON_SPAWNS_PER_DAY,
    resetsAt: new Date(oldest + DAY_MS).toISOString(),
  };
}

/** Count an anonymous spawn against this request's client. */
export function noteAnonSpawn(request: Request, now = Date.now()): void {
  const bucket = clientBucket(request);
  const kept = prune(bucket, now);
  kept.push(now);
  seen.set(bucket, kept);
}

/** Forget every counted spawn (tests). */
export function resetAnonSpawns(): void {
  seen.clear();
}
