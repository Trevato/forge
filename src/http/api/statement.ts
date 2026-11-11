/**
 * GET /api/v1/repos/:owner/:name/statement?month=YYYY-MM[&format=csv]: one
 * app's statement for one UTC month (#508, `core/revenue.ts`) — awake time,
 * storage, crew spend and the margin on it, each line quantity × price, in
 * US dollars rounded once to the cent. JSON by default; `format=csv` (or an
 * `accept: text/csv`) is the same lines as a table file. For the
 * repository's admins and forge admins; anyone else is told 404.
 */

import { STATEMENT_WORDS, readStatement } from "../../actions/statement.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { statementCsv } from "../../core/revenue.ts";
import { loadRepo } from "../api.ts";
import type { Handler } from "../context.ts";
import { apiError, json, notFound, requireScope } from "../respond.ts";
import type { Router } from "../router.ts";

const PRIVATE = { "cache-control": "private, no-store", vary: "authorization, cookie, accept" };

export function statementRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/repos/:owner/:name/statement", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (ctx.auth.user === undefined) return notFound();
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const asked = ctx.url.searchParams.get("format");
    const format = asked ?? ((ctx.request.headers.get("accept") ?? "").includes("text/csv") ? "csv" : "json");
    if (format !== "json" && format !== "csv") return apiError("invalid_format", 422, "format must be json or csv");
    const month = ctx.url.searchParams.get("month") ?? undefined;
    const read = readStatement(ctx.app, ctx.auth.user, repo, month);
    if (!read.ok) return read.error === "not_found" ? notFound() : apiError(read.error, 422, STATEMENT_WORDS[read.error]);
    const s = read.value;
    if (format === "json") return json(s, 200, PRIVATE);
    return new Response(statementCsv(s), {
      headers: {
        ...PRIVATE,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${repo.ownerName}-${repo.name}-${s.month}.csv"`,
      },
    });
  });
}
