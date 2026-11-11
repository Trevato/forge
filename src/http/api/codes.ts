/**
 * GET/POST /api/v1/codes and DELETE /api/v1/codes/{id}: the gift codes of
 * `actions/codes.ts`, the twin of the Billing page's Codes section. A forge
 * admin who is a person; anyone else is told 404. POST plans first (`dryRun`
 * is true unless `false`); the plain code is in the answer that makes it and
 * nowhere else. Same-origin checked.
 */

import { CODE_ERRORS, makeCode, planCode, readCodes, revoke, type CodeError } from "../../actions/codes.ts";
import { publicOrigin } from "../../core/public_origin.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { crossOrigin, type Handler } from "../context.ts";
import { apiError, body, forbidden, json, notFound, requireScope } from "../respond.ts";
import type { Router } from "../router.ts";

const refuse = (e: CodeError): Response =>
  e === "not_found" ? notFound() : apiError(e, e === "no_such_code" ? 404 : 422, CODE_ERRORS[e]);

export function codesRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/codes", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (ctx.auth.user?.isAdmin !== true) return notFound();
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    const read = readCodes(ctx.app, ctx.auth.user);
    return read.ok ? json(read.value, 200, { "cache-control": "private, no-store" }) : notFound();
  });

  router.add("POST", "/api/v1/codes", async (ctx) => {
    if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    if (ctx.auth.user?.isAdmin !== true) return notFound();
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    if (input["dryRun"] !== undefined && typeof input["dryRun"] !== "boolean") return apiError("invalid", 422, "dryRun is true or false");
    if (input["dryRun"] !== false) {
      const planned = planCode(ctx.app, ctx.auth.user, input);
      return planned.ok ? json({ dryRun: true, plan: planned.value, says: "This is the code; nothing was made. Send dryRun: false to make it." }) : refuse(planned.error);
    }
    const made = makeCode(ctx.app, ctx.auth.user, input, publicOrigin(ctx.app.config.url, ctx.url.origin));
    return made.ok ? json({ dryRun: false, ...made.value, says: "Shown once: the plain code is not kept." }, 201, { "cache-control": "no-store" }) : refuse(made.error);
  });

  router.add("DELETE", "/api/v1/codes/:id", (ctx) => {
    if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    if (ctx.auth.user?.isAdmin !== true) return notFound();
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const done = revoke(ctx.app, ctx.auth.user, ctx.params["id"] ?? "");
    return done.ok ? json({ revoked: done.value.id }) : refuse(done.error);
  });
}
