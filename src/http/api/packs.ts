/**
 * Curated packs over the API (#11006): `GET /api/v1/packs`,
 * `GET /api/v1/packs/{name}` and `PUT /api/v1/packs/{name}` with
 * `{title, pitch, brief, repos:[owner/name…]}`. The rules live in
 * `packs/curated.ts`, the same ones the page uses. A PUT makes the pack when
 * the name is new; an admin who is not an agent, and a token that may write.
 */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { editPack, getPack, history, listPacks, mayCurate, resolveRepos, type CuratedPack } from "../../packs/curated.ts";
import { crossOrigin, type Ctx, type Handler } from "../context.ts";
import { apiError, body, forbidden, json, requireScope } from "../respond.ts";
import type { Router } from "../router.ts";

const view = (ctx: Ctx, p: CuratedPack) => ({
  name: p.name,
  title: p.title,
  pitch: p.pitch,
  brief: p.brief,
  shown: resolveRepos(ctx.app.db, p, ctx.auth.user).filter((r) => r.left === undefined).map((r) => r.full),
  // The list as kept, with why each left one is left out, names private and missing repos: a person admin's only.
  ...(mayCurate(ctx.auth.user)
    ? { repos: p.repos, left_out: resolveRepos(ctx.app.db, p, ctx.auth.user).filter((r) => r.left !== undefined).map((r) => ({ repo: r.full, why: r.left })) }
    : {}),
});

export function packRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/packs", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    return json({ items: listPacks(ctx.app.db).map((p) => view(ctx, p)), next_cursor: null });
  });
  router.add("GET", "/api/v1/packs/:name", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const pack = getPack(ctx.app.db, ctx.params.name ?? "");
    if (pack === undefined) return apiError("not_found", 404, "no such pack");
    return json({ ...view(ctx, pack), ...(mayCurate(ctx.auth.user) ? { history: history(ctx.app.db, pack.name) } : {}) });
  });
  router.add("PUT", "/api/v1/packs/:name", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    if (!mayCurate(ctx.auth.user)) return forbidden();
    const input = await body(ctx.request);
    const name = ctx.params.name ?? "";
    const create = getPack(ctx.app.db, name) === undefined;
    const done = editPack(ctx.app.db, ctx.auth.user, name, { title: input["title"], pitch: input["pitch"], brief: input["brief"], repos: input["repos"] }, create);
    if (!done.ok) return apiError(done.error, done.error === "not_found" ? 404 : done.error === "forbidden" ? 403 : done.error === "exists" ? 409 : 422, done.says);
    return json(view(ctx, done.pack), create ? 201 : 200);
  });
}
