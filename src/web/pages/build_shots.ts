/**
 * A pin's screenshots, read: one picture by name, to whoever reads the
 * repository (`git/shots.ts`). They are written through the API and the
 * terminal (`actions/build_shots.ts`); the gallery page below shows them,
 * following `build.shots` live.
 */

import { readBuildPin } from "../../git/builds.ts";
import { readShotBytes, readShots } from "../../git/shots.ts";
import { repoDir } from "../../git/repos.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, loadRepo, notFoundPage, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { card } from "../ui.ts";

export const SHOTS_LIVE = "build.shots,build.pinned";

// GET /:owner/:name/builds/:label/shots — the gallery: server-rendered, re-fetched on build.shots.
export async function shotsPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const label = ctx.params.label ?? "";
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  if ((await timePhase(ctx.request, "read", () => readBuildPin(dir, label))) === undefined) return notFoundPage(ctx);
  const shots = await readShots(dir, label);
  const base = repoBase(repo);
  const at = `${base}/builds/${encodeURIComponent(label)}/shots`;
  const grid: Html =
    shots.items.length === 0
      ? html`<p class="muted small">No screenshots on ${label} yet.</p>`
      : html`<div class="looks">${shots.items.map(
          (s) => html`<figure>
            <a class="look" href="${at}/${s.file}?v=${s.oid.slice(0, 12)}"><img src="${at}/${s.file}?v=${s.oid.slice(0, 12)}" alt="${s.caption === "" ? `Screenshot ${s.file}` : s.caption}" width="320" height="240" loading="lazy" decoding="async" /></a>
            ${s.caption === "" ? null : html`<figcaption class="small">${s.caption}</figcaption>`}
          </figure>`,
        )}</div>`;
  const body = html`${repoHeader(ctx, repo, "branches", { compact: true })}
    <div class="mt"><p class="small"><a href="${base}/builds">← Builds</a></p>
    <div id="pin-shots" data-live="${SHOTS_LIVE}" data-live-repo="${repo.ownerName}/${repo.name}" aria-live="polite">${card(grid, { head: html`<h2>Screenshots · ${label}</h2>` })}</div></div>`;
  return timePhase(ctx.request, "render", () =>
    page({ ctx, title: `Screenshots ${label} · ${repo.name}`, crumbs: crumbsFor(repo), palette: repoPalette(ctx, repo), body }),
  );
}

// GET /:owner/:name/builds/:label/shots/:file — one screenshot. Typed by
// its first bytes, never by its name, and never sniffed into anything else.
export async function shotImage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const shot = await timePhase(ctx.request, "read", () => readShotBytes(dir, ctx.params.label ?? "", ctx.params.file ?? ""));
  if (shot === undefined) return notFoundPage(ctx);
  // A name moves to another picture on a reorder; the blob it is does not.
  const etag = `"${shot.oid}"`;
  const headers = {
    "content-type": shot.type,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    etag,
    "cache-control":
      ctx.url.searchParams.get("v") === shot.oid.slice(0, 12) ? "private, max-age=31536000, immutable" : "private, no-cache",
  };
  if (ctx.request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(shot.bytes, { headers });
}
