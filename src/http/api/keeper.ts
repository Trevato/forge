/**
 * `GET /api/v1/keeper`: the release keeper's releases, holds and what blocks
 * the next cut, for whoever may read /releases — MCP `release_keeper` over
 * HTTP. The answer is `keeper/landed.ts`'s `keeperAnswer`.
 *
 * `POST /api/v1/release/heartbeat` (#11674): a release path outside the forge
 * leaves the same heartbeat the in-process keeper's tick does, `{outcome,
 * reason}`, for an administrator's admin token; anyone else is refused.
 */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { isOutcome, REASON_MAX, recordBeat } from "../../keeper/beat.ts";
import { keeperAnswer } from "../../keeper/landed.ts";
import { mayRead } from "../../release/gate.ts";
import type { Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { apiError, body, json, requireScope } from "../respond.ts";
import type { Router } from "../router.ts";

/** A reason reaches terminals and pages: no control characters (escape sequences, newlines). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function keeperRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/keeper", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (!mayRead(ctx.app, ctx.auth.user))
      return apiError("forbidden", 403, "the release history is for the forge's administrators and its repository's readers");
    // Tagged only after the access check, over the exact bytes sent: a recorded, promoted, held or
    // rolled-back release moves it, and a viewer shown a different body gets a different tag.
    const text = JSON.stringify(keeperAnswer(ctx.app.db));
    const etag = weakEtag(text);
    const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
    if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    return new Response(text, { headers: { "content-type": "application/json", ...headers } });
  });

  router.add("POST", "/api/v1/release/heartbeat", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    if (ctx.auth.user?.isAdmin !== true)
      return apiError("forbidden", 403, "a release heartbeat is recorded by the forge's administrators only");
    const input = await body(ctx.request);
    if (!isOutcome(input.outcome)) return apiError("invalid_outcome", 422, "outcome is cut, skipped or failed");
    const reason = input.reason;
    if (typeof reason !== "string" || reason.trim() === "" || reason.length > REASON_MAX || CONTROL.test(reason))
      return apiError("invalid_reason", 422, `reason is plain words, 1 to ${REASON_MAX} characters`);
    return json(recordBeat(ctx.app.db, input.outcome, reason), 201);
  });
}
