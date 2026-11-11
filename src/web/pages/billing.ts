/**
 * Settings → Billing, for a forge admin who is a person (#11134): each
 * forge's plan with the hand grant that changes it, each grant kept in the
 * audit trail. Server-rendered; the forms are same-origin POSTs.
 * Anyone else gets the not-found page.
 */

import { ledBlock } from "./visitors.ts";
import { BILLING_WORDS, STRIPE_WORDS, connectStripe, disconnectStripe, grantPlan, readBilling, saveSigningSecret, type BillingError, type StripeWords } from "../../actions/billing.ts";
import { retryOrder } from "../../actions/order.ts";
import { REFUND_URL } from "../../billing/checkout.ts";
import { failedOrders } from "../../billing/orders.ts";
import { CODE_ERRORS, makeCode, readCodes, revoke, type CodeError } from "../../actions/codes.ts";
import { publicOrigin } from "../../core/public_origin.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { SIZES } from "../../spawn/sizes.ts";
import { BILLING_SIZES, parseBillingLinks } from "../../settings/billing.ts";
import { getPlans } from "../../settings/plans.ts";
import { changeBillingLinks, readBillingLinks } from "../../actions/signup.ts";
import { funnelReport, type FunnelReport } from "../../perf/funnel.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, copyField, field as formField, selectField } from "../ui.ts";
import { accountSections } from "./origins.ts";

const PATH = "/settings/billing";
const words = (e: BillingError | StripeWords) => (e === "not_found" ? "Not found" : e in BILLING_WORDS ? BILLING_WORDS[e as keyof typeof BILLING_WORDS] : STRIPE_WORDS[e as StripeWords]);

/** A code just made: the plain code and its link, shown once and never kept. */
interface Shown {
  readonly code: string;
  readonly link: string;
}

const day = (iso: string): string => iso.slice(0, 10);

/** The Codes section: make one, copy it once, then one line per code with its one action. */
function codesSection(ctx: Ctx, shown: Shown | undefined, values: Record<string, string>, error: string | undefined): Html | null {
  const read = readCodes(ctx.app, ctx.auth.user);
  if (!read.ok) return null;
  const { codes, plans } = read.value;
  const lines = codes.map((c) => {
    const state = c.revokedAt !== undefined ? "revoked" : c.expiresAt !== undefined && Date.parse(c.expiresAt) <= Date.now() ? "expired" : c.used >= c.uses ? "used up" : "";
    const who = c.redeemed.map((r) => `${r.forge} ${day(r.at)}`).join(", ");
    const redeemed = c.redeemed.length === 0 ? "not redeemed yet" : `redeemed by ${who}`;
    return html`<li class="row" data-code="${c.id}">
      <dl class="row-fields">
        <dt class="sr-only">Gives</dt>
        <dd><span class="mono">${c.plan}</span> <span class="muted small">${c.note}${c.expiresAt === undefined ? "" : ` · until ${day(c.expiresAt)}`}</span></dd>
        <dt class="sr-only">Used</dt>
        <dd class="small">${c.used} of ${c.uses} used${state === "" ? "" : ` · ${state}`} · <span class="muted">${redeemed}</span></dd>
      </dl>
      ${c.revokedAt === undefined
        ? html`<form method="post" action="${PATH}/codes/revoke">
            <input type="hidden" name="id" value="${c.id}" />
            ${btn("Stop this code working", { size: "sm", label: `Stop the code for ${c.note || c.plan} from working; forges already made keep their plan` })}
          </form>`
        : null}
    </li>`;
  });
  return html`<section class="settings-block" id="codes">
    <h2>Codes</h2>
    ${error === undefined ? null : html`<p class="error" role="alert">${error}</p>`}
    ${shown === undefined
      ? null
      : html`<div class="stack stack-tight" id="new-code" role="status">
          <p class="small">Shown once. It is kept only as a hash; send the link.</p>
          ${copyField("gift-code", shown.code, "The code", "Copy the code")}
          ${copyField("gift-link", shown.link, "The link to send", "Copy the link")}
        </div>`}
    <form class="row-fields" method="post" action="${PATH}/codes" id="make-code">
      ${selectField({ label: "Plan it gives", name: "plan", options: plans.map((p) => ({ value: p, label: p, selected: p === (values["plan"] ?? plans[0]) })) })}
      ${formField({ label: "Uses", name: "uses", type: "number", value: values["uses"] ?? "1" })}
      ${formField({ label: "Note", name: "note", value: values["note"] ?? "", hint: "For Mark" })}
      ${formField({ label: "Expires", name: "expires", type: "date", value: values["expires"] ?? "" })}
      ${btn("Make a code", { variant: "primary" })}
    </form>
    ${lines.length === 0 ? html`<p class="muted small">No code yet.</p>` : html`<ul class="list setting-list">${lines}</ul>`}
  </section>`;
}

