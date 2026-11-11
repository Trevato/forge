/** `GET /api/v1/maintenance/runs`: the latest maintenance duty runs, for a forge admin. */

import { latest } from "../../maintain/runs.ts";
import type { Handler } from "../context.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { forbidden, json, requireScope, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";

export function maintenanceRunsRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/maintenance/runs", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (!ctx.auth.user) return unauthorized();
    if (!ctx.auth.user.isAdmin) return forbidden();
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    const asked = Number(ctx.url.searchParams.get("limit") ?? 20);
    const limit = Number.isInteger(asked) && asked > 0 ? asked : 20;
    return json({ runs: latest(ctx.app.db, limit) });
  });
}
