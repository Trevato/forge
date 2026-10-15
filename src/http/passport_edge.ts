/**
 * The first edge on passports (`kernel/passport.ts`): `GET /api/v1/passport/health`
 * answers the forge's public health to a caller holding a passport the forge
 * issued for audience `forge` with scope `health:read`, and to no one else.
 * A crew run is handed one (`FORGE_PASSPORT`, a few minutes) beside its token,
 * so an agent can ask "is the forge well" without its token's authority.
 *
 * This route is a probe of the mechanism, not a privilege: the body is what
 * the anonymous `GET /api/v1/health` already gives. It exists so the whole
 * path (issue, carry, verify) is exercised end to end; the next edge should
 * guard something a passport alone is meant to reach.
 *
 * Every refusal is a 401 with one code; the body never says which check failed.
 */

import { readHealth } from "../actions/health.ts";
import { verify } from "../kernel/passport.ts";
import type { Handler } from "./context.ts";
import { apiError, json } from "./respond.ts";
import type { Router } from "./router.ts";

export const PASSPORT_AUDIENCE = "forge";
export const HEALTH_SCOPE = "health:read";

export function passportRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/passport/health", (ctx) => {
    const header = ctx.request.headers.get("authorization") ?? "";
    const seen = header.startsWith("Passport ")
      ? verify(ctx.app.config.dataDir, header.slice(9).trim(), {
          audience: PASSPORT_AUDIENCE,
          scope: HEALTH_SCOPE,
          now: Date.now(),
        })
      : undefined;
    if (!seen?.ok)
      return apiError("unauthorized", 401, "a valid passport for this is needed");
    return json(readHealth(ctx.app, undefined), 200, { "cache-control": "no-store" });
  });
}
