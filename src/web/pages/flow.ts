/**
 * /flow, for a forge admin: the pipeline from a ready issue to a live
 * deploy as rows, one per stage, each with how much is in it now, how long
 * its oldest waiting item has waited, and the capacity that limits it
 * (#1554). One sentence above names the stage with the longest wait — the
 * bottleneck. The numbers are `flow/pipeline.ts`'s; the knobs stay on
 * Settings → Capacity, linked from here.
 */

import {
  bottleneck,
  readPipeline,
  STAGE_HOLDS,
  STAGE_LABEL,
  verdict,
  waited,
} from "../../flow/pipeline.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { badge, card } from "../ui.ts";

// GET /flow
export function flowPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  const now = Date.now();
  const stages = readPipeline(ctx.app.db, new Date(now));
  const worst = bottleneck(stages);
  const body = html`<div class="page-head">
      <h1>Flow</h1>
      <p class="muted">
        From a ready issue to a live deploy: what is in each stage now, how
        long its oldest has waited, and what limits it. The limits are set on
        <a href="/settings/capacity">Capacity</a> and in each repository's
        autonomy settings.
      </p>
    </div>
    <p id="bottleneck" data-stage="${worst?.key ?? ""}">
      <strong>${verdict(stages, now)}</strong>
    </p>
    ${card(
      html`<div class="table-scroll">
        <table class="table" aria-label="Pipeline stages">
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Waiting</th>
              <th scope="col">Active</th>
              <th scope="col">Oldest wait</th>
              <th scope="col">Capacity</th>
            </tr>
          </thead>
          <tbody>
            ${stages.map(
              (s) =>
                html`<tr
                  data-stage="${s.key}"
                  ${s === worst ? html`data-bottleneck="true"` : null}
                >
                  <th scope="row">
                    ${STAGE_LABEL[s.key]}
                    ${s === worst ? badge("bottleneck", { tone: "danger" }) : null}
                    <div class="muted small">${STAGE_HOLDS[s.key]}</div>
                  </th>
                  <td class="mono">${String(s.waiting)}</td>
                  <td class="mono">${String(s.active)}</td>
                  <td class="mono">${waited(s, now) ?? "—"}</td>
                  <td class="small">${s.capacity ?? "—"}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>`,
      { pad: false },
    )}`;
  return page({ ctx, title: "Flow", body });
}
