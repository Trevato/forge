/** `GET /api/v1/admin/drills`: what MCP `drills` answers, for the same reader. */

import { drillRows, listResilience } from "../../actions/resilience.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Handler } from "../context.ts";
import { apiError, json, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";

export function drillRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/admin/drills", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (!ctx.auth.user) return unauthorized();
    const listed = listResilience(ctx.app, ctx.auth.user);
    if (!listed.ok) return apiError("forbidden", 403, "failure domains are for a forge admin who is a person");
    return json({ items: drillRows(listed.value, ctx.app.config.url ?? ctx.url.origin), next_cursor: null });
  });
}
