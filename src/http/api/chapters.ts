/**
 * Chapters over the API (#11603), in the same words as the page: the list with each chapter's items,
 * and the owner's acts (draft, open, add, remove, ship, patch). The rules are in `core/chapters.ts`
 * and the acts in `actions/chapters.ts`; this only reads the request and answers the result.
 */

import { CHAPTER_WORDS, close, draft, fill, open, patch } from "../../actions/chapters.ts";
import { itemsOf, listChapters, progressOf, type Chapter } from "../../core/chapters.ts";
import type { Handler } from "../context.ts";
import { apiError, body, json, notFound, requireScope } from "../respond.ts";
import { loadRepo } from "../api.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Router } from "../router.ts";

const shape = (db: Parameters<typeof itemsOf>[0], c: Chapter, now: Date) => {
  const items = itemsOf(db, c);
  return {
    name: c.name,
    means: c.means,
    state: c.state,
    patchOf: c.patchOf,
    openedAt: c.openedAt,
    closedAt: c.closedAt,
    tag: c.state === "closed" ? { name: c.name, oid: c.tagOid } : null,
    notes: c.notes,
    costUsd: c.costUsd,
    progress: progressOf(c, items, now),
    items: items.map((i) => ({ number: i.number, title: i.title, status: i.status, doneAt: i.doneAt, pull: i.pull, builder: i.builder, costUsd: i.costUsd })),
  };
};

export function chapterRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/repos/:owner/:name/chapters", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const now = new Date();
    return json({ chapters: listChapters(ctx.app.db, repo.id).map((c) => shape(ctx.app.db, c, now)) }, 200, { "cache-control": "no-store" });
  });

  router.add("POST", "/api/v1/repos/:owner/:name/chapters", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const made = draft(ctx.app, ctx.auth.user, repo, {
      name: typeof input["name"] === "string" ? input["name"] : "",
      means: typeof input["means"] === "string" ? input["means"] : "",
    });
    if (!made.ok) return apiError(made.error, made.error === "forbidden" ? 403 : made.error === "exists" ? 409 : 422, CHAPTER_WORDS[made.error]);
    return json(shape(ctx.app.db, made.value, new Date()), 201);
  });

  router.add("POST", "/api/v1/repos/:owner/:name/chapters/:chapter/:verb", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const name = ctx.params.chapter ?? "";
    const verb = ctx.params.verb ?? "";
    const number = typeof input["number"] === "number" ? input["number"] : Number.NaN;
    const done =
      verb === "open" ? open(ctx.app, ctx.auth.user, repo, name)
        : verb === "add" || verb === "remove" ? fill(ctx.app, ctx.auth.user, repo, name, number, verb === "add")
        : verb === "ship" ? await close(ctx.app, ctx.auth.user, repo, name, true)
        : verb === "patch" ? patch(ctx.app, ctx.auth.user, repo, name)
        : null;
    if (done === null) return notFound();
    if (!done.ok)
      return apiError(done.error, done.error === "forbidden" ? 403 : done.error === "not_found" || done.error === "no_issue" ? 404 : 409, CHAPTER_WORDS[done.error]);
    const value = done.value;
    return json(value === undefined ? { ok: true } : shape(ctx.app.db, value, new Date()), 200);
  });
}
