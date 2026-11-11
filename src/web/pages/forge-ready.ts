/**
 * `GET /forges/<name>/ready`: whether a forge this one made answers yet, as
 * `{"ready":true|false}`, so a browser can wait before sending a stranger to
 * a child still booting. The parent probes the child's `/healthz` (the probe
 * seam of `spawn/door.ts`, 800 ms at most) and says only yes or no: never the
 * claim code, never the child's address. A name that is not a child's name,
 * or that this forge never made, is a 404. Strangers are counted per address.
 */
import { RateLimiter } from "../../core/ratelimit.ts";
import { notePhase, takeSessionTime, timePhaseAsync } from "../../core/route_timing.ts";
import { isChildName } from "../../core/proposal_token.ts";
import type { App } from "../../app.ts";
import type { Ctx } from "../../http/context.ts";
import { clientBucket } from "../../http/peer.ts";
import { json } from "../../http/respond.ts";
import { childReady, READY_PROBE_MS } from "../../spawn/ready.ts";

/** Asks per minute from one address: a browser polling every two seconds fits. */
export const READY_PER_MINUTE = 60;
export { READY_PROBE_MS };

const limiters = new WeakMap<App, RateLimiter>();
const NO_STORE = { "cache-control": "no-store" };

export async function forgeReady(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  let limiter = limiters.get(ctx.app);
  if (limiter === undefined) {
    limiter = new RateLimiter({ perMinute: READY_PER_MINUTE, adminPerMinute: READY_PER_MINUTE, enabled: true });
    limiters.set(ctx.app, limiter);
  }
  const verdict = limiter.take(clientBucket(ctx.request), "ro");
  if (!verdict.allowed)
    return json({ error: "rate_limited" }, 429, { ...NO_STORE, "retry-after": String(Math.max(1, verdict.retryAfter)) });
  const name = ctx.params.name ?? "";
  if (!isChildName(name)) return json({ error: "not_found" }, 404, NO_STORE);
  const ready = await childReady(ctx.app, name, (phase, run) => timePhaseAsync(ctx.request, phase as "ledger" | "probe", run));
  if (ready === undefined) return json({ error: "not_found" }, 404, NO_STORE);
  return json({ ready }, 200, NO_STORE);
}
