/**
 * `POST /__forge/measure` on an app's own host: the door the template's
 * beacon posts to. The forge answers it, so the app holds no secret and
 * the report is filed against the app whose host it arrived at, never one
 * named in the body. Same-origin only, opted-out visitors stored nothing,
 * rate-limited per client and per app, a body of a few hundred bytes at
 * most, every field validated (`web/measure.ts`). Always an empty 204 or a
 * short refusal.
 */

import type { App } from "../app.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import { readBounded } from "../http/limits.ts";
import { clientAddress, clientBucket } from "../http/peer.ts";
import { optedOut, parseReport, REPORT_MAX } from "../web/measure.ts";
import type { AppTarget } from "./proxy.ts";
import { originOf } from "../perf/sources.ts";
import { noteView } from "../perf/views_store.ts";
import { recordAppVital } from "./vitals.ts";

const PER_CLIENT = 30;
const PER_APP = 600;

const limiter = (perMinute: number) =>
  new RateLimiter({ perMinute, adminPerMinute: perMinute, enabled: true });

const limits = new WeakMap<App, { client: RateLimiter; apps: Map<string, RateLimiter> }>();

const refuse = (status: number, headers?: Record<string, string>): Response =>
  new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });

/** The page's own origin: the request's Origin names the host it was sent to. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin === null || host === null) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function appMeasure(
  app: App,
  request: Request,
  target: AppTarget,
): Promise<Response> {
  if (request.method !== "POST") return refuse(405, { allow: "POST" });
  if (!sameOrigin(request)) return refuse(403);
  if (optedOut(request)) return refuse(204);

  let pair = limits.get(app);
  if (pair === undefined) {
    pair = { client: limiter(PER_CLIENT), apps: new Map() };
    limits.set(app, pair);
  }
  let forApp = pair.apps.get(target.app.id);
  if (forApp === undefined) {
    forApp = limiter(PER_APP);
    pair.apps.set(target.app.id, forApp);
  }
  for (const verdict of [
    pair.client.take(`${target.app.id}:${clientBucket(request)}`, "ro"),
    forApp.take("app", "ro"),
  ]) {
    if (!verdict.allowed)
      return refuse(429, { "retry-after": String(Math.max(1, verdict.retryAfter)) });
  }

  // Previews are drafts and the card counts production only: store nothing.
  if (target.env !== "production") return refuse(204);

  const bytes = await readBounded(request, REPORT_MAX);
  if (bytes === "too_large") return refuse(413);
  const report = parseReport(new TextDecoder().decode(bytes));
  if (report === "malformed") return refuse(400);
  recordAppVital(
    app.db,
    target.app.id,
    report,
    clientAddress(request),
    request.headers.get("user-agent") ?? "",
  );
  noteView(app.db, {
    scope: target.app.id,
    path: report.path.split(/[?#]/)[0] ?? "/",
    origin: originOf(report.ref, report.q, request.headers.get("host") ?? "", report.out),
    client: clientAddress(request),
    agent: request.headers.get("user-agent") ?? "",
  });
  return refuse(204);
}
