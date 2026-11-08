/**
 * A repository's display page, `/<owner>/<repo>/display`, read only: the
 * builds its `display.json` holds (`display/config.ts`) as whoever is
 * looking may read them, after Jay Moran's page. A build whose repository
 * the viewer cannot read shows its name and version alone. Ticking builds,
 * editing the title, covers and the player wait for the submit handlers and
 * the Arcade host. A bad `display.json` shows its error, never a guess.
 */

import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { displayItems } from "../../display/items.ts";
import { INVALID_TITLE, displayOf } from "../../display/known.ts";
import { repoShotsUrl } from "../../display/launch.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, loadRepo, notFoundPage, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { empty } from "../ui.ts";

const LAYOUT_WORD = { shelf: "Shelf", grid: "Grid", graph: "Graph" } as const;

// GET /:owner/:name/display — 404 for a repository with no display.json or one the viewer cannot read.
export async function displayPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return timePhase(ctx.request, "render", () => notFoundPage(ctx));
  const config = await timePhaseAsync(ctx.request, "display", () => displayOf(ctx.app, repo));
  if (config === undefined) return timePhase(ctx.request, "render", () => notFoundPage(ctx));
  const items = config.ok ? await timePhaseAsync(ctx.request, "items", () => displayItems(ctx.app, repo, config.value, ctx.auth.user)) : [];
  const title = config.ok ? config.value.title : INVALID_TITLE;
  const body = html`${repoHeader(ctx, repo, "code", { compact: true })}
    <div class="page-head mt">
      <h2>${title}</h2>
      <a href="/displays">All displays</a>
    </div>
    ${!config.ok
      ? html`<p role="alert">${config.error}</p>`
      : items.length === 0
        ? empty({ icon: "pin", title: "No builds", note: "This display shows no builds yet." })
        : html`<p>${LAYOUT_WORD[config.value.layout]} · ${String(items.length)} ${items.length === 1 ? "build" : "builds"}</p>
          <div class="table-scroll" role="region" tabindex="0" aria-label="Builds">
            <table class="table" data-dense data-by="display-builds">
              <thead>
                <tr><th scope="col">Build</th><th scope="col">Version</th><th scope="col">Repository</th></tr>
              </thead>
              <tbody>
                ${items.map((it) =>
                  it.open
                    ? html`<tr data-build="${it.key}">
                        <td><a href="${repoShotsUrl(it.repo, it.pin)}">${it.demo.name}</a></td>
                        <td class="mono">${it.demo.version}</td>
                        <td><a class="mono" href="${repoBase(it.repo)}">${it.repo.ownerName}/${it.repo.name}</a></td>
                      </tr>`
                    : html`<tr data-build="private">
                        <td>${it.demo.name}</td>
                        <td class="mono">${it.demo.version}</td>
                        <td>Private</td>
                      </tr>`,
                )}
              </tbody>
            </table>
          </div>`}`;
  return timePhase(ctx.request, "render", () =>
    page({ ctx, title: `Display · ${repo.name}`, crumbs: crumbsFor(repo), palette: repoPalette(ctx, repo), body }),
  );
}
