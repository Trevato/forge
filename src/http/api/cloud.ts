/**
 * `GET /api/v1/cloud/accounts`: the forge's cloud accounts with each token's
 * use and today's calls, never a secret — MCP `cloud_accounts` over HTTP. A
 * forge admin's alone (anyone else sees no such route), and a token that may
 * write, because every vendor call is audited.
 */

import { usesByVendor, type VendorUse } from "../../cloud/declared.ts";
import { cloudOverview } from "../../cloud/overview.ts";
import { scopeAllows } from "../../core/tokens.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Handler } from "../context.ts";
import { apiError, json, notFound, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";

export function cloudRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/cloud/accounts", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const user = ctx.auth.user;
    if (!user || ctx.auth.scope === undefined) return unauthorized();
    if (!scopeAllows(ctx.auth.scope, "rw"))
      return apiError("forbidden", 403, "a read-only token cannot list cloud accounts");
    if (!user.isAdmin) return notFound();
    const uses = await usesByVendor(ctx.app.db, ctx.app.reposRoot, user).catch(
      () => new Map<string, VendorUse[]>(),
    );
    const seen = cloudOverview(ctx.app, user, uses);
    return seen.ok ? json(seen.value) : notFound();
  });
}
