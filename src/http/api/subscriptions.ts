/** `GET /api/v1/admin/subscriptions`: what MCP `subscriptions` answers; `adminGate` refuses anyone but a forge admin first. */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { subscriptionRows } from "../../core/subscriptions.ts";
import type { Handler } from "../context.ts";
import { json, requireScope, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";

export function subscriptionRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/admin/subscriptions", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (!ctx.auth.user) return unauthorized();
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    return json({ items: subscriptionRows(ctx.app.db) });
  });
}
