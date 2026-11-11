/**
 * `POST /api/v1/start` (#10912): an agent with only the forge's URL gets an
 * account, a repository from the app template, its app and a token in one
 * call. No token, no session; the rules and limits are `actions/start.ts`.
 * A browser page from another site is refused: an agent is not one.
 */
import { START_HINT, START_WORDS, startBuilding } from "../../actions/start.ts";
import { REQUEST_MAX } from "../../core/reports.ts";
import { crossOrigin, type Handler } from "../context.ts";
import { clientBucket } from "../peer.ts";
import { apiError, boundedBody, json, tryAgain } from "../respond.ts";
import type { Router } from "../router.ts";

export function startRoutes(router: Router<Handler>): void {
  router.add("POST", "/api/v1/start", async (ctx) => {
    if (crossOrigin(ctx.request, ctx.url, ctx.app.log))
      return apiError("forbidden", 403, "send this call from your agent, not from a page on another site");
    const input = await boundedBody(ctx.request, REQUEST_MAX);
    if (input === "too_large") return apiError("too_large", 413, START_HINT);
    const started = await startBuilding(ctx.app, input, clientBucket(ctx.request), ctx.url.origin);
    if (started.ok)
      return json(started.value, 201, {
        // The token and the claim link are shown once: nothing may keep them.
        "cache-control": "no-store",
      });
    const refusal = started.error;
    const said = START_WORDS[refusal.error];
    if (refusal.error === "rate_limited" || refusal.error === "full")
      return tryAgain(refusal.error, 429, said, refusal.retryAfter ?? 3600);
    if (refusal.error === "off") return apiError("off", 403, said);
    if (refusal.error === "code_needed") return apiError("code_needed", 403, said);
    if (refusal.error === "failed") return apiError("failed", 500, said);
    return apiError(refusal.error, 422, `${said}; ${START_HINT}`);
  });
}
