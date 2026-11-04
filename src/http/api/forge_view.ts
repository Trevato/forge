/**
 * GET /api/v1/forge/view: the forge as one read-only picture (apps, runs and
 * their stations, health), for a reader that draws it. Any scope reads it;
 * there is no write on this path. See docs/features/forge-view.md.
 */
import { forgeViewText } from "../../actions/forge_view.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { requireScope } from "../respond.ts";
import type { Router } from "../router.ts";

export function forgeViewRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/forge/view", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    const user = ctx.auth.user!;
    const text = timePhase(ctx.request, "view", () => forgeViewText(ctx, user));
    // The tag leaves out the moment it was built, so an unchanged forge is a 304.
    const etag = weakEtag(text.replace(/,"at":"[^"]*"\}$/, "}"));
    const headers = { etag, "cache-control": "private, max-age=2", vary: "authorization, cookie" };
    if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    return new Response(text, { headers: { "content-type": "application/json", ...headers } });
  });
}
