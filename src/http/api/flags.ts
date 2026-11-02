/** `GET /api/v1/flags`: what MCP `flags` answers, for the same reader (#8012). */

import { readFlags } from "../../actions/flags_view.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Handler } from "../context.ts";
import { apiError, json, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";

export function flagsRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/flags", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (!ctx.auth.user) return unauthorized();
    const out = readFlags(ctx.auth.user);
    return out.ok ? json({ flags: out.flags }) : apiError("forbidden", 403, out.message);
  });
}
