/**
 * `GET /api/v1/repos/:owner/:name/jobs` and `POST …/jobs/:id/(cancel|retry)`
 * (#11596): an app's durable job runs and the two things a writer may do to
 * one, the same answers as the app's page and the MCP tool (`actions/jobs.ts`).
 */

import { JOB_WORDS, jobRows, steerJob } from "../../actions/jobs.ts";
import { loadRepo } from "../api.ts";
import type { Handler } from "../context.ts";
import { apiError, json, notFound, requireScope, respondAccess } from "../respond.ts";
import type { Router } from "../router.ts";

export function jobsRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/repos/:owner/:name/jobs", async (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const rows = await jobRows(ctx.app, ctx.auth.user, repo);
    if (!rows.ok) return rows.error === "not_found" ? notFound() : rows.error === "unreachable" ? apiError("unreachable", 502, JOB_WORDS.unreachable) : respondAccess(rows.error, 422);
    return json({ items: rows.value, next_cursor: null });
  });
  router.add("POST", "/api/v1/repos/:owner/:name/jobs/:id/:action", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const done = await steerJob(ctx.app, ctx.auth.user, repo, ctx.params["id"] ?? "", ctx.params["action"] ?? "");
    if (done.ok) return json({ run: ctx.params["id"], action: ctx.params["action"] }, 200);
    if (done.error === "not_found") return notFound();
    if (done.error === "unreachable") return apiError("unreachable", 502, JOB_WORDS.unreachable);
    if (done.error === "not_now" || done.error === "invalid") return apiError(done.error, 422, JOB_WORDS[done.error]);
    return respondAccess(done.error, 422);
  });
}
