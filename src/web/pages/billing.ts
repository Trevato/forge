/**
 * Settings → Billing, for a forge admin who is a person (#11134): each
 * forge's plan with the hand grant that changes it, each grant kept in the
 * audit trail. Server-rendered; the forms are same-origin POSTs.
 * Anyone else gets the not-found page.
 */

import { BILLING_WORDS, grantPlan, readBilling, type BillingError } from "../../actions/billing.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { SIZES } from "../../spawn/sizes.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn } from "../ui.ts";
import { accountSections } from "./origins.ts";

const PATH = "/settings/billing";
const words = (e: BillingError) => (e === "not_found" ? "Not found" : BILLING_WORDS[e]);

// GET /settings/billing
export function billingPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  if (!ctx.auth.user) return signInFirst(ctx);
  const read = readBilling(ctx.app, ctx.auth.user);
  if (!read.ok) return notFoundPage(ctx);
  const b = read.value;
  const rows = b.forges.map(
    (f) => html`<li class="row" data-forge="${f.forge}">
      <form class="row-fields" method="post" action="${PATH}/grant">
        <input type="hidden" name="forge" value="${f.forge}" />
        <span class="mono">${f.forge}</span>
        <span class="muted small">${f.status} · ${f.source}</span>
        <select class="input" name="plan" aria-label="Plan for ${f.forge}">
          ${Object.keys(SIZES).map((p) => html`<option value="${p}" ${p === f.plan ? html`selected` : null}>${p}</option>`)}
        </select>
        ${btn("Grant")}
      </form>
    </li>`,
  );
  const rendering = performance.now();
  const body = html`<section class="settings-block">
      <h2>Plans</h2>
      <p class="muted small">Choose the plan each forge is on.</p>
      ${rows.length === 0
        ? html`<p class="muted">No forge has been sent from here.</p>`
        : html`<ul class="list setting-list">${rows}</ul>`}
    </section>`;
  const response = page({
    ctx,
    title: "Billing",
    body: html`<div class="page-head"><h1>Billing</h1></div>
      ${settingsLayout(accountSections("billing", { admin: true }), body, "Account settings")}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /settings/billing/grant
export async function billingGrant(ctx: Ctx): Promise<Response> {
  if (ctx.auth.user?.isAdmin !== true || ctx.auth.user.kind === "agent") return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const set = grantPlan(ctx.app, ctx.auth.user, field(form, "forge"), field(form, "plan"));
  if (!set.ok && set.error === "not_found") return notFoundPage(ctx);
  return flashTo(ctx, PATH, set.ok ? { message: `${set.value.entitlement.forge} is on ${set.value.entitlement.plan}.` } : { tone: "danger", message: `${words(set.error)}.` });
}
