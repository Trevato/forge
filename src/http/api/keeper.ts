/**
 * `GET /api/v1/keeper`: the release keeper's releases, holds and what blocks
 * the next cut, for whoever may read /releases — MCP `release_keeper` over
 * HTTP. The answer is `keeper/landed.ts`'s `keeperAnswer`.
 */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { keeperAnswer } from "../../keeper/landed.ts";
import { mayRead } from "../../release/gate.ts";
import type { Handler } from "../context.ts";
import { apiError, json } from "../respond.ts";
import type { Router } from "../router.ts";

export function keeperRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/keeper", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (!mayRead(ctx.app, ctx.auth.user))
      return apiError("forbidden", 403, "the release history is for the forge's administrators and its repository's readers");
    return json(keeperAnswer(ctx.app.db));
  });
}
