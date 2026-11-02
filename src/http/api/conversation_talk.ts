/**
 * Talking to the forge's agent over the API (#7651): `POST
 * /api/v1/conversation/messages` sends one message and `GET
 * /api/v1/conversation/turns` reads the conversation back. The identity is the
 * verified session or rw token's person (a conversation's own via token reaches
 * `/mcp` alone, `http/via_gate.ts`); the body is byte-capped, a browser's
 * request is same-origin, and sending is throttled per person (`actions/talk.ts`).
 */

import { stopTalk, TALK_WORDS, talk } from "../../actions/talk.ts";
import { DEFAULT_PAGE, listTurns, MAX_PAGE, openConversation } from "../../core/conversations.ts";
import { WORDS_MAX } from "../../core/fence.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { scopeAllows } from "../../core/tokens.ts";
import { turnRunning } from "../../crew/conversation.ts";
import { crossOrigin, type Handler } from "../context.ts";
import { apiError, boundedBody, forbidden, json, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";

/** Room for the words at their cap even when every character is escaped. */
const BODY_MAX = 128_000;

/** `?limit=`: whole turns from 1 to `MAX_PAGE`; absent, empty or not a number is `DEFAULT_PAGE`. */
export function turnsLimit(raw: string | null): number {
  if (raw === null || raw.trim() === "") return DEFAULT_PAGE;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_PAGE;
  return Math.min(MAX_PAGE, Math.max(1, Math.floor(n)));
}

export function conversationTalkRoutes(router: Router<Handler>): void {
  router.add("POST", "/api/v1/conversation/messages", async (ctx) => {
    const user = ctx.auth.user;
    if (user === undefined) return unauthorized();
    if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    // A turn acts with an rw token (#8230): a token that may only read cannot start one.
    if (ctx.auth.via === "token" && !scopeAllows(ctx.auth.scope ?? "ro", "rw")) return forbidden();
    const input = await boundedBody(ctx.request, BODY_MAX);
    if (input === "too_large") return apiError("too_large", 413, `at most ${BODY_MAX} bytes`);
    const text = input["text"];
    if (typeof text !== "string" || text.trim() === "" || text.length > WORDS_MAX)
      return apiError("invalid_text", 422, `text is a string of 1 to ${WORDS_MAX} characters`);
    const said = talk(ctx.app, user, text);
    if (!said.ok) {
      const [status, words] = TALK_WORDS[said.error];
      return json({ error: said.error, message: words }, status, said.error === "rate_limited" || said.error === "busy" ? { "retry-after": "60" } : {});
    }
    return json({ how: said.value.how }, 202);
  });

  router.add("POST", "/api/v1/conversation/stop", (ctx) => {
    const user = ctx.auth.user;
    if (user === undefined) return unauthorized();
    if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    if (ctx.auth.via === "token" && !scopeAllows(ctx.auth.scope ?? "ro", "rw")) return forbidden();
    const stopped = stopTalk(ctx.app, user);
    if (!stopped.ok) return json({ error: stopped.error, message: stopped.error === "idle" ? "no answer is running" : "the forge's agent is not running here" }, stopped.error === "idle" ? 409 : 503);
    return json({ stopped: true }, 202);
  });

  router.add("GET", "/api/v1/conversation/turns", (ctx) => {
    const user = ctx.auth.user;
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (user === undefined) return unauthorized();
    const conversation = openConversation(ctx.app.db, user.id);
    const turns = listTurns(ctx.app.db, user.id, conversation.id, {
      limit: turnsLimit(ctx.url.searchParams.get("limit")),
      ...(ctx.url.searchParams.get("before") ? { before: ctx.url.searchParams.get("before")! } : {}),
    });
    return json({ running: turnRunning(ctx.app, user.id), turns: turns.ok ? turns.value : [] });
  });
}
