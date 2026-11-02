/**
 * Forge-level secrets over the API: `GET /api/v1/secrets/:scope`, and `PUT`
 * and `DELETE` `/api/v1/secrets/:scope/:name`. Moved out of `api.ts` (#6330);
 * the rules live in `actions/secrets.ts`.
 */

import { listSecrets, putSecret, removeSecret } from "../../actions/secrets.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Handler } from "../context.ts";
import { body, json, requireScope, respondAccess, str } from "../respond.ts";
import type { Router } from "../router.ts";

export function secretRoutes(router: Router<Handler>): void {
  // Forge-level secrets: a sealed, write-only slot for the operator's own
  // credentials. Admins only; the list is names and timestamps, never a
  // value. `ref` names the owner: an org's name, or a repository's
  // `owner/name`; the forge scope takes none.
  router.add("GET", "/api/v1/secrets/:scope", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const listed = timePhase(ctx.request, "secrets", () =>
      listSecrets(
        ctx.app,
        ctx.auth.user,
        ctx.params.scope ?? "",
        ctx.url.searchParams.get("ref") ?? "",
      ),
    );
    if (!listed.ok) return respondAccess(listed.error, 422);
    return timePhase(ctx.request, "render", () => json({ items: listed.value, next_cursor: null }));
  });

  router.add("PUT", "/api/v1/secrets/:scope/:name", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const set = putSecret(
      ctx.app,
      ctx.auth.user,
      ctx.params.scope ?? "",
      str(input.ref),
      ctx.params.name ?? "",
      str(input.value),
    );
    if (!set.ok) return respondAccess(set.error, 422);
    return json(set.value);
  });

  router.add("DELETE", "/api/v1/secrets/:scope/:name", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const removed = removeSecret(
      ctx.app,
      ctx.auth.user,
      ctx.params.scope ?? "",
      ctx.url.searchParams.get("ref") ?? "",
      ctx.params.name ?? "",
    );
    if (!removed.ok) return respondAccess(removed.error, 422);
    return json({}, 200);
  });
}
