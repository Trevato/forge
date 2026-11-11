/**
 * GET /pricing: the plans on a page of their own, so a line that says "pick a
 * plan" (the first screen of a forge whose crew has no credit, #11240) has
 * somewhere to point. The words are the home's (`plans_row.ts`); the terminal's
 * door is the palette's "Get your own forge".
 */

import { notePhase, takeSessionTime, timePhase } from "../core/route_timing.ts";
import type { Ctx } from "../http/context.ts";
import { GET_A_FORGE_PATH } from "../billing/plan_words.ts";
import { getDoorSettings } from "../settings/door.ts";
import { publicPlans } from "../settings/plans.ts";
import { freePlanName } from "./funnel_door.ts";
import { html } from "./html.ts";
import { page } from "./layout.ts";
import { plansRow } from "./plans_row.ts";
import { btn } from "./ui.ts";

export function pricingPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const { plans, links } = getDoorSettings(ctx.app.db);
  const body = html`<section id="pricing" class="stack">
    <h1>Plans</h1>
    <p class="muted">Each plan comes with crew credit. Or add your own model key and the crew builds on it.</p>
    ${plansRow(publicPlans(plans), links)}
    <div class="bar" data-plan="${freePlanName(plans)}">${btn("Get a forge", { href: GET_A_FORGE_PATH, variant: "primary" })}</div>
  </section>`;
  return timePhase(ctx.request, "render", () => page({ ctx, title: "Plans", body }));
}
