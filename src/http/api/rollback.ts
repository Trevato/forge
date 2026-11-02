/**
 * Rolling the forge back over the API (#7217):
 * `POST /api/v1/admin/releases/:sha/rollback`. A plan by default — from
 * which release to which, and whether the releases page would offer it —
 * and only `{ "dryRun": false }` swaps. The rules are `release/gate.ts`'s,
 * the same the page and the terminal run: `mayRollBack`, `canRollBackTo`,
 * then `rollBackTo` unchanged. `admin_gate.ts` has already refused a person
 * who may not administer; this adds the admin token scope.
 */

import { existsSync } from "node:fs";
import { running } from "../../kernel/version.ts";
import { releaseDir } from "../../release/checkout.ts";
import { canRollBackTo, mayRollBack, rollBackTo } from "../../release/gate.ts";
import { listReleases } from "../../release/record.ts";
import { ALREADY_LIVE, NOT_ROLLABLE } from "../../release/words.ts";
import type { Handler } from "../context.ts";
import { apiError, body, forbidden, json, notFound, requireScope } from "../respond.ts";
import type { Router } from "../router.ts";

export function rollbackRoutes(router: Router<Handler>): void {
  router.add("POST", "/api/v1/admin/releases/:sha/rollback", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const user = ctx.auth.user!;
    if (!mayRollBack(ctx.app, user)) return forbidden();
    const input = await body(ctx.request);
    if (input.dryRun !== undefined && typeof input.dryRun !== "boolean")
      return apiError("invalid", 422, "dryRun is true (the default: plan only) or false (roll back)");
    const dryRun = input.dryRun !== false;
    const target = ctx.params.sha ?? "";
    // Kept means the page lists it and its checkout is still on disk.
    const release = /^[0-9a-f]{40}$/.test(target)
      ? listReleases(ctx.app.db).find((r) => r.sha === target)
      : undefined;
    if (release === undefined || !existsSync(releaseDir(ctx.app.config.dataDir, target))) return notFound();
    const from = running().commit;
    const refusal = from === target ? ALREADY_LIVE : (await canRollBackTo(ctx.app, release)) ? undefined : NOT_ROLLABLE;
    // `from` is left out when nothing says which commit is live.
    const route = { dryRun, ...(from === null ? {} : { from }), to: target };
    if (dryRun) return json({ ...route, allowed: refusal === undefined, ...(refusal ? { message: refusal } : {}) });
    if (refusal !== undefined) return apiError("not_rollable", 409, refusal);
    const done = await rollBackTo(ctx.app, user, target);
    if (!done.ok) return apiError("not_rolled_back", 409, done.line);
    return json({ ...route, rolledBack: true });
  });
}
