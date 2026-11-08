/** `GET /api/v1/admin/subscriptions`: what MCP `subscriptions` answers; `adminGate` refuses anyone but a forge admin first. */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { subscriptionRows } from "../../core/subscriptions.ts";
import type { Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { requireScope, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";

export function subscriptionRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/admin/subscriptions", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (!ctx.auth.user) return unauthorized();
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    // The tag is of the exact bytes sent, so a change moves it; reached only past the access checks.
    const text = JSON.stringify({ items: subscriptionRows(ctx.app.db) });
    const etag = weakEtag(text);
    const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
    if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    return new Response(text, { headers: { "content-type": "application/json", ...headers } });
  });
}
