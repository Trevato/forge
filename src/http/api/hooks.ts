/**
 * A repository's webhooks over the API: `GET` and `POST`
 * `/api/v1/repos/:owner/:name/hooks`, and `DELETE` `…/hooks/:id`;
 * `GET …/hooks/:id/deliveries` answers the last twenty; `POST
 * …/hooks/:id/pause` and `…/resume` stop and restart deliveries (#10104).
 * Moved out of `api.ts` (#6333); the rules live in `actions/repos.ts`.
 * Admin-scoped, since a webhook exfiltrates repo events.
 */

import { createWebhook, deleteWebhook, pauseWebhook, redeliverWebhook } from "../../actions/repos.ts";
import { canAdmin } from "../../core/repos.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { getWebhook, listWebhooks, pingWebhook, recentDeliveries } from "../../core/webhooks.ts";
import { loadRepo, pageParams, slicePage } from "../api.ts";
import type { Ctx, Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { body, json, notFound, requireScope, respondAccess, str, tryAgain } from "../respond.ts";
import type { Router } from "../router.ts";

/**
 * An admin's answer, tagged by its own bytes: `private, no-cache` and varied
 * on the credential, so a repeat holding the tag is a bodiless 304. Called
 * only after the admin check, so a stranger never reaches a 304.
 */
function tagged(ctx: Ctx, data: unknown): Response {
  const text = JSON.stringify(data);
  const etag = weakEtag(text);
  const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
  if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
  return new Response(text, { headers: { "content-type": "application/json", ...headers } });
}

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
    const sliced = slicePage(rows, page);
    if (sliced instanceof Response) return sliced;
    return timePhase(ctx.request, "render", () => tagged(ctx, sliced));
  });

  router.add("GET", "/api/v1/repos/:owner/:name/hooks/:id/deliveries", (ctx) => {
    const denied = requireScope(ctx, "admin");
    // A token short of admin learns nothing: the same 404 as a missing hook.
    if (denied) return denied.status === 403 ? notFound() : denied;
    const repo = loadRepo(ctx);
    if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return notFound();
    if (!getWebhook(ctx.app.db, repo.id, ctx.params.id!)) return notFound();
    return tagged(ctx, { items: recentDeliveries(ctx.app.db, ctx.params.id!, 20) });
  });

  router.add("POST", "/api/v1/repos/:owner/:name/hooks/:id/ping", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied.status === 403 ? notFound() : denied;
    const repo = loadRepo(ctx);
    if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return notFound();
    const hook = getWebhook(ctx.app.db, repo.id, ctx.params.id!);
    if (!hook) return notFound();
    const pinged = pingWebhook(ctx.app.db, `${ctx.params.owner}/${ctx.params.name}`, hook);
    if (!pinged.ok)
      return tryAgain("rate_limited", 429, `too many pings: try again in ${pinged.error.retryAfter} s`, pinged.error.retryAfter);
    return json({ id: pinged.value.id }, 202);
  });

  const setActive = (pause: boolean): Handler => (ctx) => {
    const denied = requireScope(ctx, "admin");
    // As for ping: a token short of admin learns nothing, the same 404.
    if (denied) return denied.status === 403 ? notFound() : denied;
    const repo = loadRepo(ctx);
    if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return notFound();
    const done = pauseWebhook(ctx.app, ctx.auth.user, repo, ctx.params.id!, pause);
    if (!done.ok) return notFound();
    return json({ id: ctx.params.id!, active: !pause });
  };
  router.add("POST", "/api/v1/repos/:owner/:name/hooks/:id/pause", setActive(true));
  router.add("POST", "/api/v1/repos/:owner/:name/hooks/:id/resume", setActive(false));
  router.add("POST", "/api/v1/repos/:owner/:name/hooks/:id/deliveries/:delivery/redeliver", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied.status === 403 ? notFound() : denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const done = redeliverWebhook(ctx.app, ctx.auth.user, repo, ctx.params.id!, ctx.params.delivery!);
    if (done.ok) return json({ id: ctx.params.delivery!, state: "pending" });
    if (done.error === "not_failed")
      return json({ error: "conflict", message: "only a failed delivery can be sent again" }, 409);
    if (done.error === "sealed")
      return json({ error: "conflict", message: "this delivery belongs to a sealed report and stays refused" }, 409);
    return notFound();
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
