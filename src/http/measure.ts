/**
 * POST /_measure: the page-view beacon's door. Same-origin only (a beacon
 * from a page always carries Origin; anything else is refused — that is CSRF
 * protection only, any script can set the header), opted-out
 * visitors stored nothing, a rate per client and per forge, a body of a few
 * hundred bytes at most, every field validated (`web/measure.ts`), and the
 * route is one the forge serves. What protects the database is the bound on
 * what is stored (`DAY_MAX` rows a day, `recordVital`), not the checks here. The answer is always an empty 204 or a
 * short refusal; nothing is read back.
 */

import { RateLimiter } from "../core/ratelimit.ts";
import type { App } from "../app.ts";
import { optedOut, parseReport, recordVital, REPORT_MAX } from "../web/measure.ts";
import type { Ctx } from "./context.ts";
import { readBounded } from "./limits.ts";
import { clientAddress, clientBucket } from "./peer.ts";
import { originOf } from "../perf/sources.ts";
import { noteView } from "../perf/views_store.ts";

const PER_CLIENT = 30;
const PER_FORGE = 1200;

const limiter = (perMinute: number) =>
  new RateLimiter({ perMinute, adminPerMinute: perMinute, enabled: true });

/** One pair per forge, so a test's forge never throttles another's. */
const limits = new WeakMap<App, { client: RateLimiter; forge: RateLimiter }>();

const refuse = (status: number, headers?: Record<string, string>): Response =>
  new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });

/** The route pattern a path belongs to, or undefined when none does. */
export type RouteOf = (path: string) => string | undefined;

export async function measureSubmit(ctx: Ctx, routeOf: RouteOf): Promise<Response> {
  const { request, app } = ctx;
  if (request.headers.get("origin") !== ctx.url.origin) return refuse(403);
  if (optedOut(request)) return refuse(204);

  let pair = limits.get(app);
  if (pair === undefined) {
    pair = { client: limiter(PER_CLIENT), forge: limiter(PER_FORGE) };
    limits.set(app, pair);
  }
  for (const verdict of [
    pair.client.take(clientBucket(request), "ro"),
    pair.forge.take("forge", "ro"),
  ]) {
    if (!verdict.allowed)
      return refuse(429, { "retry-after": String(Math.max(1, verdict.retryAfter)) });
  }

  const bytes = await readBounded(request, REPORT_MAX);
  if (bytes === "too_large") return refuse(413);
  const report = parseReport(new TextDecoder().decode(bytes));
  if (report === "malformed") return refuse(400);
  const route = routeOf(report.path);
  if (route === undefined) return refuse(400);

  recordVital(
    app.db,
    report,
    route,
    clientAddress(request),
    request.headers.get("user-agent") ?? "",
  );
  noteView(app.db, {
    scope: "forge",
    // The route pattern, never the path: a path can name a private repository.
    path: route,
    origin: originOf(report.ref, report.q, ctx.url.host, report.out),
    client: clientAddress(request),
    agent: request.headers.get("user-agent") ?? "",
  });
  return refuse(204);
}
