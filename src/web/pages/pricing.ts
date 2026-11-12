/**
 * `/pricing` (#11138): the sale. A visitor with no account picks a plan, names
 * the forge, gives an email and pays at the provider's checkout; a minute
 * later `/pricing/done` shows the claim link, once. The free plan goes on to
 * `/forges/new`. With no provider connected the paid plans show their size and
 * say "ask the operator". The rules are in `actions/order.ts`.
 */

import { deliverLink, mayView, NO_PROVIDER, placeOrder, reconcileOrder, resendLink, type Refusal } from "../../actions/order.ts";
import { checkoutOf } from "../../billing/checkout.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { cookieValue, type Ctx } from "../../http/context.ts";
import { secureFor } from "../../http/cookie_secure.ts";
import { clientBucket } from "../../http/peer.ts";
import { takeDoor } from "../../http/strangers.ts";
import { FREE, getPlans, type Plan } from "../../settings/plans.ts";
import { sizeWords } from "../../settings/billing.ts";
import { childHost } from "../../spawn/door.ts";
import { notFoundPage, pageHead } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import { START_BUTTON, SITE_PATH } from "../site_line.ts";
import { offerData } from "../offer.ts";
import { safeJson } from "../structured_data.ts";
import { btn, field as formField, row } from "../ui.ts";
import { claimLinkBody } from "./new-forge.ts";

const COOKIE = "forge_order";
const REFRESH_JS = "setTimeout(function(){location.reload()},3000);";

interface Values {
  readonly name: string;
  readonly email: string;
}

const isBuyer = (ctx: Ctx): boolean => ctx.auth.user === undefined || ctx.auth.user.kind === "user";

function plansView(ctx: Ctx, values: Values, errors: Partial<Record<Refusal["field"], string>>): Html {
  const selling = checkoutOf(ctx.app) !== undefined;
  const plans = getPlans(ctx.app.db);
  const rows = plans.map((p: Plan) => {
    const free = p.key === FREE;
    const paid = !free && selling;
    return row({
      title: html`${p.name}`,
      meta: html`${sizeWords(p.size)}. ${p.says}${p.creditUsd > 0 && selling ? html` $${p.creditUsd} of crew credit each month.` : null}`,
      trail: free
        ? html`<span class="muted">Free</span> ${btn(START_BUTTON, { formaction: "/forges/start" })}`
        : paid
          ? html`<span>$${p.priceUsd} a month</span> ${btn(`Get ${p.name}`, { name: "plan", value: p.key, variant: "primary" })}`
          : html`<span class="muted">Ask the operator</span>`,
      data: { plan: p.key },
    });
  });
  return html`<div class="narrow-wide" id="pricing" data-pricing>
    ${pageHead("Get your own forge", { sub: selling ? "Pick a plan, name it, pay. Your forge is ready a minute later." : "Pick a size and name it." })}
    ${errors["form"] ? html`<p class="error" role="alert">${errors["form"]}</p>` : null}
    <form method="post" action="/pricing/order" class="stack" id="order">
      ${formField({
        label: "Name",
        name: "name",
        value: values.name,
        required: true,
        hint: `Its address: <name>--${childHost(ctx.app)}.`,
        ...(errors["name"] ? { error: errors["name"] } : {}),
      })}
      ${selling
        ? formField({
            label: "Email",
            name: "email",
            type: "email",
            value: values.email,
            autocomplete: "email",
            hint: "The link to open your forge is shown after payment and sent here.",
            ...(errors["email"] ? { error: errors["email"] } : {}),
          })
        : null}
      <ul class="list setting-list">${rows}</ul>
    </form>
    <p class="muted small">Paid already? <a href="/pricing/done">Open your order</a> · <a href="/pricing/resend">Lost your link?</a></p>
  </div>`;
}

