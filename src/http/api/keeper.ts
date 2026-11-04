/**
 * `GET /api/v1/keeper`: the release keeper's releases, holds and what blocks
 * the next cut, for whoever may read /releases — MCP `release_keeper` over
 * HTTP. The answer is `keeper/landed.ts`'s `keeperAnswer`.
 */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { keeperAnswer } from "../../keeper/landed.ts";
import { mayRead } from "../../release/gate.ts";
import type { Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { apiError } from "../respond.ts";
import type { Router } from "../router.ts";

export function keeperRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/keeper", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (!mayRead(ctx.app, ctx.auth.user))
      return apiError("forbidden", 403, "the release history is for the forge's administrators and its repository's readers");
    // Tagged only after the access check, over the exact bytes sent: a recorded, promoted, held or
    // rolled-back release moves it, and a viewer shown a different body gets a different tag.
    const text = JSON.stringify(keeperAnswer(ctx.app.db));
    const etag = weakEtag(text);
    const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
    if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    return new Response(text, { headers: { "content-type": "application/json", ...headers } });
  });
}
