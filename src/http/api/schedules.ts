/**
 * `GET /api/v1/repos/:owner/:name/schedules` (rows, and `?runs=` for the
 * history) and `POST …/schedules/:name/(run|pause|resume)` (#11595): the same
 * answers as the app's page and the MCP tool (`actions/schedules.ts`).
 */

import { scheduleRows, scheduleRuns, steerSchedule } from "../../actions/schedules.ts";
import { requireReader } from "../../actions/access.ts";
import { loadRepo } from "../api.ts";
import type { Handler } from "../context.ts";
import { apiError, json, notFound, requireScope, respondAccess } from "../respond.ts";
import type { Router } from "../router.ts";

export function schedulesRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/repos/:owner/:name/schedules", (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo || !requireReader(ctx.app, ctx.auth.user, repo).ok) return notFound();
    const rows = scheduleRows(ctx.app, ctx.auth.user, repo);
    if (!rows.ok) return notFound();
    const wantRuns = ctx.url.searchParams.get("runs");
    if (wantRuns === null) return json({ items: rows.value, next_cursor: null });
    const limit = /^\d{1,3}$/.test(wantRuns) ? Number(wantRuns) : 30;
    const runs = scheduleRuns(ctx.app, ctx.auth.user, repo, ctx.url.searchParams.get("name") ?? undefined, limit);
    return json({ items: rows.value, runs: runs.ok ? runs.value : [], next_cursor: null });
  });
  router.add("POST", "/api/v1/repos/:owner/:name/schedules/:schedule/:action", (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const action = ctx.params["action"];
    if (action !== "run" && action !== "pause" && action !== "resume") return apiError("invalid", 422, "The action is run, pause or resume.");
    const steered = steerSchedule(ctx.app, ctx.auth.user, repo, ctx.params["schedule"] ?? "", ctx.url.searchParams.get("env") ?? "production", action);
    if (!steered.ok) return steered.error === "not_found" ? notFound() : respondAccess(steered.error, 422);
    return json({ schedule: ctx.params["schedule"], action }, 200);
  });
}
