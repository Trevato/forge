/**
 * API reads without a credential, throttled per source (#2917). The token
 * limiter counts a token's requests; a stranger has none, so a loop reading
 * `/api/v1/...` with no token was never counted at all. Each source — the
 * peer as `http/peer.ts` resolves it, an IPv6 client by its /64 — may read
 * `api.anonymous_per_source` times a sliding minute (`/admin/limits`); a
 * refused read is not counted, so the door reopens a window later.
 *
 * Only reads (GET, HEAD) under `/api/`, only without a session or token: a
 * person in a browser and anything holding a token are counted elsewhere or
 * not at all, `/healthz` and `/readyz` are never reached by this (a probe
 * must not be throttled into a restart), and a request whose source the
 * listener did not note (an in-process answer) is not one source's to count.
 * One limiter per forge database, so a test's forge never throttles another's.
 */

import type { Database } from "bun:sqlite";
import { limitsFromEnv, RateLimiter, type Verdict } from "../core/ratelimit.ts";
import { limitValue } from "../settings/limits.ts";
import { clientAddress, clientBucket } from "./peer.ts";

/** Each forge's limiter, or null when FORGE_RATE_LIMIT=0 turned every request limit off. */
const limiters = new WeakMap<Database, RateLimiter | null>();

/**
 * Count one read without a credential from `request`'s source; the verdict,
 * or undefined when this request is not one this limit counts.
 */
export function takeStrangerRead(db: Database, request: Request, credentialed: boolean): Verdict | undefined {
  if (credentialed) return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  if (clientAddress(request) === "unknown") return undefined;
  let limiter = limiters.get(db);
  if (limiter === undefined) {
    limiter = limitsFromEnv().enabled ? new RateLimiter() : null;
    limiters.set(db, limiter);
  }
  if (limiter === null) return undefined;
  // Read on every request, so a change on /admin/limits governs the next one.
  limiter.setLimits({ perMinute: limitValue(db, "api.anonymous_per_source"), adminPerMinute: 0, enabled: true });
  return limiter.take(`source:${clientBucket(request)}`, "ro");
}