const codeWords = (e: CodeError): string => (e === "not_found" ? "Not found" : CODE_ERRORS[e]);

/** The Payment links section: one https field per size a paid plan sits on, saved in one submit. */
function linksSection(ctx: Ctx, retry?: { values: Record<string, string>; error: string }): Html | null {
  const links = readBillingLinks(ctx.app, ctx.auth.user);
  if (!links.ok) return null;
  const paid = getPlans(ctx.app.db).filter((p) => p.priceUsd > 0);
  const fields = BILLING_SIZES.map((z) => {
    const named = paid.filter((p) => p.size === z).map((p) => p.name).join(", ");
    return { size: z, named };
  }).filter((f) => f.named !== "" || links.value[f.size] !== undefined);
  return html`<section class="settings-block" id="links">
    <h2>Payment links</h2>
    <p class="muted small">Where a buyer pays for each paid plan. With any set, the home page offers paid forges; empty clears one.</p>
    ${retry === undefined ? null : html`<p class="error" role="alert">${retry.error}</p>`}
    <form class="stack" method="post" action="${PATH}/links">
      ${fields.map((f) =>
        formField({ label: `${f.named === "" ? f.size : f.named} (${f.size})`, name: f.size, type: "url", value: retry?.values[f.size] ?? links.value[f.size] ?? "", hint: "https://" }),
      )}
      ${btn("Save payment links", { variant: "primary" })}
    </form>
  </section>`;
}

// POST /settings/billing/links
export async function billingSetLinks(ctx: Ctx): Promise<Response> {
  if (ctx.auth.user?.isAdmin !== true || ctx.auth.user.kind === "agent") return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const current = readBillingLinks(ctx.app, ctx.auth.user);
  const next: Record<string, string> = current.ok ? { ...current.value } : {};
  // Only the fields the form carries change; a size without a field keeps its link.
  for (const z of BILLING_SIZES) if (form.has(z)) next[z] = field(form, z);
  const changed = changeBillingLinks(ctx.app, ctx.auth.user, next);
  if (!changed.ok && changed.error === "not_found") return notFoundPage(ctx);
  if (changed.ok) return flashTo(ctx, `${PATH}#links`, { message: "Payment links saved." });
  // Name the sizes refused, and show the form again with what was typed.
  const refused = BILLING_SIZES.filter((z) => !parseBillingLinks({ [z]: next[z] }).ok);
  const error = `${refused.join(" and ")}: each payment link is an https address with no spaces, or empty. Nothing was saved.`;
  return billingView(ctx, undefined, {}, undefined, 422, { values: next, error });
}

