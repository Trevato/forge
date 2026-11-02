/**
 * `GET /api/v1/releases`: the kept releases for whoever may read /releases,
 * and `?shipped=true` what went live, for anyone — MCP `releases` over HTTP.
 * The answers are `release/answer.ts`'s.
 */

import { releasesAnswer, shippedAnswer } from "../../release/answer.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Handler } from "../context.ts";
import { apiError, json } from "../respond.ts";
import type { Router } from "../router.ts";

export function releasesRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/releases", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const shipped = ctx.url.searchParams.get("shipped");
    if (shipped !== null && shipped !== "true")
      return apiError("invalid_shipped", 422, "shipped is true (what went live) or absent (the kept releases)");
    if (shipped === "true") return json(await shippedAnswer(ctx.app, ctx.url.searchParams.get("repo")));
    const answer = releasesAnswer(ctx.app, ctx.auth.user);
    return answer.ok ? json(answer.value) : apiError(answer.error, 403, answer.message);
  });
}
