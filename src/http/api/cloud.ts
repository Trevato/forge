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
import { holds, weakEtag } from "../etag.ts";
import { apiError, notFound, unauthorized } from "../respond.ts";
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
    if (!seen.ok) return notFound();
    // Tagged over the exact bytes, so a linked or removed account, a call, or a
    // repository starting or stopping a vendor moves it; reached past the access checks only.
    const text = JSON.stringify(seen.value);
    const etag = weakEtag(text);
    const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
    if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    return new Response(text, { headers: { "content-type": "application/json", ...headers } });
  });
}
