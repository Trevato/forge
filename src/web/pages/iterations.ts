/**
 * Iterations (`/:owner/:name/iterations`): a fork family's build pins as
 * cards in a downward tree, a card per run, with fork and concept lines,
 * zoom, and folds. Reached from Builds; it is not found where the family
 * (what the viewer may read of it) holds no pin. Read-only: pinning stays on
 * Builds. The data is `iterations_family.ts`, the browser half
 * `iterations_script.ts`.
 */

import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, loadRepo, notFoundPage, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { iterationsOf, lanesOf, type IterationBuild, type IterationLane } from "./iterations_family.ts";
import { btn } from "../ui.ts";
import { ITERATIONS_CSS, ITERATIONS_JS } from "./iterations_script.ts";

const row = (b: IterationBuild): Html =>
  html`<div class="it-b" data-key="${b.key}">
    <span class="it-l mono">${b.label}</span><span class="it-d">${b.at.slice(0, 10)}</span>
    ${when(b.note !== "", () => html`<span class="it-n">${b.note}</span>`)}
  </div>`;

/** One run: its head, its rows, and the one node each fold leaves. */
function lane(l: IterationLane, branches: number): Html {
  const keys = l.builds.map((b) => b.key).join(" ");
  const n = l.builds.length;
  const first = l.builds[0];
  const last = l.builds.at(-1);
  const count = `${String(n)} ${n === 1 ? "build" : "builds"}`;
  // The fold buttons are made by the script; without it a head is a name.
  const head = l.main
    ? html`<span class="it-nm" data-act="fork"><i aria-hidden="true"></i><b class="mono">${l.title}</b></span>`
    : html`<span class="it-sub mono">${l.title}</span>`;
  return html`<section class="it-lane${l.main ? "" : " it-branch"}" data-lane="${l.id}" data-repo="${l.repo}">
    <header class="it-lh">${head}</header>
    <div class="it-rows">${l.builds.map(row)}${when(n === 0, () => html`<div class="it-b"><span class="it-n">No build pinned here</span></div>`)}</div>
    ${when(l.main, () => html`<button type="button" class="it-coll it-fcoll" data-act="fork" data-keys="${keys}"><b>${count}</b><span>${branches > 0 ? `${String(branches)} ${branches === 1 ? "branch" : "branches"} · ` : ""}folded</span></button>`)}
    ${when(first !== undefined && last !== undefined && n > 1, () => html`<button type="button" class="it-coll it-rcoll" data-act="run" data-keys="${keys}"><b class="mono">${first!.label} → ${last!.label}</b><span>${count} in a run</span></button>`)}
  </section>`;
}

const ctl = (id: string, text: string, title: string, label?: string): Html =>
  btn(text, { id, type: "button", size: "sm", title, ...(label === undefined ? {} : { label }) });

/** Shown by the script only (`#it-page.it-on`): each one does nothing without it. */
const CONTROLS = html`<span class="it-zc" role="group" aria-label="Forks">${ctl("it-fold-all", "Collapse forks", "Fold every fork to its name")}${ctl("it-open-all", "Expand forks", "Open every fork")}</span><span class="it-zc" role="group" aria-label="Zoom">${ctl("it-zout", "−", "Zoom out", "Zoom out")}${ctl("it-zval", "100%", "Back to 100%")}${ctl("it-zin", "+", "Zoom in", "Zoom in")}${ctl("it-zfit", "Fit", "Fit the whole graph in view")}</span>`;

// GET /:owner/:name/iterations
export async function iterationsPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return timePhase(ctx.request, "render", () => notFoundPage(ctx));
  const forks = await timePhaseAsync(ctx.request, "graph", () => iterationsOf(ctx.app, ctx.auth.user, repo));
  if (forks === undefined) return timePhase(ctx.request, "render", () => notFoundPage(ctx));
  const base = repoBase(repo);
  const lanes = lanesOf(forks);
  const data = JSON.stringify(lanes.map((l) => ({ id: l.id, from: l.from, fromRepo: l.fromRepo, kind: l.kind, main: l.main })));
  const body = html`${repoHeader(ctx, repo, "branches", { compact: true })}
    <div class="it-page" id="it-page" data-here="${repo.ownerName}/${repo.name}" data-lanes="${data}">
      <div class="page-head mt">
        <h2>Iterations</h2>
        <a href="${base}/builds">Builds</a>
      </div>
      <div class="it-key"><span><i></i>fork of</span><span><i class="it-thin"></i>branch</span><span><i class="it-dash"></i>built on a pin of</span><span class="it-sp">${CONTROLS}</span></div>
      <div class="it-stage" id="it-stage"><div class="it-zoom" id="it-zoom"><div class="it-tree" id="it-grid">${lanes.map((l) => lane(l, l.main ? lanes.filter((x) => !x.main && x.repo === l.repo).length : 0))}</div></div></div>
    </div>`;
  return timePhase(ctx.request, "render", () =>
    page({
      ctx,
      title: `Iterations · ${repo.name}`,
      crumbs: crumbsFor(repo),
      palette: repoPalette(ctx, repo),
      body,
      styleCss: ITERATIONS_CSS,
      scriptJs: ITERATIONS_JS,
      wide: true,
    }),
  );
}
