/**
 * `/displays`: every display the viewer may read — each repository with a
 * `display.json` on its default branch (`display/config.ts`) — one row
 * each: title, layout, repository, and how many showcased demos it shows.
 * Read through the display cache (`display/known.ts`), so a warm page reads
 * no git. Read only: making a display is not here.
 */

import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { DISPLAYS_NOTE, INVALID_TITLE, listedDisplays } from "../../display/known.ts";
import type { Ctx } from "../../http/context.ts";
import { pageHead, repoBase, signInFirst } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { empty } from "../ui.ts";

const LAYOUT_WORD = { shelf: "Shelf", grid: "Grid", graph: "Graph" } as const;

// GET /displays — every display the viewer may read; a stranger signs in first.
export async function displaysPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  if (ctx.auth.user === undefined) return signInFirst(ctx);
  const rows = await timePhaseAsync(ctx.request, "displays", () => listedDisplays(ctx.app, ctx.auth.user));
  return timePhase(ctx.request, "render", () =>
    page({
      ctx,
      title: "Displays",
      body: html`${pageHead("Displays")}
        ${rows.length === 0
          ? empty({ icon: "pin", title: "No displays", note: DISPLAYS_NOTE })
          : html`<div class="table-scroll" role="region" tabindex="0" aria-label="Displays">
              <table class="table" data-dense data-by="displays">
                <thead>
                  <tr>
                    <th scope="col">Title</th>
                    <th scope="col">Layout</th>
                    <th scope="col">Repository</th>
                    <th scope="col">Demos</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows.map((d) => {
                    const base = repoBase(d.repo);
                    const name = `${d.repo.ownerName}/${d.repo.name}`;
                    return html`<tr data-display="${name}">
                      <td><a href="${base}/display">${d.config.ok ? d.config.value.title : INVALID_TITLE}</a></td>
                      <td>${d.config.ok ? LAYOUT_WORD[d.config.value.layout] : "None"}</td>
                      <td><a class="mono" href="${base}">${name}</a></td>
                      <td data-demos>${d.demos === undefined ? "None" : String(d.demos)}</td>
                    </tr>`;
                  })}
                </tbody>
              </table>
            </div>`}`,
    }),
  );
}
