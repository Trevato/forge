/**
 * A forge's children over the API: `/api/v1/forges` — the sizes, the
 * templates, the list, a spawn (planned before made), and a fresh claim
 * link. Moved out of `api.ts` (#6331); the rules live in `actions/spawn.ts` and `spawn/`.
 */

import { listChildren } from "../../actions/spawn.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { clientRows } from "../../spawn/clients.ts";
import { reissueDoor, spawnDoor } from "../../spawn/door.ts";
import { sizesView } from "../../spawn/sizes.ts";
import { templatesView } from "../../spawn/templates.ts";
import { crossOrigin, type Ctx, type Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { apiError, body, forbidden, json, requireScope } from "../respond.ts";
import type { Router } from "../router.ts";

/** A table any page or agent may read: the same JSON for everyone, so an ETag and five minutes' cache. */
function publicTable(ctx: Ctx, phase: string, view: () => unknown): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const text = timePhase(ctx.request, phase, () => JSON.stringify(view()));
  return timePhase(ctx.request, "render", () => {
    const etag = weakEtag(text);
    const headers = { etag, "cache-control": "public, max-age=300" };
    if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    return new Response(text, { headers: { "content-type": "application/json", ...headers } });
  });
}

export function forgeRoutes(router: Router<Handler>): void {
  // What small, medium and large mean, and which templates a child may
  // start from: public, and cacheable by ETag.
  router.add("GET", "/api/v1/forges/sizes", (ctx) => publicTable(ctx, "sizes", sizesView));
  router.add("GET", "/api/v1/forges/templates", (ctx) => publicTable(ctx, "templates", templatesView));

  // The client list (docs/SPAWN.md): an admin's, the rows /forges and the MCP
  // `forges` tool show, what needs attention first.
  router.add("GET", "/api/v1/forges", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    if (!ctx.auth.user?.isAdmin) return forbidden();
    const items = await timePhaseAsync(ctx.request, "read", async () => {
      // The row, and beside it what the list always carried: which template a child came from, where it is placed.
      const [rows, children] = await Promise.all([clientRows(ctx.app), listChildren(ctx.app)]);
      const kept = new Map(children.map((c) => [c.name, c]));
      return rows.map((row) => {
        const c = kept.get(row.name);
        return c === undefined
          ? row
          : { ...row, bodyId: c.bodyId, done: c.done, createdAt: c.createdAt, placement: c.placement, placementNote: c.placementNote, ...(c.template === undefined ? {} : { template: c.template }) };
      });
    });
    return timePhase(ctx.request, "render", () => json({ items, next_cursor: null }));
  });

  // `dryRun` is true unless it is `false`: the plan, and nothing is made.
  // A stranger may spawn too (rate-limited in the door); a signed-in
  // caller needs an `rw` token as before.
  router.add("POST", "/api/v1/forges", async (ctx) => {
    const input = await body(ctx.request);
    if (ctx.auth.user !== undefined) {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
    } else if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) {
      return forbidden();
    }
    if (typeof input !== "object" || input === null || Array.isArray(input))
      return apiError("invalid", 422, "send a JSON object: name, apps, crew, dryRun");
    const door = await spawnDoor(ctx, ctx.auth.user, input as Record<string, unknown>);
    return json(door.body, door.status);
  });

  // A new claim link for a child nobody has claimed (#729); the old one dies.
  router.add("POST", "/api/v1/forges/:name/claim-link", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const door = await reissueDoor(ctx, ctx.auth.user!, ctx.params["name"] ?? "");
    return json(door.body, door.status);
  });
}
