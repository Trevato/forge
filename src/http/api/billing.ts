/**
 * GET/PUT /api/v1/forges/{name}/plan: a forge's entitlement and the admin's
 * hand grant (`actions/billing.ts`), the twin of Settings → Billing. A
 * forge admin who is a person; anyone else is told 404. Same-origin checked.
 */

import { BILLING_WORDS, grantPlan, readPlan } from "../../actions/billing.ts";
import { crossOrigin, type Handler } from "../context.ts";
import { apiError, body, forbidden, json, notFound, requireScope } from "../respond.ts";
import type { Router } from "../router.ts";

export function billingRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/forges/:name/plan", (ctx) => {
    if (ctx.auth.user?.isAdmin !== true) return notFound();
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    const read = readPlan(ctx.app, ctx.auth.user, ctx.params["name"] ?? "");
    if (read.ok) return json(read.value, 200, { "cache-control": "private, no-cache" });
    return read.error === "not_found" ? notFound() : apiError(read.error, 404, BILLING_WORDS[read.error]);
  });

  router.add("PUT", "/api/v1/forges/:name/plan", async (ctx) => {
    if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    if (ctx.auth.user?.isAdmin !== true) return notFound();
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const set = grantPlan(ctx.app, ctx.auth.user, ctx.params["name"] ?? "", input["plan"]);
    if (set.ok) return json(set.value);
    if (set.error === "not_found") return notFound();
    return set.error === "no_such_forge" ? apiError(set.error, 404, BILLING_WORDS[set.error]) : apiError(set.error, 422, BILLING_WORDS[set.error]);
  });
}
