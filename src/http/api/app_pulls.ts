/**
 * An adapter's recorded pull runs over the API (#10101):
 * `GET …/app/pulls?limit=` answers the newest first, for whoever may read the
 * repository; anyone else, or a repository with no app, gets 404. The rows are
 * read through `pullRunLines` in `apps/pull.ts`.
 */

import { requireReader } from "../../actions/access.ts";
import { PULL_RUNS_DEFAULT, PULL_RUNS_MAX, pullRunLines } from "../../apps/pull.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { loadRepo } from "../api.ts";
import type { Ctx, Handler } from "../context.ts";
import { apiError, json, notFound } from "../respond.ts";
import type { Router } from "../router.ts";

/** `?limit=`: absent is the default, a whole number from 1 to 100 is itself, anything else is a 422. */
function pullsLimit(ctx: Ctx): number | Response {
  const raw = ctx.url.searchParams.get("limit");
  if (raw === null) return PULL_RUNS_DEFAULT;
  const limit = /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
  if (limit < 1 || limit > PULL_RUNS_MAX)
    return apiError("invalid_limit", 422, `limit is a whole number from 1 to ${PULL_RUNS_MAX}`);
  return limit;
}

export function appPullsRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/repos/:owner/:name/app/pulls", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo || !requireReader(ctx.app, ctx.auth.user, repo).ok) return notFound();
    const limit = pullsLimit(ctx);
    if (limit instanceof Response) return limit;
    const items = timePhase(ctx.request, "pulls", () => {
      const record = getAppByRepo(ctx.app.db, repo.id);
      return record === undefined ? undefined : pullRunLines(ctx.app.db, record.id, limit);
    });
    if (items === undefined) return notFound();
    return json({ items, next_cursor: null });
  });
}
