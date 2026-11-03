/**
 * A fork family's build pins and runs as JSON (`core/iterations.ts`), the
 * same the Iterations page draws, for the viewer: private forks they may not
 * read are absent. A family with no pin answers empty lists.
 */

import { iterationsOf, lanesOf } from "../../core/iterations.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { loadRepo } from "../api.ts";
import type { Handler } from "../context.ts";
import { json, notFound } from "../respond.ts";
import type { Router } from "../router.ts";

export function iterationRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/repos/:owner/:name/iterations", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const forks = (await iterationsOf(ctx, repo))?.forks ?? [];
    const res = json({ forks, lanes: lanesOf(forks) });
    res.headers.set("cache-control", "private, no-cache");
    res.headers.set("vary", "authorization, cookie");
    return res;
  });
}
