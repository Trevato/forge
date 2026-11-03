/**
 * Build pins over the API: list, pin, add a note, delete
 * (`actions/builds.ts`, `git/builds.ts`). Reading is the repository's
 * readers'; every write needs the `rw` scope and a person who writes.
 */

import { deletePin, notePin, pinBuild } from "../../actions/builds.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { listBuildPins } from "../../git/builds.ts";
import { repoDir } from "../../git/repos.ts";
import { holds, weakEtag } from "../etag.ts";
import { loadRepo } from "../api.ts";
import type { Handler } from "../context.ts";
import { body, json, notFound, requireScope, respondAccess, str } from "../respond.ts";
import type { Router } from "../router.ts";

const STATUS: Record<string, number> = { exists: 409, mirrored: 409, moved: 409 };

export function buildRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/repos/:owner/:name/builds", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const items = await listBuildPins(repoDir(ctx.app.reposRoot, repo.ownerName, repo.name));
    // The tag is of the exact bytes sent, so a new, noted or deleted pin changes it;
    // private because a private repository's pins are for its readers only.
    const text = JSON.stringify({ items, next_cursor: null });
    const etag = weakEtag(text);
    const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
    if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    return new Response(text, { headers: { "content-type": "application/json", ...headers } });
  });

  router.add("POST", "/api/v1/repos/:owner/:name/builds", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const pinned = await pinBuild(ctx.app, ctx.auth.user, repo, {
      label: str(input.label),
      oid: str(input.sha),
      note: str(input.note),
      parent: str(input.parent),
      source: str(input.source) || "api",
    });
    return pinned.ok ? json(pinned.value, 201) : respondAccess(pinned.error, STATUS[pinned.error] ?? 422);
  });

  router.add("DELETE", "/api/v1/repos/:owner/:name/builds/:label", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const done = await deletePin(ctx.app, ctx.auth.user, repo, ctx.params.label ?? "");
    return done.ok ? new Response(null, { status: 204 }) : respondAccess(done.error, STATUS[done.error] ?? 422);
  });

  router.add("PATCH", "/api/v1/repos/:owner/:name/builds/:label", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const done = await notePin(ctx.app, ctx.auth.user, repo, ctx.params.label ?? "", {
      ...(typeof input.notes === "string" ? { notes: input.notes } : {}),
      ...(typeof input.note === "string" ? { note: input.note } : {}),
      ...(typeof input.body === "string" ? { body: input.body } : {}),
    });
    return done.ok ? json(done.value.pin) : respondAccess(done.error, STATUS[done.error] ?? 422);
  });
}
