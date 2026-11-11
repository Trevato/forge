/**
 * How often one signed-in person may run SQL in the data browser, on either
 * door. A query is an address (`?sql=`), so a reload, a link prefetcher or a
 * crawler with a session would re-run it; the budget is per identity, in
 * memory, and a refused run costs nothing. The work of one run is bounded
 * separately by `query` (5 s, 1,000 rows, 2 workers).
 */
import type { App } from "../app.ts";
import { RateLimiter } from "../core/ratelimit.ts";

/** Runs a minute, per person. */
export const SQL_PER_MINUTE = 20;

const windows = new WeakMap<App, RateLimiter>();

/** Seconds to wait when refused, or undefined when this run may go on. */
export function sqlWindow(app: App, userId: string): number | undefined {
  let limiter = windows.get(app);
  if (limiter === undefined) {
    limiter = new RateLimiter({ perMinute: SQL_PER_MINUTE, adminPerMinute: SQL_PER_MINUTE, enabled: true });
    windows.set(app, limiter);
  }
  const v = limiter.take(`sql:${userId}`, "ro");
  return v.allowed ? undefined : Math.max(1, v.retryAfter);
}
