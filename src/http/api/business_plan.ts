/**
 * `POST /api/v1/repos/:owner/:name/atlas` (#439): a business plan from Atlas
 * (apps, adapters, what waits for what), shown as the issues it would open
 * unless `confirm: true`, which opens them through the planner's path.
 */

import {
  ATLAS_BODY_MAX,
  businessItems,
  checkPillar,
  confirmBusinessPlan,
  parseBusinessPlan,
  spawnSeed,
  stampOf,
} from "../../actions/business_plan.ts";
import { loadRepo } from "../api.ts";
import type { Handler } from "../context.ts";
import { apiError, boundedBody, json, notFound, requireScope } from "../respond.ts";
import type { Router } from "../router.ts";

const BODY_MAX = ATLAS_BODY_MAX;

export function businessPlanRoutes(router: Router<Handler>): void {
  router.add("POST", "/api/v1/repos/:owner/:name/atlas", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    // The bytes read are what is counted: a chunked body has no length to claim.
    const input = await boundedBody(ctx.request, BODY_MAX);
    if (input === "too_large") return apiError("too_large", 413, `a plan is at most ${BODY_MAX} bytes`);
    const plan = parseBusinessPlan(input.plan);
    if (!plan.ok) return apiError(plan.error.error, 422, plan.error.message);
    const served = checkPillar(ctx.app, repo, input.pillar);
    if (!served.ok) return apiError(served.error.error, 422, served.error.message);
    const pillar = served.value;
    if (input.confirm !== undefined && typeof input.confirm !== "boolean")
      return apiError("invalid", 422, "confirm is true or false");
    if (input.confirm !== true)
      return json({
        status: "dry-run",
        stamp: stampOf(plan.value),
        plan: plan.value,
        issues: businessItems(plan.value, pillar),
        spawn: spawnSeed(plan.value),
      });
    const done = confirmBusinessPlan(ctx.app, ctx.auth.user, repo, plan.value, pillar);
    if (!done.ok)
      return apiError(
        done.error.error,
        done.error.error === "not_found" ? 404 : done.error.error === "forbidden" ? 403 : 422,
        done.error.message,
      );
    const status = done.value.status === "opened" ? 201 : done.value.status === "proposed" ? 202 : 200;
    return json(done.value, status);
  });
}
