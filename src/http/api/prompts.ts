/**
 * A repository's prompt sources over the API:
 * `/api/v1/repos/:owner/:name/prompts` — list, add, run one now, remove.
 * Moved out of `api.ts` (#6334); the rules live in `actions/prompts.ts`.
 */

import {
  addPromptSource,
  listPromptSources,
  removePromptSource,
  runPromptSource,
} from "../../actions/prompts.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { loadRepo } from "../api.ts";
import type { Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { body, json, notFound, requireScope, respondAccess, str } from "../respond.ts";
import type { Router } from "../router.ts";

export function promptRoutes(router: Router<Handler>): void {
  // Where the crew's next tell comes from when nobody is typing
  // (docs/APPS.md, "Prompts from Instagram"). Admin scope and admin over
  // the repository; the token goes in once and never comes back out.
  router.add("GET", "/api/v1/repos/:owner/:name/prompts", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const listed = timePhase(ctx.request, "prompts", () => listPromptSources(ctx.app, ctx.auth.user, repo));
    if (!listed.ok) return respondAccess(listed.error, 422);
    // Tagged only after the access check, over the exact bytes sent: an added, edited, run or removed
    // source moves it, and a viewer shown a different body gets a different tag.
    return timePhase(ctx.request, "render", () => {
      const text = JSON.stringify({ items: listed.value, next_cursor: null });
      const etag = weakEtag(text);
      const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
      if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
      return new Response(text, { headers: { "content-type": "application/json", ...headers } });
    });
  });

  router.add("POST", "/api/v1/repos/:owner/:name/prompts", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const added = addPromptSource(ctx.app, ctx.auth.user, repo, {
      kind: str(input.kind),
      token: str(input.token),
      at: str(input.at),
    });
    if (!added.ok) return respondAccess(added.error, 422);
    return json(added.value, 201);
  });

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/prompts/:id/run",
    async (ctx) => {
      const denied = requireScope(ctx, "admin");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const ran = await runPromptSource(
        ctx.app,
        ctx.auth.user,
        repo,
        ctx.params.id ?? "",
      );
      if (!ran.ok) return respondAccess(ran.error, 422);
      return json(ran.value);
    },
  );

  router.add("DELETE", "/api/v1/repos/:owner/:name/prompts/:id", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const removed = removePromptSource(
      ctx.app,
      ctx.auth.user,
      repo,
      ctx.params.id ?? "",
    );
    if (!removed.ok) return respondAccess(removed.error, 422);
    return json({}, 200);
  });
}
