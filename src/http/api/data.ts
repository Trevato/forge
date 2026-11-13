/**
 * A repository's databases over the API, as the web `/data` and MCP `data` show them: `GET …/data`,
 * `…/data/:env/:file/tables`, `…/rows?table=&page=`, and `POST …/query` (one read-only SELECT). Who
 * may see what is `data/sources.ts`; to anyone else every one of these is a 404.
 */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import {
  isFailure,
  parsePage,
  pickSource,
  repoSources,
  rowPage,
  runSql,
  sourceList,
  tableList,
} from "../../data/repo_scope.ts";
import { importAppData, importDataMessage } from "../../actions/migrate.ts";
import { loadRepo } from "../api.ts";
import type { Ctx, Handler } from "../context.ts";
import { QUERY_TIMEOUT_MS } from "../../data/query.ts";
import { apiError, body, json, notFound, requireScope, tryAgain } from "../respond.ts";
import type { Router } from "../router.ts";

const PRIVATE = { "cache-control": "private, no-store", vary: "authorization, cookie" };
const reply = (value: unknown): Response => json(value, 200, PRIVATE);

function find(ctx: Ctx) {
  const repo = loadRepo(ctx);
  if (!repo) return undefined;
  const sources = repoSources(ctx.app.db, ctx.app.config.dataDir, ctx.auth.user, repo);
  if (sources === undefined) return undefined;
  const picked = pickSource(sources, { env: ctx.params.env, file: ctx.params.file });
  return isFailure(picked) ? undefined : { sources, source: picked };
}

export function dataRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/repos/:owner/:name/data", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const sources = repoSources(ctx.app.db, ctx.app.config.dataDir, ctx.auth.user, repo);
    if (sources === undefined) return notFound();
    return reply({ items: sourceList(sources) });
  });

  router.add("GET", "/api/v1/repos/:owner/:name/data/:env/:file/tables", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const found = find(ctx);
    if (!found?.source) return notFound();
    return reply({ items: tableList(found.source) });
  });

  router.add("GET", "/api/v1/repos/:owner/:name/data/:env/:file/rows", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const found = find(ctx);
    if (!found?.source) return notFound();
    const table = ctx.url.searchParams.get("table");
    if (table === null || table === "") return apiError("invalid_table", 422, "table names a table");
    const raw = ctx.url.searchParams.get("page");
    const page = raw === null ? undefined : parsePage(raw);
    if (raw !== null && page === undefined) return apiError("invalid_page", 422, "page is a whole number from 0 to 1000");
    const result = rowPage(found.source, table, page);
    return result ? reply(result) : notFound();
  });

  // A dump in, loaded and reported per table on both sides (#11697). Body: { dump, env?, file?, replace? }.
  router.add("POST", "/api/v1/repos/:owner/:name/data-import", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    if (typeof input["dump"] !== "string") return apiError("invalid_dump", 422, "dump is the SQL text");
    const done = importAppData(ctx.app, ctx.auth.user, repo, {
      dump: input["dump"],
      ...(typeof input["env"] === "string" ? { env: input["env"] } : {}),
      ...(typeof input["file"] === "string" ? { file: input["file"] } : {}),
      replace: input["replace"] === true,
    });
    if (!done.ok) {
      if (done.error === "not_found") return notFound();
      const code = typeof done.error === "string" ? done.error : done.error.error;
      return apiError(code, code === "exists" || code === "mismatch" ? 409 : code === "too_large" ? 413 : 422, importDataMessage(done.error));
    }
    return json(done.value, 200, PRIVATE);
  });

  router.add("POST", "/api/v1/repos/:owner/:name/data/:env/:file/query", async (ctx) => {
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    const found = find(ctx);
    if (!found?.source) return notFound();
    const input = await body(ctx.request);
    if (typeof input["sql"] !== "string") return apiError("invalid_sql", 422, "sql is text");
    const user = ctx.auth.user;
    if (!user) return notFound();
    const result = await runSql(ctx.app, user, found.source, input["sql"]);
    if (!result.ok) {
      if (result.error === "rate")
        return tryAgain("rate_limited", 429, result.message, result.retryAfter, PRIVATE);
      // Every worker is taken; one frees within the query timeout at the latest.
      if (result.error === "busy") return tryAgain("busy", 429, result.message, QUERY_TIMEOUT_MS / 1000, PRIVATE);
      return apiError(result.error === "timeout" ? "timeout" : "invalid_sql", 422, result.message);
    }
    return reply(result);
  });
}
