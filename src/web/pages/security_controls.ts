/** GET /settings/security/controls: each safeguard, and when it was last tested (`checks/controls.ts`). */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { controlStandings, type Standing } from "../../checks/controls.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { badge, time } from "../ui.ts";
import { accountSections } from "./origins.ts";

function line({ control: c, check, attention }: Standing): Html {
  const state =
    check === null
      ? html`<span class="muted">No check recorded</span>`
      : html`${attention ? html`${badge(check.ok ? "Out of date" : "Failed", { tone: "attn" })} ` : null}<span class="muted">Checked ${time(check.at)}</span>`;
  return html`<div class="status-row" id="${c.id}">
    <dt title="${c.holds} Kept by ${c.keptBy}.">${c.name}</dt>
    <dd>${state}</dd>
  </div>`;
}

export function securityControlsPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const rendering = performance.now();
  const standings = controlStandings(ctx.app.config.dataDir, Date.now());
  const body = html`<p class="small muted mb">
      Each safeguard, and when it was last tested. <a href="/settings/security">Back to Security</a>.
    </p>
    <dl class="status-rows">
      ${standings.map(line)}
    </dl>`;
  notePhase(ctx.request, "render", performance.now() - rendering);
  return page({
    ctx,
    title: "Security controls",
    body: html`<div class="page-head"><h1>Security controls</h1></div>
      ${settingsLayout(accountSections("security", { admin: true }), body, "Account settings")}`,
  });
}
