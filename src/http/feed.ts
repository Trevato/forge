/**
 * The feed's two routes: read it, and say what you did with an item. Both
 * are the signed-in viewer's own — there is no way to ask for another's.
 */

import {
  parseVariants,
  FROM_WORDS,
  tell,
  UNVERIFIED_WORDS,
  VARIANTS_MAX,
} from "../actions/tell.ts";
import { parseFrom, TELL_TEXT_MAX } from "../actions/tell_from.ts";
import { DIRECTION_NOTE } from "../crew/direct.ts";
import { readInteraction } from "../feed/interact.ts";
import { toggleLike } from "../feed/likes.ts";
import {
  ITEM_ID,
  INTERACTION_KINDS,
  recordInteraction,
} from "../core/interactions.ts";
import { chipsOf, isKindChip, setChip } from "../core/feed_chips.ts";
import { CURSOR_NOT_ISSUED, KIND_HAS_NO_CHIP } from "../actions/feed_words.ts";
import { getUserByName, getUsersByIds } from "../core/users.ts";
import { drainQueue } from "../core/shares.ts";
import { feedTag, hasQueuedShares } from "../feed/feed_tag.ts";
import { lastVisit } from "../core/home_visit.ts";
import { feedDigest } from "../web/studio/since.ts";
import { holds } from "../web/feeds.ts";
import { share, RECIPIENTS_MAX } from "../feed/share.ts";
import { canRead, getRepo } from "../core/repos.ts";
import {
  FEED_LIMIT_MAX,
  parseCursor,
  readFeed,
} from "../feed/feed.ts";
import { giveBack } from "../actions/give_back.ts";
import { decideAsk, undoDecideAsk } from "../actions/asks_decide.ts";
import { actOnProposal, isProposalVerb } from "../actions/proposals.ts";
import { asksAnswer } from "../web/studio/asks.ts";
import {
  applyAsksBulk,
  undoAsksBulk,
  previewAsksBulk,
} from "../actions/asks_bulk.ts";
import type { FleetError } from "../actions/fleet.ts";
import { notePhase, takeSessionTime, timePhase } from "../core/route_timing.ts";
import type { Handler } from "./context.ts";
import type { Router } from "./router.ts";
import { HIDDEN_WORDS } from "../core/arg_words.ts";
import {
  apiError,
  body,
  json,
  notFound,
  requireScope,
  str,
  unauthorized,
} from "./respond.ts";

/** What a card may report: the interaction kinds, and a like (a toggle, not a row of its own). */
const DOOR_KINDS = [...INTERACTION_KINDS, "liked" as const];

