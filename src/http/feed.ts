/**
 * The feed's two routes: read it, and say what you did with an item. Both
 * are the signed-in viewer's own — there is no way to ask for another's.
 */

import { audienceFilter } from "../core/event_audience.ts";
import { getEvent } from "../core/events.ts";
import {
  ITEM_ID,
  isInteractionKind,
  recordInteraction,
} from "../core/interactions.ts";
import { canRead, getRepo, getRepoById } from "../core/repos.ts";
import {
  FEED_LIMIT_MAX,
  parseCursor,
  readFeed,
} from "../feed/feed.ts";
import type { Handler } from "./context.ts";
import type { Router } from "./router.ts";
import {
  apiError,
  body,
  json,
  notFound,
  requireScope,
  str,
  unauthorized,
} from "./respond.ts";

export function feedRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/feed", (ctx) => {
    const viewer = ctx.auth.user;
    if (!viewer) return unauthorized();
    const q = ctx.url.searchParams;
    const rawLimit = q.get("limit");
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    if (
      limit !== undefined &&
      (!Number.isInteger(limit) || limit < 1 || limit > FEED_LIMIT_MAX)
    )
      return apiError("invalid_limit", 422, `limit is 1 to ${FEED_LIMIT_MAX}`);
    const rawCursor = q.get("cursor");
    const cursor = rawCursor === null ? undefined : parseCursor(rawCursor);
    if (rawCursor !== null && cursor === undefined)
      return apiError("invalid_cursor", 422, "that cursor was not issued here");
    return json(
      readFeed(ctx.app.db, viewer, {
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
      200,
      { "cache-control": "private, no-store" },
    );
  });

  router.add("POST", "/api/v1/feed/interactions", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const viewer = ctx.auth.user!;
    const db = ctx.app.db;
    const input = await body(ctx.request);
    const itemId = str(input.item);
    const kind = input.kind;
    if (!ITEM_ID.test(itemId))
      return apiError("invalid_item", 422, "item is a feed item id");
    if (!isInteractionKind(kind))
      return apiError("invalid_kind", 422, "kind is not one the feed knows");

    // What the act is about is read from the item when the item is an event
    // — through the same visibility the feed used — and from the named
    // repository otherwise. Anything the viewer cannot read is not found.
    let repoId: string | null = null;
    let actorId: string | null = null;
    if (itemId.startsWith("event:")) {
      const event = getEvent(db, itemId.slice("event:".length));
      const repo = event?.repoId ? getRepoById(db, event.repoId) : undefined;
      if (!event || !repo || !canRead(db, repo, viewer)) return notFound();
      if (!audienceFilter(db, viewer)(event)) return notFound();
      repoId = repo.id;
      actorId = event.actorId;
    } else {
      const [owner, name, extra] = str(input.app).split("/");
      const repo =
        owner && name && extra === undefined
          ? getRepo(db, owner, name)
          : undefined;
      if (!repo || !canRead(db, repo, viewer)) return notFound();
      repoId = repo.id;
    }
    const made = recordInteraction(db, {
      viewerId: viewer.id,
      itemId,
      kind,
      repoId,
      actorId,
    });
    return json({ id: made.id }, 201);
  });
}
