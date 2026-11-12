/**
 * `GET /forges/name/<name>`: whether Start my forge would take that name, as
 * `{"verdict":"free"|"taken"|"invalid"|"reserved","why":"…"}`. The rules are
 * `spawn/name_verdict.ts`, the ones the door applies. Strangers are counted
 * per address, as `forge-ready.ts` counts them.
 */
import { RateLimiter } from "../../core/ratelimit.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { App } from "../../app.ts";
import type { Ctx } from "../../http/context.ts";
import { clientBucket } from "../../http/peer.ts";
import { json } from "../../http/respond.ts";
import { forgeNameVerdict } from "../../actions/spawn.ts";

/** Asks per minute from one address: a field checking as someone types fits. */
export const NAME_PER_MINUTE = 60;

const limiters = new WeakMap<App, RateLimiter>();
const NO_STORE = { "cache-control": "no-store" };

export async function forgeName(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  let limiter = limiters.get(ctx.app);
  if (limiter === undefined) {
    limiter = new RateLimiter({ perMinute: NAME_PER_MINUTE, adminPerMinute: NAME_PER_MINUTE, enabled: true });
    limiters.set(ctx.app, limiter);
  }
  const taken = limiter.take(clientBucket(ctx.request), "ro");
  if (!taken.allowed)
    return json({ error: "rate_limited" }, 429, { ...NO_STORE, "retry-after": String(Math.max(1, taken.retryAfter)) });
  return json(await forgeNameVerdict(ctx.app, ctx.params.name ?? ""), 200, NO_STORE);
}