/** Last 7 days, from visit to paid: one `dl` row per step with its share of the step before; clicks by plan and where they came from as rows under it. */
function funnelRow(r: FunnelReport): Html {
  const row = (label: string, value: string): Html => html`<div class="status-row"><dt>${label}</dt><dd>${value}</dd></div>`;
  return html`<section class="settings-block" id="funnel">
    <h2>Last 7 days: from visit to paid</h2>
    <dl class="status-rows" data-funnel>
      ${r.steps.map((s) => row(s.label, s.pct === null ? `${s.count}` : `${s.count} · ${s.pct}% of the step before`))}
      ${r.clicks_by_plan.map((c) => row(`Clicked ${c.plan}`, `${c.count}`))}
      ${r.referrers.map((x) => row(`Plan clicks from ${x.source}`, `${x.count}`))}
    </dl>
  </section>`;
}

// GET /settings/billing
export function billingPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  if (!ctx.auth.user) return signInFirst(ctx);
  return billingView(ctx);
}

function billingView(ctx: Ctx, shown?: Shown, values: Record<string, string> = {}, error?: string, status = 200, links?: { values: Record<string, string>; error: string }): Response {
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
  const s = b.stripe;
  const hook = b.events;
  const hookRows = html`<dl class="status-rows" data-stripe-events>
      <div class="status-row"><dt>Last event</dt><dd>${hook.last === undefined ? "No event yet" : html`<span class="mono">${hook.last.type}</span> <time datetime="${hook.last.at}">${hook.last.at.slice(0, 16).replace("T", " ")} UTC</time>`}</dd></div>
      <div class="status-row"><dt>Refused today</dt><dd>${hook.refusedToday}</dd></div>
    </dl>`;
  const stripe = html`<section class="settings-block">
      <h2>Provider</h2>
      ${hookRows}
      ${s
        ? html`<dl class="status-rows">
              <div class="status-row"><dt>Stripe</dt><dd data-mode="${s.mode}">${s.mode}</dd></div>
              <div class="status-row"><dt>Events</dt><dd>${s.signed ? "signed" : "no signing secret yet"}</dd></div>
            </dl>
          ${s.signed
            ? null
            : html`<form class="row-fields" method="post" action="${PATH}/stripe/secret">
                <input class="input mono" type="password" name="secret" autocomplete="off" placeholder="whsec_…" aria-label="Webhook signing secret" required />
                ${btn("Save signing secret")}
              </form>`}
          <form method="post" action="${PATH}/stripe/disconnect">${btn("Disconnect")}</form>`
        : html`<p class="muted small">Paste a Stripe secret or restricted key; the forge registers its own webhook.</p>
          <form class="row-fields" method="post" action="${PATH}/stripe/connect">
            <input class="input mono" type="password" name="key" autocomplete="off" placeholder="sk_test_… or rk_live_…" aria-label="Stripe key" required />
            ${btn("Connect")}
          </form>`}
    </section>`;
  const failed = failedOrders(ctx.app.db);
  const orders = failed.length === 0 ? null : html`<section class="settings-block" id="orders" data-orders>
      <h2>Paid, not made</h2>
      <p class="muted small">These buyers paid and their forge could not be made. Retry the spawn, or pay them back at the provider.</p>
      <ul class="list setting-list">${failed.map((o) => html`<li class="row">
        <form class="row-fields" method="post" action="${PATH}/orders/retry">
          <input type="hidden" name="id" value="${o.id}" />
          <span class="mono">${o.name}</span>
          <span class="muted small">${o.plan} · ${o.email} · ${o.reason}</span>
          ${btn("Retry")}
          <a href="${REFUND_URL}" rel="noopener noreferrer" target="_blank">Refund at provider</a>
        </form>
      </li>`)}</ul>
    </section>`;
  const body = html`${stripe}${orders}<section class="settings-block">
      <h2>Plans</h2>
      <p class="muted small">Choose the plan each forge is on.</p>
      ${rows.length === 0
        ? html`<p class="muted">No forge has been sent from here.</p>`
        : html`<ul class="list setting-list">${rows}</ul>`}
    </section>
    ${ledBlock(ctx)}
    ${funnelRow(funnelReport(ctx.app.db, 7))}
    ${linksSection(ctx, links)}
    ${codesSection(ctx, shown, values, error)}`;
  const response = page({
    ctx,
    title: "Billing",
    body: html`<div class="page-head"><h1>Billing</h1></div>
      ${settingsLayout(accountSections("billing", { admin: true }), body, "Account settings")}`,
  }, status);
  notePhase(ctx.request, "render", performance.now() - rendering);
  // A code just made is in this body only: never kept by a cache.
  if (shown !== undefined) response.headers.set("cache-control", "no-store");
  return response;
}

