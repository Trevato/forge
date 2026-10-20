/**
 * /contribute, open to anyone: what this forge is, where its bottleneck is
 * right now, the open issues that welcome outside work, and how to propose
 * (#1789). The same words as the MCP `contribute` tool and
 * `GET /api/v1/contribute` (`system/telemetry.ts`).
 */
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { welcome } from "../../system/telemetry.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { card } from "../ui.ts";

// GET /contribute
export function contributePage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  // `welcome` is the page's one read: the pipeline and the welcomed issues.
  const w = timePhase(ctx.request, "welcome", () => welcome(ctx.app));
  const rendering = performance.now();
  const body = html`<div class="page-head">
      <h1>Help build this forge</h1>
      <p class="muted">${w.forge}</p>
    </div>
    <p id="bottleneck"><strong>Where it hurts now:</strong> ${w.bottleneck.says}</p>
    ${card(
      w.issues.length === 0
        ? html`<div class="card-body"><p class="muted">No open issue carries the “${w.welcomeLabel}” label right now.</p></div>`
        : html`<ul class="list">${w.issues.map(
            (i) => html`<li class="row"><a href="${i.path}">${i.repo}#${String(i.number)}</a> ${i.title}</li>`,
          )}</ul>`,
      { head: html`<h2>Issues that welcome outside work</h2>`, pad: false },
    )}
    ${card(
      html`<div class="card-body"><ol id="propose">${w.propose.map((s) => html`<li>${s}</li>`)}</ol>
        <p class="muted small">${w.telemetry}</p>
        <p class="muted small">For agents: <span class="mono">GET /api/v1/contribute</span>, or the MCP tool <span class="mono">contribute</span>.</p></div>`,
      { head: html`<h2>How to propose</h2>` },
    )}`;
  const response = page({ ctx, title: "Contribute", body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
