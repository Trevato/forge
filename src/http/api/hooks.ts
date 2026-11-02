/**
 * A repository's webhooks over the API: `GET` and `POST`
 * `/api/v1/repos/:owner/:name/hooks`, and `DELETE` `…/hooks/:id`;
 * `GET …/hooks/:id/deliveries` answers the last twenty. Moved out of
 * `api.ts` (#6333); the rules live in `actions/repos.ts`. Admin-scoped,
 * since a webhook exfiltrates repo events.
 */

import { createWebhook, deleteWebhook } from "../../actions/repos.ts";
import { canAdmin } from "../../core/repos.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { getWebhook, listWebhooks, recentDeliveries } from "../../core/webhooks.ts";
import { loadRepo, pageOf, pageParams } from "../api.ts";
import type { Handler } from "../context.ts";
import { body, json, notFound, requireScope, respondAccess, str } from "../respond.ts";
import type { Router } from "../router.ts";

export function hookRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/repos/:owner/:name/hooks", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return notFound();
    const page = pageParams(ctx);
    if (page instanceof Response) return page;
    const rows = timePhase(ctx.request, "hooks", () => listWebhooks(ctx.app.db, repo.id));
    return timePhase(ctx.request, "render", () => pageOf(rows, page));
  });

  router.add("GET", "/api/v1/repos/:owner/:name/hooks/:id/deliveries", (ctx) => {
    const denied = requireScope(ctx, "admin");
    // A token short of admin learns nothing: the same 404 as a missing hook.
    if (denied) return denied.status === 403 ? notFound() : denied;
    const repo = loadRepo(ctx);
    if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return notFound();
    if (!getWebhook(ctx.app.db, repo.id, ctx.params.id!)) return notFound();
    return json({ items: recentDeliveries(ctx.app.db, ctx.params.id!, 20) });
  });

  router.add("POST", "/api/v1/repos/:owner/:name/hooks", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const created = createWebhook(ctx.app, ctx.auth.user, repo, {
      url: str(input.url),
      kinds: str(input.kinds) || "*",
      ...(typeof input.secret === "string" ? { secret: input.secret } : {}),
    });
    if (!created.ok) return respondAccess(created.error, 422);
    // The secret is returned exactly once, at creation.
    return json(
      { ...created.value.webhook, secret: created.value.secret },
      201,
    );
  });

  router.add("DELETE", "/api/v1/repos/:owner/:name/hooks/:id", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const removed = deleteWebhook(ctx.app, ctx.auth.user, repo, ctx.params.id!);
    return json({}, removed.ok ? 200 : 404);
  });
}
