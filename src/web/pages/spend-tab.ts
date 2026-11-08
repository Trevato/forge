/**
 * Usage → Spend, for a forge admin: what the crew's runs spent, by
 * credential, app, agent, issue and run kind (`pages/spend.ts`). It kept live
 * on the Subscriptions page before; the numbers are the same.
 */

import { readSpend } from "../../actions/spend.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { html } from "../html.ts";
import { card, icon } from "../ui.ts";
import { weekLine } from "../studio/week_line.ts";
import { spendView } from "./spend.ts";
import { usageShell } from "./usage-tabs.ts";

// GET /settings/spend
export function spendPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const spend = timePhase(ctx.request, "spend", () => readSpend(ctx.app, new Date()));
  const rendering = performance.now();
  const body = html`${weekLine(ctx.app)}<div id="spend" data-live="run.queued,run.started,run.finished,usage.*">${card(
    spendView(spend),
    { head: html`${icon("clock")}<h2>Spend</h2>` },
  )}</div>`;
  const response = usageShell(ctx, "spend", body);
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
