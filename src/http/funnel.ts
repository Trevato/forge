/**
 * POST /_funnel: the home page's two funnel signals (#11259) — the plans came
 * into view, a plan's button was pressed. Same rules as the page-view beacon
 * (`http/measure.ts`): same-origin only, opted-out visitors store nothing, a
 * rate per client, a tiny body, every field checked. The plan must be one the
 * forge offers, so nothing a client invents is stored. Always an empty 204 or
 * a short refusal.
 */

import { RateLimiter } from "../core/ratelimit.ts";
import type { App } from "../app.ts";
import { getPlans } from "../settings/plans.ts";
import { optedOut } from "../web/measure.ts";
import { noteStep } from "../perf/funnel.ts";
import type { Ctx } from "./context.ts";
import { readBounded } from "./limits.ts";
import { clientAddress, clientBucket } from "./peer.ts";

/** What the home's buttons call the free start when no plan is free. */
export const START = "start";

const limits = new WeakMap<App, RateLimiter>();
const refuse = (status: number, headers?: Record<string, string>): Response =>
  new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });

export async function funnelSubmit(ctx: Ctx): Promise<Response> {
  const { request, app } = ctx;
  if (request.headers.get("origin") !== ctx.url.origin) return refuse(403);
  if (optedOut(request)) return refuse(204);
  let limiter = limits.get(app);
  if (limiter === undefined) {
    limiter = new RateLimiter({ perMinute: 30, adminPerMinute: 30, enabled: true });
    limits.set(app, limiter);
  }
  const verdict = limiter.take(clientBucket(request), "ro");
  if (!verdict.allowed) return refuse(429, { "retry-after": String(Math.max(1, verdict.retryAfter)) });
  const bytes = await readBounded(request, 200);
  if (bytes === "too_large") return refuse(413);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return refuse(400);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return refuse(400);
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((k) => k !== "step" && k !== "plan")) return refuse(400);
  const client = clientAddress(request);
  const agent = request.headers.get("user-agent") ?? "";
  if (body["step"] === "plans" && body["plan"] === undefined) {
    noteStep(app.db, { kind: "plans", client, agent });
    return refuse(204);
  }
  if (body["step"] === "click" && typeof body["plan"] === "string") {
    const known = body["plan"] === START || getPlans(app.db).some((p) => p.name === body["plan"]);
    if (!known) return refuse(400);
    noteStep(app.db, { kind: "click", plan: body["plan"], client, agent });
    return refuse(204);
  }
  return refuse(400);
}