export function feedRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/feed", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
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
      return apiError("invalid_cursor", 422, CURSOR_NOT_ISSUED);
    // A 304 only when nothing the viewer would read has changed (`feedTag`).
    // The queue drains first, as `readFeed` would; shares still waiting
    // depend on the clock, so they always get a page.
    const now = Date.now();
    drainQueue(ctx.app.db, viewer.id, now);
    const tag = feedTag(ctx.app.db, viewer, {
      chips: chipsOf(ctx.app.db, viewer.id),
      cursor: rawCursor,
      limit: limit ?? null,
      now,
      visit: rawCursor === null ? lastVisit(ctx.app.db, viewer.id) : undefined,
    });
    const headers: Record<string, string> = {
      "cache-control": "private, no-store",
      vary: "authorization, cookie",
      ...(tag === undefined ? {} : { etag: tag }),
    };
    if (
      tag !== undefined &&
      holds(ctx.request.headers.get("if-none-match"), tag) &&
      !hasQueuedShares(ctx.app.db, viewer.id)
    )
      return new Response(null, { status: 304, headers });
    const page = timePhase(ctx.request, "feed", () =>
      readFeed(ctx.app.db, viewer, {
        phase: (name, ms) => notePhase(ctx.request, name, ms),
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    // The first page carries home's "Since you were here" card, as MCP `feed` does.
    const digest =
      cursor === undefined
        ? timePhase(ctx.request, "digest", () => feedDigest(ctx.app.db, viewer, now))
        : undefined;
    return timePhase(ctx.request, "render", () =>
      json(cursor === undefined ? { ...page, digest } : page, 200, headers),
    );
  });

  // The chips the viewer switched off, and switching one: a kind of post or
  // a person by username. Saved per viewer; the feed, home and inbox read it.
  const chipsAnswer = (ctx: Parameters<Handler>[0]) => {
    const chips = chipsOf(ctx.app.db, ctx.auth.user!.id);
    return {
      kinds: [...chips.kinds].sort(),
      people: [...getUsersByIds(ctx.app.db, [...chips.people]).values()]
        .map((u) => u.username)
        .sort(),
    };
  };
  router.add("GET", "/api/v1/feed/chips", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (!ctx.auth.user) return unauthorized();
    const answer = timePhase(ctx.request, "chips", () => chipsAnswer(ctx));
    return timePhase(ctx.request, "render", () =>
      json(answer, 200, { "cache-control": "private, no-store" }),
    );
  });
  router.add("POST", "/api/v1/feed/chips", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const input = await body(ctx.request);
    const value = str(input.value);
    if (typeof input.hidden !== "boolean")
      return apiError("invalid_hidden", 422, HIDDEN_WORDS);
    if (input.kind === "kind") {
      if (!isKindChip(value))
        return apiError("invalid_chip", 422, KIND_HAS_NO_CHIP);
      setChip(ctx.app.db, ctx.auth.user!.id, { kind: "kind", value }, input.hidden);
    } else if (input.kind === "person") {
      const who = getUserByName(ctx.app.db, value);
      if (!who || who.kind === "org") return notFound();
      setChip(ctx.app.db, ctx.auth.user!.id, { kind: "person", value: who.id }, input.hidden);
    } else return apiError("invalid_chip", 422, "kind is `kind` or `person`");
    return json(chipsAnswer(ctx), 200, { "cache-control": "private, no-store" });
  });

  // What asks the viewer, ranked, with the week's measure (`asksAnswer`).
  router.add("GET", "/api/v1/asks", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const viewer = ctx.auth.user;
    if (!viewer) return unauthorized();
    const answer = timePhase(ctx.request, "asks", () => asksAnswer(ctx, viewer));
    return timePhase(ctx.request, "render", () =>
      json(answer, 200, { "cache-control": "private, no-store" }),
    );
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
      const plan = previewAsksBulk(ctx.app, ctx.auth.user, input.action, input.items, input.reason);
      if (!plan.ok) return bulkError(plan.error);
      return json({ preview: true, ...plan.value });
    }
    const op = await applyAsksBulk(ctx.app, ctx.auth.user, input.action, input.items, input.reason);
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

  // Let the decider answer a hand-over (`actions/asks_decide.ts`), and undo it.
  router.add("POST", "/api/v1/asks/decide", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const input = await body(ctx.request);
    const done = await decideAsk(ctx.app, ctx.auth.user, input.item);
    if (!done.ok) return bulkError(done.error);
    return json(done.value, 201);
  });

  // Give a hand-over back to the crew's builder (`actions/give_back.ts`).
  router.add("POST", "/api/v1/asks/give-back", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const input = await body(ctx.request);
    const done = giveBack(ctx.app, ctx.auth.user, input.item);
    if (!done.ok) return bulkError(done.error);
    return json(done.value, 201);
  });

  router.add("POST", "/api/v1/asks/decide/:id/undo", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const undone = undoDecideAsk(ctx.app, ctx.auth.user, ctx.params.id);
    if (!undone.ok) return bulkError(undone.error);
    return json(undone.value, 201);
  });

  // A wave proposal's four verbs (`actions/proposals.ts`): approve, redirect (with `words`), later, again.
  router.add("POST", "/api/v1/asks/proposal/:id/:verb", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const verb = ctx.params.verb;
    if (!isProposalVerb(verb)) return notFound();
    const input = await body(ctx.request);
    const done = actOnProposal(ctx.app, ctx.auth.user, verb, ctx.params.id, input.words);
    if (done.ok) return json(done.value ?? { ok: true }, 201);
    const { code, message } = done.error;
    if (code === "not_found") return notFound();
    if (code === "unauthorized") return unauthorized();
    return apiError(code, code === "forbidden" ? 403 : code === "conflict" ? 409 : 422, message);
  });

  router.add("POST", "/api/v1/feed/interactions", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const viewer = ctx.auth.user!;
    const db = ctx.app.db;
    const input = await body(ctx.request);
    const act = readInteraction(db, viewer, input, DOOR_KINDS);
    if (!act.ok)
      return apiError(act.error.code, act.error.code === "not_found" ? 404 : 422, act.error.message);
    const { itemId, kind, target } = act.value;
    // A like is a toggle: the second press takes it back (`feed/likes.ts`).
    if (kind === "liked") return json(toggleLike(db, viewer.id, itemId, target.repoId), 201);
    const made = recordInteraction(db, {
      viewerId: viewer.id,
      itemId,
      kind,
      repoId: target.repoId,
      actorId: target.actorId,
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
    if (text === "" || text.length > TELL_TEXT_MAX)
      return apiError("invalid_text", 422, `text is 1 to ${TELL_TEXT_MAX} characters`);
    const variants = parseVariants(input.variants);
    if (variants === undefined)
      return apiError(
        "invalid_variants",
        400,
        `variants is a whole number, 1 to ${VARIANTS_MAX}`,
      );
    const from = parseFrom(input.from);
    if (from === undefined) return apiError("invalid_from", 400, FROM_WORDS);
    const [owner, name, extra] = str(input.app).split("/");
    const repo =
      owner && name && extra === undefined
        ? getRepo(ctx.app.db, owner, name)
        : undefined;
    if (!repo || !canRead(ctx.app.db, repo, viewer)) return notFound();
    const told = await tell(ctx.app, viewer, repo, text, variants, from);
    if (!told.ok)
      return told.error === "forbidden"
        ? apiError("forbidden", 403, DIRECTION_NOTE)
        : told.error === "unverified"
          ? apiError("unverified", 403, UNVERIFIED_WORDS)
          : apiError("refused", told.error === "unauthorized" ? 403 : 422, "that could not be told");
    return json(
      {
        issue: told.value.issue.number,
        ...(told.value.variantGroup === null
          ? {}
          : {
              issues: told.value.issues.map((i) => i.number),
              assigned: told.value.assignedNumbers,
              variantGroup: told.value.variantGroup,
            }),
      },
      201,
    );
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
    error.code === "forbidden" ? 403 : error.code === "too_many" ? 429 : error.code === "already_undone" || error.code === "expired" ? 409 : 422,
    error.message,
  );
}
