/**
 * Talking to the forge's agent over the API (#7651): `POST
 * /api/v1/conversation/messages` sends one message and `GET
 * /api/v1/conversation/turns` reads the conversation back. The identity is the
 * verified session or rw token's person (a conversation's own via token reaches
 * `/mcp` alone, `http/via_gate.ts`); the body is byte-capped, a browser's
 * request is same-origin, and sending is throttled per person (`actions/talk.ts`).
 */

import type { App } from "../../app.ts";
import { RateLimiter } from "../../core/ratelimit.ts";
import { cancelTalk, stopTalk, TALK_WORDS, talk } from "../../actions/talk.ts";
import {
  archiveConversation,
  createConversation,
  DEFAULT_PAGE,
  getConversation,
  listConversations,
  listTurns,
  MAX_PAGE,
  openConversation,
  renameConversation,
  TITLE_MAX,
  TOO_MANY_WORDS,
} from "../../core/conversations.ts";
import { FILE_WORDS, fileBytes, fileOwnedBy, FILES_PER_MESSAGE, IMAGE_MAX, pendingAmong, removePending, storeFile } from "../../core/conversation_files.ts";
import { WORDS_MAX } from "../../core/fence.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { scopeAllows } from "../../core/tokens.ts";
import type { User } from "../../core/users.ts";
import { worksOf } from "../../core/talk_work.ts";
import { fileQueued, queuedOf, turnRunning } from "../../crew/conversation.ts";
import { crossOrigin, type Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { readBounded } from "../limits.ts";
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

/** Files a person may upload in a minute; a refused file still costs a read, so this is checked first. */
export const UPLOADS_PER_MINUTE = 20;
const limiters = new WeakMap<App, RateLimiter>();
const uploadLimiter = (app: App): RateLimiter => {
  let l = limiters.get(app);
  if (l === undefined) {
    l = new RateLimiter({ perMinute: UPLOADS_PER_MINUTE, adminPerMinute: UPLOADS_PER_MINUTE, enabled: true });
    limiters.set(app, l);
  }
  return l;
};

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
    const named = input["conversation"];
    if (named !== undefined && (typeof named !== "string" || !ID.test(named))) return apiError("not_found", 404, "no such conversation");
    const ids = input["files"] ?? [];
    if (!Array.isArray(ids) || ids.length > FILES_PER_MESSAGE || !ids.every((f) => typeof f === "string"))
      return apiError("invalid_files", 422, `files is a list of at most ${FILES_PER_MESSAGE} attachment ids`);
    const files = pendingAmong(ctx.app.db, user.id, ids as string[]);
    if (!files.ok) return apiError("not_found", 404, FILE_WORDS.not_found[1]);
    // What to do when a turn runs: absent hands the words to it; `queue` waits for it; `steer` stops it and sends these at once.
    const during = input["during"];
    if (during !== undefined && during !== "queue" && during !== "steer") return apiError("invalid_during", 422, "during is queue or steer");
    const said = talk(ctx.app, user, text, files.value, during === "queue" ? "queue" : during === "steer" ? "interrupt" : "inject", named, typeof input["about"] === "string" ? input["about"] : null);
    if (!said.ok) {
      const [status, words] = TALK_WORDS[said.error];
      return json({ error: said.error, message: words }, status, said.error === "rate_limited" || said.error === "busy" ? { "retry-after": "60" } : {});
    }
    return json(said.value.queued === undefined ? { how: said.value.how } : { how: said.value.how, queued: said.value.queued }, 202);
  });

  router.add("DELETE", "/api/v1/conversation/queue/:id", (ctx) => {
    const user = ctx.auth.user;
    if (user === undefined) return unauthorized();
    if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    if (ctx.auth.via === "token" && !scopeAllows(ctx.auth.scope ?? "ro", "rw")) return forbidden();
    if (!cancelTalk(ctx.app, user, ctx.params["id"] ?? "")) return apiError("not_found", 404, "that message already went, or was never waiting");
    return json({ ok: true });
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

  // One file, as the raw body; its name in the url-encoded `x-file-name`. Its type is what its bytes are.
  router.add("POST", "/api/v1/conversation/files", async (ctx) => {
    const user = ctx.auth.user;
    if (user === undefined) return unauthorized();
    if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    if (ctx.auth.via === "token" && !scopeAllows(ctx.auth.scope ?? "ro", "rw")) return forbidden();
    if (!uploadLimiter(ctx.app).take(`upload:${user.id}`, "rw").allowed) return json({ error: "rate_limited", message: `at most ${UPLOADS_PER_MINUTE} files a minute` }, 429, { "retry-after": "60" });
    const bytes = await readBounded(ctx.request, IMAGE_MAX);
    const refuse = (why: keyof typeof FILE_WORDS) => apiError(why, FILE_WORDS[why][0], FILE_WORDS[why][1]);
    if (bytes === "too_large") return refuse("too_large");
    let name = "";
    try {
      name = decodeURIComponent(ctx.request.headers.get("x-file-name") ?? "");
    } catch {
      // A name that does not decode is kept as no name.
    }
    const stored = storeFile(ctx.app.db, ctx.app.config.dataDir, user.id, name, bytes);
    if (!stored.ok) return refuse(stored.error);
    const { id, name: kept, type, size } = stored.value;
    return json({ id, name: kept, type, size }, 201);
  });

  // The person's own attachment, never shown in the page: a fixed type, as a download.
  router.add("GET", "/api/v1/conversation/files/:id", (ctx) => {
    const user = ctx.auth.user;
    if (user === undefined) return unauthorized();
    const file = fileOwnedBy(ctx.app.db, user.id, ctx.params["id"] ?? "");
    const bytes = file === undefined ? undefined : fileBytes(ctx.app.config.dataDir, user.id, file.id);
    if (file === undefined || bytes === undefined) return apiError("not_found", 404, FILE_WORDS.not_found[1]);
    const ext = file.type === "text/plain" ? "txt" : file.type.slice(6).replace("jpeg", "jpg");
    return new Response(bytes, {
      headers: {
        "content-type": file.type === "text/plain" ? "text/plain; charset=utf-8" : file.type,
        "content-disposition": `attachment; filename="attachment-${file.id}.${ext}"`,
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, no-store",
      },
    });
  });

  router.add("DELETE", "/api/v1/conversation/files/:id", (ctx) => {
    const user = ctx.auth.user;
    if (user === undefined) return unauthorized();
    if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    if (ctx.auth.via === "token" && !scopeAllows(ctx.auth.scope ?? "ro", "rw")) return forbidden();
    if (fileQueued(ctx.params["id"] ?? "")) return apiError("file_taken", 409, "that file waits in a queued message; cancel the message first");
    if (!removePending(ctx.app.db, ctx.app.config.dataDir, user.id, ctx.params["id"] ?? "")) return apiError("not_found", 404, FILE_WORDS.not_found[1]);
    return json({ ok: true });
  });

  router.add("GET", "/api/v1/conversation/turns", (ctx) => {
    const user = ctx.auth.user;
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (user === undefined) return unauthorized();
    const named = ctx.url.searchParams.get("conversation");
    const conversation = named === null ? openConversation(ctx.app.db, user.id) : getConversation(ctx.app.db, user.id, named);
    if (conversation === undefined) return apiError("not_found", 404, "no such conversation");
    const turns = listTurns(ctx.app.db, user.id, conversation.id, {
      limit: turnsLimit(ctx.url.searchParams.get("limit")),
      ...(ctx.url.searchParams.get("before") ? { before: ctx.url.searchParams.get("before")! } : {}),
    });
    // An agent turn carries the steps line and links of the calls before it (`core/talk_work.ts`).
    const all = turns.ok ? turns.value : [];
    const works = worksOf(ctx.app.db, user.id, conversation.id, all);
    const shown = all.map((t) => (t.role === "agent" ? { ...t, work: works.get(t.id) ?? null } : t));
    // The tag is of the exact bytes sent (so `before` and `limit` give their own), made after the person's own access was settled above.
    const text = JSON.stringify({ running: turnRunning(ctx.app, user.id, conversation.id), conversation: conversation.id, queued: queuedOf(ctx.app, user.id, conversation.id).map((q) => ({ id: q.id, text: q.text })), turns: shown });
    const etag = weakEtag(text);
    const headers = { etag, "cache-control": "private", vary: "authorization, cookie" };
    if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    return new Response(text, { headers: { "content-type": "application/json", ...headers } });
  });

  router.add("GET", "/api/v1/conversations", (ctx) => {
    const user = ctx.auth.user;
    if (user === undefined) return unauthorized();
    // The tag is over the viewer and the rendered body, so any create, rename, archive or turn moves it; the 304 is after the access check.
    const text = JSON.stringify({ conversations: listConversations(ctx.app.db, user.id, { archived: ctx.url.searchParams.get("archived") === "1" }) });
    const etag = weakEtag(`${user.id}\n${text}`);
    const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
    if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    return new Response(text, { status: 200, headers: { "content-type": "application/json", ...headers } });
  });

  router.add("POST", "/api/v1/conversations", async (ctx) => {
    const user = mayChange(ctx);
    if (user instanceof Response) return user;
    const input = await boundedBody(ctx.request, 4_000);
    if (input === "too_large") return apiError("too_large", 413, "at most 4000 bytes");
    const title = input["title"];
    if (title !== undefined && typeof title !== "string") return apiError("invalid_title", 422, TITLE_WORDS);
    const started = createConversation(ctx.app.db, user.id);
    if (!started.ok) return apiError("too_many", 409, TOO_MANY_WORDS);
    const made = started.value;
    if (title === undefined || title.trim() === "") return json({ conversation: made }, 201);
    const named = renameConversation(ctx.app.db, user.id, made.id, title);
    return named.ok ? json({ conversation: named.value }, 201) : apiError("invalid_title", 422, TITLE_WORDS);
  });

  router.add("PATCH", "/api/v1/conversations/:id", async (ctx) => {
    const user = mayChange(ctx);
    if (user instanceof Response) return user;
    const id = ctx.params["id"] ?? "";
    if (!ID.test(id) || getConversation(ctx.app.db, user.id, id) === undefined) return apiError("not_found", 404, "no such conversation");
    const input = await boundedBody(ctx.request, 4_000);
    if (input === "too_large") return apiError("too_large", 413, "at most 4000 bytes");
    const { title, archived } = input;
    if (title !== undefined && typeof title !== "string") return apiError("invalid_title", 422, TITLE_WORDS);
    if (archived !== undefined && typeof archived !== "boolean") return apiError("invalid", 422, "archived is true or false");
    if (title === undefined && archived === undefined) return apiError("invalid", 422, "send title or archived");
    if (title !== undefined && !renameConversation(ctx.app.db, user.id, id, title).ok) return apiError("invalid_title", 422, TITLE_WORDS);
    if (archived !== undefined) archiveConversation(ctx.app.db, user.id, id, archived);
    return json({ conversation: getConversation(ctx.app.db, user.id, id) });
  });
}

const ID = /^[0-9a-z]{1,40}$/;
const TITLE_WORDS = `title is text of at most ${TITLE_MAX} characters, on one line`;

/** The person a change is for: signed in, same-origin, and not on a read-only token. */
function mayChange(ctx: Parameters<Handler>[0]): User | Response {
  const user = ctx.auth.user;
  if (user === undefined) return unauthorized();
  if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
  if (ctx.auth.via === "token" && !scopeAllows(ctx.auth.scope ?? "ro", "rw")) return forbidden();
  return user;
}
