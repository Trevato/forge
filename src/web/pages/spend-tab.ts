/**
 * Usage → Spend, for a forge admin: what the crew's runs spent, by
 * credential, app, agent, issue and run kind (`pages/spend.ts`). It kept live
 * on the Subscriptions page before; the numbers are the same.
 */

import { readSpend } from "../../actions/spend.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { html } from "../html.ts";
import { card, icon } from "../ui.ts";
import { spendView } from "./spend.ts";
import { usageShell } from "./usage-tabs.ts";

// GET /settings/spend
export function spendPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  const body = html`<div id="spend" data-live="run.queued,run.started,run.finished,usage.*">${card(
    spendView(readSpend(ctx.app, new Date())),
    { head: html`${icon("clock")}<h2>Spend</h2>` },
  )}</div>`;
  return usageShell(ctx, "spend", body);
}
