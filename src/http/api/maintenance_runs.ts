/** `GET /api/v1/maintenance/runs`: the latest maintenance duty runs, for a forge admin. */

import { switchDuty, dutyStates } from "../../maintain/pause.ts";
import { latest } from "../../maintain/runs.ts";
import type { Handler } from "../context.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { crossOrigin } from "../context.ts";
import { apiError, boundedBody, forbidden, json, notFound, requireScope, unauthorized } from "../respond.ts";
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
  router.add("GET", "/api/v1/maintenance/duties", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (!ctx.auth.user) return unauthorized();
    if (!ctx.auth.user.isAdmin) return forbidden();
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    return json({ duties: dutyStates(ctx.app.db) });
  });
  router.add("POST", "/api/v1/maintenance/duties/:name", async (ctx) => {
    if (!ctx.auth.user) return unauthorized();
    if (!ctx.auth.user.isAdmin) return forbidden();
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    if (ctx.auth.via === "session" && crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    const input = await boundedBody(ctx.request, 1024);
    if (input === "too_large") return apiError("too_large", 413, "The request is too large.");
    const r = switchDuty(ctx.app.db, ctx.params["name"], input["paused"], ctx.auth.user.username);
    return r.ok ? json({ says: r.says }) : r.code === "not_found" ? notFound() : apiError("invalid", 422, r.says);
  });
}
