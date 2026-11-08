/**
 * A repository's labels over the API: `GET` and `POST`
 * `/api/v1/repos/:owner/:name/labels`, and `PATCH` and `DELETE` `…/labels/:id`. Moved
 * out of `api.ts` (#6303); the rules live in `actions/repos.ts`.
 */

import { createLabel, deleteLabel, updateLabel } from "../../actions/repos.ts";
import { LABEL_WORDS } from "../../actions/label_words.ts";
import { labelsWithOpen, listLabels } from "../../core/issues.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { canWrite } from "../../core/repos.ts";
import { loadRepo, pageOf, pageParams } from "../api.ts";
import { holds, weakEtag } from "../etag.ts";
import type { Handler } from "../context.ts";
import { body, json, notFound, requireScope, respondAccess, str } from "../respond.ts";
import type { Router } from "../router.ts";

export function labelsRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/repos/:owner/:name/labels", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const page = pageParams(ctx);
    if (page instanceof Response) return page;
    // Sealed items are counted, so only a writer is told how many are open.
    const rows = timePhase(ctx.request, "labels", () =>
      labelsWithOpen(ctx.app.db, repo.id, canWrite(ctx.app.db, repo, ctx.auth.user)),
    );
    const res = timePhase(ctx.request, "render", () => pageOf(rows, page));
    if (res.status !== 200) return res;
    // The tag is over the rendered page, which already carries this reader's open counts.
    const text = await res.text();
    const etag = weakEtag(text);
    const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
    if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    return new Response(text, { headers: { "content-type": res.headers.get("content-type") ?? "application/json", ...headers } });
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

  router.add("PATCH", "/api/v1/repos/:owner/:name/labels/:id", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    if (input.name === undefined && input.color === undefined)
      return json({ error: "invalid", message: "update names a new name, a new color, or both" }, 422);
    if (
      (input.name !== undefined && typeof input.name !== "string") ||
      (input.color !== undefined && typeof input.color !== "string")
    )
      return json({ error: "invalid", message: LABEL_WORDS.shape }, 422);
    const id = ctx.params.id!;
    const current = listLabels(ctx.app.db, repo.id).find((l) => l.id === id);
    if (!current) return notFound();
    const updated = updateLabel(
      ctx.app,
      ctx.auth.user,
      repo,
      id,
      input.name === undefined ? current.name : (input.name as string),
      input.color === undefined ? current.color : (input.color as string),
    );
    if (!updated.ok) {
      if (updated.error === "invalid" || updated.error === "taken")
        return json(
          { error: updated.error, message: updated.error === "taken" ? LABEL_WORDS.taken : LABEL_WORDS.shape },
          422,
        );
      return respondAccess(updated.error, 422);
    }
    return json(updated.value);
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
