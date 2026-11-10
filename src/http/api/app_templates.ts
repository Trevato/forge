/**
 * App templates over the API. `GET /api/v1/app-templates` lists the marked
 * templates the caller can read, default first. `POST /api/v1/admin/app-templates`
 * with `{ repo: "owner/name", marked: true|false }` marks or unmarks one: a
 * site admin only, anyone else signed in is told 403.
 */

import { MARK_TEMPLATE_ERRORS, markTemplate } from "../../actions/app_templates.ts";
import { offeredTemplates } from "../../core/app_templates.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Handler } from "../context.ts";
import { apiError, body, json, notFound, requireScope, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";

export function appTemplateRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/app-templates", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (!ctx.auth.user) return unauthorized();
    return json({ templates: offeredTemplates(ctx.app.db, ctx.auth.user) });
  });

  router.add("POST", "/api/v1/admin/app-templates", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const user = ctx.auth.user;
    if (!user) return unauthorized();
    if (!user.isAdmin || user.kind !== "user") return apiError("forbidden", 403, MARK_TEMPLATE_ERRORS.forbidden);
    const scoped = requireScope(ctx, "admin");
    if (scoped) return scoped;
    const input = await body(ctx.request);
    if (typeof input["repo"] !== "string" || typeof input["marked"] !== "boolean")
      return apiError("invalid_body", 422, "send repo (owner/name) and marked (true or false)");
    const done = markTemplate(ctx.app, user, input["repo"], input["marked"]);
    if (done.ok) return json(done.value);
    if (done.error === "no_such_template") return notFound();
    return apiError(done.error, 422, MARK_TEMPLATE_ERRORS[done.error]);
  });
}
