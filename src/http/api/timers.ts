/**
 * `POST /api/v1/timers` and `DELETE /api/v1/timers/:key` (#11595): an app arms
 * and cancels its own timers with its own token (`actions/timers.ts`).
 */

import { armFor, cancelFor, type TimerError } from "../../actions/timers.ts";
import { ONCE_BODY_MAX } from "../../core/timers.ts";
import type { Handler } from "../context.ts";
import { readBounded } from "../limits.ts";
import { apiError, json, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";
import { tokenSecret } from "../token_header.ts";

const STATUS: Record<TimerError, number> = { unauthorized: 401, invalid: 422, too_many: 429, not_found: 404 };

export function timersRoutes(router: Router<Handler>): void {
  router.add("POST", "/api/v1/timers", async (ctx) => {
    const secret = tokenSecret(ctx.request.headers.get("authorization") ?? "");
    if (secret === null) return unauthorized();
    // The body is a JSON envelope around a body of up to 64 KB.
    const raw = await readBounded(ctx.request, ONCE_BODY_MAX + 4096);
    if (raw === "too_large") return apiError("invalid", 422, "`body` is at most 64 KB.");
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return apiError("invalid", 422, "The body is JSON.");
    }
    const armed = armFor(ctx.app, secret, input);
    if (!armed.ok) return apiError(armed.error.kind, STATUS[armed.error.kind], armed.error.message);
    return json({ timer: armed.value }, 201);
  });
  router.add("DELETE", "/api/v1/timers/:key", (ctx) => {
    const secret = tokenSecret(ctx.request.headers.get("authorization") ?? "");
    if (secret === null) return unauthorized();
    const gone = cancelFor(ctx.app, secret, ctx.params["key"] ?? "");
    if (!gone.ok) return apiError(gone.error.kind, STATUS[gone.error.kind], gone.error.message);
    return json({}, 200);
  });
}
