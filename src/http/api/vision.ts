/** `GET /api/v1/repos/:owner/:name/vision`: what MCP `vision` answers, for the same reader (#7901). */

import { answerVision } from "../../crew/vision.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { loadRepo } from "../api.ts";
import type { Handler } from "../context.ts";
import { apiError, json, notFound } from "../respond.ts";
import type { Router } from "../router.ts";

export function visionRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/repos/:owner/:name/vision", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const raw = new URL(ctx.request.url).searchParams.get("number");
    let number: number | undefined;
    if (raw !== null) {
      if (!/^[1-9][0-9]{0,9}$/.test(raw)) return apiError("invalid_number", 422, "number is a whole number of 1 or more");
      number = Number(raw);
    }
    return json(await answerVision(ctx.app, ctx.auth.user, repo, number));
  });
}
