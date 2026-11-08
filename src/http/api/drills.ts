/** `GET /api/v1/admin/drills`: what MCP `drills` answers, for the same reader. */

import { drillRows, listResilience } from "../../actions/resilience.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { apiError, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";

export function drillRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/admin/drills", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (!ctx.auth.user) return unauthorized();
    const listed = listResilience(ctx.app, ctx.auth.user);
    if (!listed.ok) return apiError("forbidden", 403, "failure domains are for a forge admin who is a person");
    // Tagged only past the access check: the 401 and 403 carry no ETag. The tag is of the exact bytes sent,
    // so a drill recorded or a domain's state changing moves it.
    const text = JSON.stringify({ items: drillRows(listed.value, ctx.app.config.url ?? ctx.url.origin), next_cursor: null });
    const etag = weakEtag(text);
    const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
    if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    return new Response(text, { headers: { "content-type": "application/json", ...headers } });
  });
}
