/**
 * The space (#10444): `/:owner/:name/space`, the map as a full-screen plane
 * you move through, and `/:owner/:name/space.json`, the same plane as data.
 * The page server-renders the pillars as a list (what you see before the
 * script runs, and what a reader without it gets), then the canvas
 * (`space_client.ts`) takes the screen. The view is in the address hash, so
 * a link reproduces it.
 */

import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { holds, weakEtag } from "../../http/etag.ts";
import { loadRepo, notFoundPage, repoBase } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { btn } from "../ui.ts";
import { spaceCss, spaceJs } from "../space_client.ts";
import type { Region } from "../space_model.ts";
import { spaceOf } from "../space_read.ts";

/** The plane as JSON: for the canvas, and for an agent that wants the numbers. */
export function spaceJson(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const space = timePhase(ctx.request, "space", () => spaceOf(ctx.app, repo, ctx.auth.user));
  // The tag is the body's bytes: a run, issue or pull event refetches the plane,
  // and when nothing it draws moved the answer is a header, not ~1.5 MB. The
  // body is encoded by the server for every response (`http/compress.ts`).
  const body = JSON.stringify(space);
  const etag = weakEtag(body);
  const headers = { "cache-control": "private, no-cache", etag };
  if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { headers: { "content-type": "application/json", ...headers } });
}

export function spacePage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const base = repoBase(repo);
  const space = timePhase(ctx.request, "space", () => spaceOf(ctx.app, repo, ctx.auth.user));
  const regions = space.regions as Region[];
  const rendering = performance.now();
  const response = page({
    ctx,
    title: `Space · ${repo.name}`,
    bare: true,
    body: html`<div
      class="space"
      id="space"
      data-base="${base}"
      data-repo="${repo.ownerName}/${repo.name}"
      data-src="${base}/space.json"
    >
      <canvas
        id="space-cv"
        tabindex="0"
        role="img"
        aria-label="${repo.name}: ${regions.length} pillars, drawn by open work. Zoom in for issues."
      ></canvas>
      <div class="space-bar">
        ${btn("Map", { href: `${base}/map`, variant: "outline", size: "sm" })}
        ${btn("Fit", { type: "button", id: "space-fit", variant: "outline", size: "sm" })}
        ${btn("+", { type: "button", id: "space-in", label: "Zoom in", variant: "outline", size: "sm" })}
        ${btn("−", { type: "button", id: "space-out", label: "Zoom out", variant: "outline", size: "sm" })}
        <span id="space-crew"></span>
      </div>
      <aside class="space-panel" id="space-panel" hidden></aside>
      <div class="space-time">
        ${btn("Play", { type: "button", id: "space-play", variant: "outline", size: "sm" })}
        <input type="range" id="space-t" min="0" max="10080" step="1" value="10080" aria-label="Time, the last 7 days" />
        <output id="space-clock">Now</output>
        ${btn("Now", { type: "button", id: "space-now", variant: "outline", size: "sm" })}
      </div>
      <div class="space-list">
        <h1>${repo.name}</h1>
        <p id="space-error" class="muted" hidden>The canvas could not load the space. The pillars are below.</p>
        <ul>
          ${regions.map(
            (r) =>
              html`<li><strong>${r.name}</strong> ${r.open} open, ${r.ready} ready, ${r.landed} landed this week</li>`,
          )}
        </ul>
      </div>
    </div>`,
    styleCss: spaceCss,
    scriptJs: spaceJs,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