// GET /pricing — public; agents are refused as buyers.
export function pricingPage(ctx: Ctx): Response {
  if (!isBuyer(ctx)) return notFoundPage(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const rendering = performance.now();
  const plans = getPlans(ctx.app.db);
  const response = page({
    ctx,
    title: "Open Platform Forge: pricing and your own forge",
    description: SITE_PATH(ctx.url.origin),
    jsonLd: safeJson({ "@context": "https://schema.org", "@type": "Product", name: "Open Platform Forge", url: `${ctx.url.origin}/`, offers: offerData(plans, ctx.url.origin) }),
    body: plansView(ctx, { name: (ctx.url.searchParams.get("name") ?? "").slice(0, 38), email: "" }, {}),
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

const cookieFor = (ctx: Ctx, value: string, maxAge: number): string =>
  `${COOKIE}=${value}; Path=/pricing; Max-Age=${maxAge}; SameSite=Lax; HttpOnly${secureFor(ctx.url, ctx.app.config.url) ? "; Secure" : ""}`;

// POST /pricing/order — free goes on to the free path; a paid plan holds the name and goes to checkout.
export async function pricingOrder(ctx: Ctx): Promise<Response> {
  if (!isBuyer(ctx)) return notFoundPage(ctx);
  const form = await readForm(ctx, ctx.auth.user === undefined ? undefined : "admin");
  if (form instanceof Response) return form;
  const values: Values = { name: field(form, "name").trim().slice(0, 60), email: field(form, "email").trim().slice(0, 254) };
  const plan = field(form, "plan");
  if (plan === FREE) return redirect(`/forges/new?name=${encodeURIComponent(values.name.slice(0, 38))}`);
  const verdict = takeDoor(ctx.app, "plan", ctx.request);
  if (!verdict.allowed) return page({ ctx, title: "Get your own forge", body: plansView(ctx, values, { form: `Too many tries from here; try again in ${verdict.retryAfter}s` }) }, 429);
  const placed = await placeOrder(ctx.app, { name: values.name, plan, email: values.email, address: clientBucket(ctx.request) }, ctx.url);
  if (!placed.ok) {
    const status = placed.error.message === NO_PROVIDER ? 409 : 422;
    return page({ ctx, title: "Get your own forge", body: plansView(ctx, values, { [placed.error.field]: `${placed.error.message}.` }) }, status);
  }
  const res = redirect(placed.value.redirect, { cookie: cookieFor(ctx, `${placed.value.id}.${placed.value.ticket}`, 2 * 86_400) });
  res.headers.set("cache-control", "no-store");
  return res;
}

/** The order the cookie names, when the address names the same one. */
function mine(ctx: Ctx): string | undefined {
  const id = ctx.url.searchParams.get("order") ?? "";
  const [cid, ticket] = (cookieValue(ctx.request, COOKIE) ?? "").split(".");
  if (cid !== id || ticket === undefined || !/^ord_[0-9a-f]{32}$/.test(id) || !mayView(ctx.app, id, ticket)) return undefined;
  return id;
}

const waiting = (ctx: Ctx, says: string): Response => {
  const res = page({
    ctx,
    title: "Making your forge",
    scriptJs: REFRESH_JS,
    body: html`<div class="narrow stack" data-order="waiting">${pageHead("Making your forge")}<p role="status">${says}</p><p class="small"><a href="${ctx.url.pathname}${ctx.url.search}">Check now</a></p></div>`,
  });
  res.headers.set("cache-control", "no-store");
  return res;
};

// GET /pricing/done?order= — reconciles the order with the provider, waits for the forge, shows the link once.
export async function pricingDone(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const rendering = performance.now();
  const response = await doneView(ctx);
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

async function doneView(ctx: Ctx): Promise<Response> {
  if (!isBuyer(ctx)) return notFoundPage(ctx);
  const id = mine(ctx);
  if (id === undefined) return notFoundPage(ctx);
  const o = await reconcileOrder(ctx.app, id);
  if (o === undefined) return notFoundPage(ctx);
  const plain = (title: string, body: Html, status = 200): Response => {
    const res = page({ ctx, title, body: html`<div class="narrow-wide" data-order="${o.state}">${pageHead(title)}<section class="settings-block">${body}</section></div>` }, status);
    res.headers.set("cache-control", "no-store");
    return res;
  };
  if (o.state === "pending") return waiting(ctx, "Waiting for the payment to arrive. This page updates by itself.");
  if (o.state === "paid" || o.state === "spawning") return waiting(ctx, `Paid. Making ${o.name} now; the link to open it appears here.`);
  if (o.state === "failed")
    return plain(`${o.name} is paid but not made yet`, html`<p>Your payment went through, but the forge could not be made just now: ${o.reason}.</p>
      <p>The operator has been told and will make it or pay you back. Keep this page's address: <code class="mono">${o.id}</code>.</p>`, 200);
  const given = await deliverLink(ctx.app, o);
  if (given.kind === "link")
    return plain(`${o.name} is ready`, html`${claimLinkBody(given.claimUrl, false)}${given.mailed ? html`<p class="small mt">It was also sent to ${o.email}.</p>` : null}`);
  if (given.kind === "claimed") return plain(`${o.name} is taken over`, html`<p>The link was used; sign in at <a href="${`https://${o.name}--${childHost(ctx.app)}`}">your forge</a>.</p>`);
  return plain(`${o.name} is ready`, html`<p>The link was shown already, once.</p><p class="mt">${btn("Send it again by email", { href: "/pricing/resend", size: "sm" })}</p>`);
}

function resendView(ctx: Ctx, says: string | undefined, values: Values): Html {
  return html`<div class="narrow stack" data-resend>
    ${pageHead("Lost your link?")}
    ${says === undefined ? null : html`<p role="status">${says}</p>`}
    <form method="post" action="/pricing/resend" class="stack">
      ${formField({ label: "Name of your forge", name: "name", value: values.name, required: true })}
      ${formField({ label: "Email you bought with", name: "email", type: "email", value: values.email, required: true, hint: "A new link goes there, and the old one stops working." })}
      ${btn("Send the link", { variant: "primary" })}
    </form>
  </div>`;
}

// GET /pricing/resend
export function resendPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  if (!isBuyer(ctx)) return notFoundPage(ctx);
  const rendering = performance.now();
  const response = page({ ctx, title: "Lost your link?", body: resendView(ctx, undefined, { name: "", email: "" }) });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /pricing/resend — the link goes to the order's own email; the answer is the same whether or not an order matched.
export async function resendSubmit(ctx: Ctx): Promise<Response> {
  if (!isBuyer(ctx)) return notFoundPage(ctx);
  const form = await readForm(ctx, ctx.auth.user === undefined ? undefined : "admin");
  if (form instanceof Response) return form;
  const values: Values = { name: field(form, "name").trim().slice(0, 60), email: field(form, "email").trim().slice(0, 254) };
  const verdict = takeDoor(ctx.app, "plan", ctx.request);
  if (!verdict.allowed) return page({ ctx, title: "Lost your link?", body: resendView(ctx, `Too many tries from here; try again in ${verdict.retryAfter}s.`, values) }, 429);
  const out = await resendLink(ctx.app, values.name, values.email);
  const says = out === "no_mail" ? "This forge cannot send email. Ask the operator for a new link." : "If that order exists, the link is on its way to the email it was bought with.";
  const res = page({ ctx, title: "Lost your link?", body: resendView(ctx, says, { name: "", email: "" }) });
  res.headers.set("cache-control", "no-store");
  return res;
}

