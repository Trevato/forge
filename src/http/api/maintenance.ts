/** `/api/v1/admin/maintenance`: what the Maintenance page and MCP `maintenance` do, for a forge admin's admin-scope credential. */

import { prepare, resumeNow, status } from "../../maintenance/service.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { crossOrigin, type Handler } from "../context.ts";
import { apiError, boundedBody, forbidden, json, notFound, requireScope, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";

/** A reason is at most 200 characters; room for them escaped. */
const BODY_MAX = 4096;

export function maintenanceRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/admin/maintenance", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (!ctx.auth.user) return unauthorized();
    if (!ctx.auth.user.isAdmin) return notFound();
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    return json(status(ctx.app));
  });
  router.add("POST", "/api/v1/admin/maintenance/prepare", async (ctx) => {
    if (!ctx.auth.user) return unauthorized();
    if (!ctx.auth.user.isAdmin) return notFound();
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    if (ctx.auth.via === "session" && crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    const input = await boundedBody(ctx.request, BODY_MAX);
    if (input === "too_large") return apiError("too_large", 413, "The request is too large.");
    const reason = typeof input["reason"] === "string" ? input["reason"] : "";
    const r = await prepare(ctx.app, ctx.auth.user, reason);
    return r.ok ? json(r.value) : apiError(r.error.code === "invalid" ? "invalid" : "not_found", r.error.code === "invalid" ? 422 : 404, r.error.says);
  });
  router.add("POST", "/api/v1/admin/maintenance/resume", (ctx) => {
    if (!ctx.auth.user) return unauthorized();
    if (!ctx.auth.user.isAdmin) return notFound();
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    if (ctx.auth.via === "session" && crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    const r = resumeNow(ctx.app, ctx.auth.user);
    return r.ok ? json(r.value) : apiError(r.error.code, r.error.code === "conflict" ? 409 : 404, r.error.says);
  });
}
