/**
 * The API reference: `/api` for the forge's own OpenAPI document, and
 * `/:owner/:name/api` for the one an app serves at `/openapi.json`. Both are
 * the same reading (`contract/reference.ts`) drawn the same way
 * (`web/api_reference.ts`), server-side, with the search as a plain GET.
 */

import { knownSpec, refreshSpec } from "../../apps/api_spec.ts";
import { appsRuntime } from "../../apps/runtime.ts";
import { appView } from "../../actions/apps.ts";
import { narrow, reference, type Area } from "../../contract/reference.ts";
import { openapiText, roleOf } from "../../contract/served.ts";
import type { Role } from "../../contract/openapi/shared.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { canEnterApp } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { noRoute, prefersJson } from "../../http/respond.ts";
import { running } from "../../kernel/version.ts";
import { API_TRY_JS, referenceBody } from "../api_reference.ts";
import { loadRepo, notFoundPage, repoBase, repoHeader } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";

const MAX_QUERY = 100;
const asked = (ctx: Ctx): string => (ctx.url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY);
const count = (areas: readonly Area[]): number => areas.reduce((n, a) => n + a.operations.length, 0);

/**
 * The forge's reading as `role` may see it (#11286): the same cut the
 * document gets, once per build of it and per role.
 */
const forgeAreas = (() => {
  const read = new Map<Role, { tag: string; areas: Area[] }>();
  return (origin: string, role: Role): Area[] => {
    const hit = openapiText(origin, running().version, role);
    let held = read.get(role);
    if (held?.tag !== hit.etag) {
      held = { tag: hit.etag, areas: reference(JSON.parse(hit.text)) };
      read.set(role, held);
    }
    return held.areas;
  };
})();

// GET /api
export function apiPage(ctx: Ctx): Response {
  // `/api` is the API's root: a caller that asks for JSON still gets the API's own miss.
  if (prefersJson(ctx.request)) return noRoute(ctx.request.method, ctx.url.pathname);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const query = asked(ctx);
  const all = timePhase(ctx.request, "spec", () => forgeAreas(ctx.url.origin, roleOf(ctx.auth)));
  const rendering = performance.now();
  const body = html`<div class="page-head"><h1>API</h1></div>
    <p class="muted">
      Every route the forge names to you: a signed-out reader sees the ones open to anyone. <a href="/contract/openapi.json">The OpenAPI document</a>, as JSON.
      Try it sends the request as you; paste a token to send it as that token instead.
    </p>
    ${referenceBody({ areas: narrow(all, query), total: count(all), query, action: "/api", tryable: true })}`;
  const response = page({ ctx, title: "API", body, scriptJs: API_TRY_JS });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// GET /:owner/:name/api
export async function appApiPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  const view = repo === undefined ? undefined : appView(ctx.app, ctx.auth.user, repo);
  if (repo === undefined || view === undefined || !view.ok || !canEnterApp(ctx.app.db, repo, view.value.app, ctx.auth.user))
    return timePhase(ctx.request, "render", () => notFoundPage(ctx));
  const port = appsRuntime(ctx.app)?.envStatus(view.value.app, "production")?.port;
  const known = knownSpec(view.value.app.id);
  const doc = known !== undefined ? known : await refreshSpec(view.value.app, port);
  const rendering = performance.now();
  const query = asked(ctx);
  const all = doc === null ? [] : reference(doc);
  const base = repoBase(repo);
  const body = html`${repoHeader(ctx, repo, "api", { compact: true, ownTitle: true })}
    <div class="page-head"><h1>API</h1></div>
    ${doc === null
      ? html`<p class="muted">This app serves no <span class="mono">/openapi.json</span> from its production environment right now.</p>`
      : html`<p class="muted">What the app describes at <span class="mono">/openapi.json</span>, read live.</p>
        ${referenceBody({ areas: narrow(all, query), total: count(all), query, action: `${base}/api`, tryable: false })}`}`;
  const response = page({ ctx, title: `API · ${repo.ownerName}/${repo.name}`, body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
