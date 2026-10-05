/**
 * The feed's two routes: read it, and say what you did with an item. Both
 * are the signed-in viewer's own — there is no way to ask for another's.
 */

import { tell, UNVERIFIED_WORDS } from "../actions/tell.ts";
import { DIRECTION_NOTE } from "../crew/direct.ts";
import { audienceFilter } from "../core/event_audience.ts";
import { getEvent } from "../core/events.ts";
import {
  ITEM_ID,
  isInteractionKind,
  recordInteraction,
} from "../core/interactions.ts";
import { share, RECIPIENTS_MAX } from "../feed/share.ts";
import { canRead, getRepo, getRepoById } from "../core/repos.ts";
import {
  FEED_LIMIT_MAX,
  parseCursor,
  readFeed,
} from "../feed/feed.ts";
import { asksAnswer } from "../web/studio/asks.ts";
import {
  applyAsksBulk,
  undoAsksBulk,
  previewAsksBulk,
} from "../actions/asks_bulk.ts";
import type { FleetError } from "../actions/fleet.ts";
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

  // What asks the viewer, ranked, with the week's measure (`asksAnswer`).
  router.add("GET", "/api/v1/asks", (ctx) => {
    const viewer = ctx.auth.user;
    if (!viewer) return unauthorized();
    return json(asksAnswer(ctx, viewer), 200, {
      "cache-control": "private, no-store",
    });
  });

  // Many asks, one action (`actions/asks_bulk.ts`): a preview by default,
  // which needs only a read credential; acting takes rw, as acting on each
  // one would. The receipt is a fleet operation, undone below.
  router.add("POST", "/api/v1/asks/bulk", async (ctx) => {
    const input = await body(ctx.request);
    const preview = input.preview !== false;
    const denied = requireScope(ctx, preview ? "ro" : "rw");
    if (denied) return denied;
    if (preview) {
      const plan = previewAsksBulk(ctx.app, ctx.auth.user, input.action, input.items);
      if (!plan.ok) return bulkError(plan.error);
      return json({ preview: true, ...plan.value });
    }
    const op = await applyAsksBulk(ctx.app, ctx.auth.user, input.action, input.items);
    if (!op.ok) return bulkError(op.error);
    return json({ preview: false, ...op.value }, 201);
  });

  // Undo a bulk action on asks — only an asks operation: anything else a
  // fleet operation did takes an admin credential at /api/v1/fleet/ops.
  router.add("POST", "/api/v1/asks/bulk/:id/undo", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const op = await undoAsksBulk(ctx.app, ctx.auth.user, ctx.params.id!);
    if (!op.ok) return bulkError(op.error);
    return json(op.value, 201);
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

  // A tell from a card, as JSON, so the outbox can replay it by key.
  router.add("POST", "/api/v1/feed/tells", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const viewer = ctx.auth.user!;
    const input = await body(ctx.request);
    const text = str(input.text).trim();
    if (text === "" || text.length > 2000)
      return apiError("invalid_text", 422, "text is 1 to 2000 characters");
    const [owner, name, extra] = str(input.app).split("/");
    const repo =
      owner && name && extra === undefined
        ? getRepo(ctx.app.db, owner, name)
        : undefined;
    if (!repo || !canRead(ctx.app.db, repo, viewer)) return notFound();
    const told = await tell(ctx.app, viewer, repo, text);
    if (!told.ok)
      return told.error === "forbidden"
        ? apiError("forbidden", 403, DIRECTION_NOTE)
        : told.error === "unverified"
          ? apiError("unverified", 403, UNVERIFIED_WORDS)
          : apiError("refused", told.error === "unauthorized" ? 403 : 422, "that could not be told");
    return json({ issue: told.value.issue.number }, 201);
  });

  router.add("POST", "/api/v1/share", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const input = await body(ctx.request);
    const itemId = str(input.item);
    if (!ITEM_ID.test(itemId))
      return apiError("invalid_item", 422, "item is a feed item id");
    const to = parseTargets(input.to);
    if (to === undefined)
      return apiError(
        "invalid_target",
        422,
        `to is up to ${RECIPIENTS_MAX} usernames`,
      );
    const made = await share(ctx.app, ctx.auth.user!, itemId, to);
    if (!made.ok) return notFound();
    return json({ sent: made.value.sent }, 201);
  });
}

/** `to` as a list of usernames: absent, one, or a few; anything else is no. */
export function parseTargets(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length > RECIPIENTS_MAX) return undefined;
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== "string") return undefined;
    const name = v.trim().replace(/^@/, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}$/.test(name)) return undefined;
    out.push(name);
  }
  return out;
}

/** A bulk refusal, with the access codes in their fixed shapes. */
function bulkError(error: FleetError): Response {
  if (error.code === "not_found") return notFound();
  if (error.code === "unauthorized") return unauthorized();
  return apiError(
    error.code,
    error.code === "forbidden" ? 403 : error.code === "already_undone" ? 409 : 422,
    error.message,
  );
}
