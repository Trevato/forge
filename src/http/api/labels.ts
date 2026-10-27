/**
 * A repository's labels over the API: `GET` and `POST`
 * `/api/v1/repos/:owner/:name/labels`, and `DELETE` `…/labels/:id`. Moved
 * out of `api.ts` (#6303); the rules live in `actions/repos.ts`.
 */

import { createLabel, deleteLabel } from "../../actions/repos.ts";
import { listLabels } from "../../core/issues.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { loadRepo, pageOf, pageParams } from "../api.ts";
import type { Handler } from "../context.ts";
import { body, json, notFound, requireScope, respondAccess, str } from "../respond.ts";
import type { Router } from "../router.ts";

export function labelsRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/repos/:owner/:name/labels", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const page = pageParams(ctx);
    if (page instanceof Response) return page;
    const rows = timePhase(ctx.request, "labels", () => listLabels(ctx.app.db, repo.id));
    return timePhase(ctx.request, "render", () => pageOf(rows, page));
  });

  router.add("POST", "/api/v1/repos/:owner/:name/labels", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const created = createLabel(
      ctx.app,
      ctx.auth.user,
      repo,
      str(input.name),
      str(input.color) || "6b7280",
    );
    if (!created.ok) return respondAccess(created.error, 422);
    return json(created.value, 201);
  });

  router.add("DELETE", "/api/v1/repos/:owner/:name/labels/:id", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const removed = deleteLabel(ctx.app, ctx.auth.user, repo, ctx.params.id!);
    if (!removed.ok) return respondAccess(removed.error, 422);
    return new Response(null, { status: 204 });
  });
}