// POST /settings/billing/codes
export async function billingMakeCode(ctx: Ctx): Promise<Response> {
  if (ctx.auth.user?.isAdmin !== true || ctx.auth.user.kind === "agent") return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const values = { plan: field(form, "plan"), uses: field(form, "uses"), note: field(form, "note"), expires: field(form, "expires") };
  const made = makeCode(ctx.app, ctx.auth.user, values, publicOrigin(ctx.app.config.url, ctx.url.origin));
  if (!made.ok) return made.error === "not_found" ? notFoundPage(ctx) : billingView(ctx, undefined, values, `${codeWords(made.error)}.`, 422);
  return billingView(ctx, { code: made.value.code, link: made.value.link });
}

// POST /settings/billing/codes/revoke
export async function billingRevokeCode(ctx: Ctx): Promise<Response> {
  if (ctx.auth.user?.isAdmin !== true || ctx.auth.user.kind === "agent") return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const done = revoke(ctx.app, ctx.auth.user, field(form, "id"));
  if (!done.ok && done.error === "not_found") return notFoundPage(ctx);
  return flashTo(ctx, `${PATH}#codes`, done.ok ? { message: "Code revoked. Forges already made keep their plan." } : { tone: "danger", message: `${codeWords(done.error)}.` });
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

const back = (ctx: Ctx, r: { ok: true; message: string } | { ok: false; error: BillingError | StripeWords }): Response | Promise<Response> =>
  r.ok ? flashTo(ctx, PATH, { message: r.message }) : r.error === "not_found" ? notFoundPage(ctx) : flashTo(ctx, PATH, { tone: "danger", message: `${words(r.error)}.` });

const isPerson = (ctx: Ctx): boolean => ctx.auth.user?.isAdmin === true && ctx.auth.user.kind !== "agent";

// POST /settings/billing/stripe/connect
export async function stripeConnect(ctx: Ctx): Promise<Response> {
  if (!isPerson(ctx)) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const r = await connectStripe(ctx.app, ctx.auth.user, field(form, "key"), field(form, "secret"));
  return back(ctx, r.ok ? { ok: true, message: `Stripe is connected (${r.value.mode}).` } : r);
}

// POST /settings/billing/stripe/secret
export async function stripeSecret(ctx: Ctx): Promise<Response> {
  if (!isPerson(ctx)) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const r = saveSigningSecret(ctx.app, ctx.auth.user, field(form, "secret"));
  return back(ctx, r.ok ? { ok: true, message: "Signing secret saved." } : r);
}

// POST /settings/billing/stripe/disconnect
export async function stripeDisconnect(ctx: Ctx): Promise<Response> {
  if (!isPerson(ctx)) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const r = await disconnectStripe(ctx.app, ctx.auth.user);
  return back(ctx, r.ok ? { ok: true, message: "Stripe is disconnected." } : r);
}

// POST /settings/billing/orders/retry — an admin who is a person retries a paid order whose forge was not made.
export async function orderRetry(ctx: Ctx): Promise<Response> {
  if (!isPerson(ctx)) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const r = await retryOrder(ctx.app, ctx.auth.user, field(form, "id"));
  if (!r.ok) return r.error === "not_found" ? notFoundPage(ctx) : flashTo(ctx, PATH, { tone: "danger", message: "That order is not waiting for a retry." });
  return flashTo(ctx, PATH, r.value.state === "spawned" ? { message: `${r.value.name} is made.` } : { tone: "danger", message: `${r.value.name} still could not be made: ${r.value.reason}.` });
}
