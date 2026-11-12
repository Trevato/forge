/**
 * `/forges/refused`: the last 20 first asks a stranger made and the forge
 * refused, with the refusal's words — an admin's only, the same answer
 * `/forges` gives anyone else. One `listRefusals` call; the ask is text,
 * escaped; no email or claim code is held by the rows, so none is shown.
 */

import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { REFUSED_SHOWN, listRefusals, mayReadRefusals } from "../../core/first_ask_refusals.ts";
import { notFoundPage, pageHead } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { time } from "../ui.ts";

export { REFUSED_SHOWN };

// GET /forges/refused — an admin's only.
export function forgesRefusedPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  if (!mayReadRefusals(ctx.auth.user)) return notFoundPage(ctx);
  const rendering = performance.now();
  const rows = listRefusals(ctx.app.db, REFUSED_SHOWN, Date.now());
  const res = page({
    ctx,
    title: "Refused first asks",
    body: html`<div class="narrow-wide" data-refused>
      ${pageHead("Refused first asks", { sub: `The last ${REFUSED_SHOWN} first asks the forge turned away, newest first.` })}
      ${rows.length === 0
        ? html`<p class="muted">No first ask has been refused.</p>`
        : html`<ul class="list setting-list">
            ${rows.map(
              (r) => html`<li data-refusal>
                <p>${time(new Date(r.at).toISOString())} · <span class="muted">${r.actorId ?? "no one signed in"}</span></p>
                <p>${r.ask}</p>
                <p class="muted small">${r.words}</p>
              </li>`,
            )}
          </ul>`}
      <p class="mt"><a href="/forges">Forges you sent</a></p>
    </div>`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return res;
}
