/** `GET /api/v1/flags`: what MCP `flags` answers, for the same reader (#8012). */

import { readFlags } from "../../actions/flags_view.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { apiError, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";

export function flagsRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/flags", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (!ctx.auth.user) return unauthorized();
    const out = readFlags(ctx.auth.user);
    if (!out.ok) return apiError("forbidden", 403, out.message);
    // The tag is of the exact bytes sent, reached only past the access check: a flag turned on or off
    // changes the body, and so the tag (#9214).
    const text = JSON.stringify({ flags: out.flags });
    const etag = weakEtag(text);
    const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
    if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    return new Response(text, { headers: { "content-type": "application/json", ...headers } });
  });
}
