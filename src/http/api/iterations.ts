/**
 * A fork family's build pins and runs as JSON (`core/iterations.ts`), the
 * same the Iterations page draws, for the viewer: private forks they may not
 * read are absent. A family with no pin answers empty lists.
 */

import { iterationsOf, lanesOf } from "../../core/iterations.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { loadRepo } from "../api.ts";
import type { Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { notFound } from "../respond.ts";
import type { Router } from "../router.ts";

export function iterationRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/repos/:owner/:name/iterations", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const forks = (await iterationsOf(ctx, repo))?.forks ?? [];
    // The tag is of the exact bytes sent for this viewer, reached only past the access check: a fork made,
    // deleted, pushed or turned private changes the body, and so the tag (#9223).
    const text = JSON.stringify({ forks, lanes: lanesOf(forks) });
    const etag = weakEtag(text);
    const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
    if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    return new Response(text, { headers: { "content-type": "application/json", ...headers } });
  });
}
