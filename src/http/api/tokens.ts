/**
 * Signing in and API tokens: `POST` and `DELETE` `/api/v1/sessions`, and
 * `POST` and `GET` `/api/v1/tokens` with `DELETE` `…/tokens/:id`. Moved out
 * of `api.ts` (#7447), unchanged; the rules live in `actions/users.ts`,
 * `core/sessions.ts` and `core/tokens.ts`.
 */

import { signOutHere } from "../../actions/signins.ts";
import { createToken, deleteToken } from "../../actions/users.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { createSession } from "../../core/sessions.ts";
import { listTokensWithClients } from "../../core/oauth.ts";
import { ADMIN_TOKEN_WORDS } from "../../core/tokens.ts";
import { type User, verifyPasswordThrottled } from "../../core/users.ts";
import { sessionCookie } from "../../web/pages/site.ts";
import { holds, weakEtag } from "../etag.ts";
import { cookieValue, crossOrigin, type Handler } from "../context.ts";
import { STRANGER_MAX } from "../limits.ts";
import { clientAddress } from "../peer.ts";
import { apiError, boundedBody, forbidden, json, publicUser, requireAccount, respondAccess, str, tooManyAttempts, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";

export function tokenRoutes(router: Router<Handler>): void {
  router.add("POST", "/api/v1/sessions", async (ctx) => {
    // The answer sets a cookie, so a page on another site must not be able
    // to sign a visitor in as someone else (login CSRF).
    if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    // Anyone may call this, so its body is a stranger's (`http/limits.ts`).
    const input = await boundedBody(ctx.request, STRANGER_MAX);
    if (input === "too_large")
      return apiError("too_large", 413, `at most ${STRANGER_MAX} bytes`);
    const verified = await verifyPasswordThrottled(ctx.app.db, {
      username: str(input.username),
      password: str(input.password),
      source: clientAddress(ctx.request),
    });
    if (!verified.ok)
      return verified.error.reason === "throttled"
        ? tooManyAttempts(verified.error.retryAfter)
        : unauthorized();
    const session = createSession(ctx.app.db, verified.value.id);
    return json(publicUser(verified.value), 201, {
      "set-cookie": sessionCookie(session.token, session.expiresAt, ctx.url, ctx.app.config.url),
    });
  });

  router.add("DELETE", "/api/v1/sessions", (ctx) => {
    // Cookie-authenticated logout, so it must be same-origin like any other
    // cookie mutation — otherwise it's a cross-site forced-logout.
    if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    signOutHere(ctx.app, cookieValue(ctx.request, "forge_session"));
    return json({}, 200, {
      "set-cookie": sessionCookie("", new Date(0), ctx.url, ctx.app.config.url),
    });
  });

  // Tokens are minted, listed, and revoked with the account itself (a
  // session or the password) — never with another token.
  router.add("POST", "/api/v1/tokens", async (ctx) => {
    // Anyone may call this, so its body is a stranger's (`http/limits.ts`).
    const input = await boundedBody(ctx.request, STRANGER_MAX);
    if (input === "too_large")
      return apiError("too_large", 413, `at most ${STRANGER_MAX} bytes`);
    let user: User | undefined;
    if (
      (ctx.auth.via === "session" || ctx.auth.via === "edge") &&
      ctx.auth.user
    ) {
      if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
      // From a page, a site admin's token is minted only on purpose (#596).
      if (ctx.auth.user.isAdmin && input.adminConfirm !== true)
        return json(
          {
            error: "admin_confirm",
            message:
              "you are the forge's admin: send adminConfirm: true to mean a token that acts as admin, or mint it from your everyday account",
          },
          422,
        );
      user = ctx.auth.user;
    } else {
      const verified = await verifyPasswordThrottled(ctx.app.db, {
        username: str(input.username),
        password: str(input.password),
        source: clientAddress(ctx.request),
      });
      if (!verified.ok && verified.error.reason === "throttled")
        return tooManyAttempts(verified.error.retryAfter);
      if (verified.ok) user = verified.value;
      // With the password too, a site admin's token is minted on purpose.
      if (user?.isAdmin && input.adminConfirm !== true)
        return json(
          {
            error: "admin_confirm",
            message:
              "you are the forge's admin: send adminConfirm: true to mean a token that acts as admin, or mint it from your everyday account",
          },
          422,
        );
    }
    if (!user) return unauthorized();
    const scope = str(input.scope);
    if (scope !== "ro" && scope !== "rw" && scope !== "admin") {
      return json({ error: "invalid_scope" }, 422);
    }
    const minted = createToken(
      ctx.app,
      user,
      str(input.name) || "unnamed",
      scope,
    );
    if (!minted.ok && minted.error === "forbidden")
      return apiError("forbidden", 403, ADMIN_TOKEN_WORDS);
    if (!minted.ok) return unauthorized();
    return json(minted.value, 201);
  });

  router.add("GET", "/api/v1/tokens", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireAccount(ctx);
    if (denied) return denied;
    const tokens = timePhase(ctx.request, "tokens", () => listTokensWithClients(ctx.app.db, ctx.auth.user!.id));
    // The tag is of the exact bytes sent, which name every token with its
    // last use and client, so a token made, used or revoked moves it; the 401
    // and 403 above carry none, so a 304 is reached only past the access check.
    return timePhase(ctx.request, "render", () => {
      const text = JSON.stringify(tokens);
      const etag = weakEtag(text);
      const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
      if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
      return new Response(text, { headers: { "content-type": "application/json", ...headers } });
    });
  });

  router.add("DELETE", "/api/v1/tokens/:id", (ctx) => {
    const denied = requireAccount(ctx);
    if (denied) return denied;
    const removed = deleteToken(ctx.app, ctx.auth.user, ctx.params.id!);
    if (!removed.ok) return respondAccess(removed.error, 422);
    return new Response(null, { status: 204 });
  });
}
