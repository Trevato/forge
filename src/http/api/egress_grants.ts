/**
 * A repository's egress grants over the API: `GET`, `POST` and `DELETE`
 * `/api/v1/repos/:owner/:name/egress-grants`. Moved out of `api.ts` (#6304);
 * the rules live in `actions/egress_grants.ts`.
 */

import { egressView, grantAppEgress, revokeAppEgress } from "../../actions/egress_grants.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { loadRepo } from "../api.ts";
import type { Handler } from "../context.ts";
import { body, json, notFound, requireScope, respondAccess, str } from "../respond.ts";
import type { Router } from "../router.ts";

export function egressGrantRoutes(router: Router<Handler>): void {
  // A site admin's grant of one private destination forge.json asks for
  // (#3433). Reading takes admin over the repository; changing takes a site
  // admin. The destination is the exact `host:port` forge.json names.
  router.add("GET", "/api/v1/repos/:owner/:name/egress-grants", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const view = await timePhaseAsync(ctx.request, "grants", () =>
      egressView(ctx.app, ctx.auth.user, repo),
    );
    if (!view.ok) return respondAccess(view.error, 422);
    return timePhase(ctx.request, "render", () =>
      json({ items: view.value.rows, changes: view.value.changes, next_cursor: null }),
    );
  });

  router.add("POST", "/api/v1/repos/:owner/:name/egress-grants", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const granted = await grantAppEgress(
      ctx.app,
      ctx.auth.user,
      repo,
      str(input.destination),
    );
    if (!granted.ok) return respondAccess(granted.error, 422);
    return json(granted.value, 201);
  });

  router.add("DELETE", "/api/v1/repos/:owner/:name/egress-grants", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const revoked = revokeAppEgress(
      ctx.app,
      ctx.auth.user,
      repo,
      str(input.destination),
    );
    if (!revoked.ok) return respondAccess(revoked.error, 422);
    return json({}, 200);
  });
}
