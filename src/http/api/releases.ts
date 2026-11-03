/**
 * `GET /api/v1/releases`: the kept releases for whoever may read /releases,
 * and `?shipped=true` what went live, for anyone — MCP `releases` over HTTP.
 * The answers are `release/answer.ts`'s.
 */

import { releasesAnswer, shippedAnswer } from "../../release/answer.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { apiError } from "../respond.ts";
import type { Router } from "../router.ts";

/** The JSON sent, tagged by its own bytes; a repeat holding the tag gets 304 and no body. */
function tagged(request: Request, data: unknown, headers: Record<string, string>): Response {
  const text = JSON.stringify(data);
  const etag = weakEtag(text);
  const all = { etag, ...headers };
  if (holds(request, etag)) return new Response(null, { status: 304, headers: all });
  return new Response(text, { headers: { "content-type": "application/json", ...all } });
}

export function releasesRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/releases", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const shipped = ctx.url.searchParams.get("shipped");
    if (shipped !== null && shipped !== "true")
      return apiError("invalid_shipped", 422, "shipped is true (what went live) or absent (the kept releases)");
    if (shipped === "true") {
      const data = await shippedAnswer(ctx.app, ctx.url.searchParams.get("repo"));
      return tagged(ctx.request, data, { "cache-control": "public, max-age=60" });
    }
    const answer = releasesAnswer(ctx.app, ctx.auth.user);
    return answer.ok
      ? tagged(ctx.request, answer.value, { "cache-control": "private, no-cache", vary: "authorization, cookie" })
      : apiError(answer.error, 403, answer.message);
  });
}
