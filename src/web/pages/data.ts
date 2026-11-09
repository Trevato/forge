/**
 * The data browser's three doors (body in `data_view.ts`):
 * - `/data`: every SQLite file the viewer may see (an admin, or an app's writer).
 * - `/admin/data`: the forge's own database, admins only.
 * - `/:owner/:name/data`: one app's databases, environment by environment, for
 *   the people who can write the app. Anyone else gets the one 404.
 */

import { getAppByRepo } from "../../core/apps.ts";
import { canWrite } from "../../core/repos.ts";
import { sqlWindow } from "../../data/sql_window.ts";
import { listSources, maySeeData } from "../../data/sources.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { loadRepo, notFoundPage, pageHead, scopeHeader, signInFirst } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { btn } from "../ui.ts";
import { localScope } from "../scope.ts";
import { dataBody, type DataView } from "./data_view.ts";

const PURPOSE = "Every SQLite file you may read; secrets are masked.";

/** What `page()` takes besides the body, for the doors that draw their own frame. */
type Frame = Partial<Pick<Parameters<typeof page>[0], "crumbs" | "palette">>;

async function draw(ctx: Ctx, view: DataView, title: string, head: Html, extra: Frame = {}): Promise<Response> {
  const rendering = performance.now();
  const inner = await dataBody(view, ctx.url.searchParams);
  if (inner === undefined) return refuse(ctx);
  const response = page({ ctx, title, body: html`${head}${inner}`, ...extra });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

/** A refusal still names `render`, so every answer carries both phases. */
function refuse(ctx: Ctx): Response {
  const rendering = performance.now();
  const response = notFoundPage(ctx);
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// GET /data[?source=<id>[&table=<name>…][&sql=…]]
export async function dataPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const viewer = ctx.auth.user;
  if (!viewer) return signInFirst(ctx);
  const { db, config } = ctx.app;
  if (!maySeeData(db, viewer)) return refuse(ctx);
  const sources = listSources(db, config.dataDir, viewer);
  return draw(ctx, { path: "/data", sources, sqlWait: () => sqlWindow(ctx.app, viewer.id) }, "Data", pageHead("Data", { sub: PURPOSE, ...(viewer.isAdmin ? { actions: btn("Forge data", { href: "/admin/data", size: "sm" }) } : {}) }));
}

// GET /admin/data — the forge's own database (the admin gate has already refused non-admins).
export async function adminDataPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const viewer = ctx.auth.user;
  if (!viewer) return signInFirst(ctx);
  if (!viewer.isAdmin) return refuse(ctx);
  const sources = listSources(ctx.app.db, ctx.app.config.dataDir, viewer).filter((s) => s.kind === "forge");
  return draw(ctx, { path: "/admin/data", sources, sqlWait: () => sqlWindow(ctx.app, viewer.id) }, "Data · forge", pageHead("Forge data", { sub: "Secrets are masked; queries are read-only." }));
}

// GET /:owner/:name/data — an app's databases, for its writers.
export async function appDataPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  const record = repo && getAppByRepo(ctx.app.db, repo.id);
  if (!repo || !record || !ctx.auth.user || !canWrite(ctx.app.db, repo, ctx.auth.user)) return refuse(ctx);
  const viewer = ctx.auth.user;
  const sources = listSources(ctx.app.db, ctx.app.config.dataDir, viewer).filter((s) => s.id.startsWith(`app:${record.id}:`));
  const scope = localScope(ctx, repo);
  return draw(
    ctx,
    { path: `/${repo.ownerName}/${repo.name}/data`, sources, byEnv: true, sqlWait: () => sqlWindow(ctx.app, viewer.id) },
    `Data · ${repo.name}`,
    scopeHeader(ctx, scope, "data"),
    { crumbs: scope.crumbs, palette: scope.palette },
  );
}
