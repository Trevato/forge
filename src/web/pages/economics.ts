/**
 * Settings → Economics, for a forge admin who is a person: the profit
 * slider's position (0 cheapest, 100 most responsive) with the policy it
 * means in words beside it, and the margin on crew spend (docs/PROFIT.md).
 * Beside them, where work runs: owned metal first, selected by the owned-node
 * label set here, and whether a cloud body takes bursts — without one the
 * page says "no cloud body: bursts queue" (#509).
 * The operator's prices, each with its unit, and what this UTC month has
 * cost so far at them, line by line (`core/cost.ts`).
 * Server-rendered; the forms are same-origin POSTs (`readForm`); a field a
 * form does not carry keeps its value. 50 is today's behaviour.
 * Anyone else gets the not-found page.
 */

import { ECONOMICS_WORDS, changeEconomics, readEconomics } from "../../actions/economics.ts";
import { MARGIN_MAX, POSITION_MAX, POSITION_MIN, PRICE_MAX_CENTS, SLOTS_MAX, usdOfCents } from "../../core/slider.ts";
import { OWNED_NODE_LABEL_DEFAULT } from "../../core/placement_policy.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, icon, row, time } from "../ui.ts";
import { accountSections } from "./origins.ts";

const PATH = "/settings/economics";

// GET /settings/economics
export function economicsPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  if (!ctx.auth.user) return signInFirst(ctx);
  const read = timePhase(ctx.request, "economics", () => readEconomics(ctx.app, ctx.auth.user));
  if (!read.ok) return notFoundPage(ctx);
  const rendering = performance.now();
  const e = read.value;
  const history = e.changes.map((c) =>
    row({
      lead: icon("history"),
      title: html`<span class="mono">${c.key}</span> <span class="mono">${c.from}</span> →
        <span class="mono">${c.to}</span>`,
      meta: html`${c.actorName === "" ? "someone" : c.actorName} · ${time(c.at)}`,
    }),
  );
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const priceField = (name: string, label: string, cents: number) =>
    html`<label class="small"
      >${label}
      <input
        class="input mono"
        type="number"
        name="${name}"
        min="0"
        max="${usdOfCents(PRICE_MAX_CENTS)}"
        step="0.01"
        inputmode="decimal"
        value="${usdOfCents(cents)}"
    /></label>`;
  const p = e.prices;
  const perSlot = p.ownedSlots > 0 && p.ownedMonthCents > 0 ? p.ownedMonthCents / 100 / p.ownedSlots : undefined;
  const c = e.month.cost;
  const line = (label: string, n: number) => html`<div><dt>${label}</dt><dd class="mono">${usd(n)}</dd></div>`;
  const body = html`<section class="settings-block">
      <h2>Profit slider</h2>
      <p class="muted small">One number for the whole forge, from 0 (cheapest) to 100 (most responsive).</p>
      <form class="row-fields" method="post" action="${PATH}">
        <label class="small"
          >Position
          <input
            class="input"
            type="range"
            name="position"
            min="${String(POSITION_MIN)}"
            max="${String(POSITION_MAX)}"
            step="1"
            value="${String(e.position)}"
            aria-label="Profit slider position: 0 cheapest, 100 most responsive"
        /></label>
        <span class="mono">${String(e.position)}</span>
        <label class="small"
          >Margin on crew spend (%)
          <input
            class="input mono"
            type="number"
            name="marginPct"
            min="0"
            max="${String(MARGIN_MAX)}"
            step="1"
            value="${String(e.marginPct)}"
        /></label>
        <label class="small"
          >Owned-node label
          <input
            class="input mono"
            type="text"
            name="ownedNodeLabel"
            maxlength="400"
            spellcheck="false"
            autocomplete="off"
            placeholder="${OWNED_NODE_LABEL_DEFAULT}"
            aria-describedby="owned-label-hint"
            value="${e.placement.ownedNodeLabel}"
        /></label>
        ${btn("Save", { size: "sm", variant: "primary", label: "Save economics" })}
      </form>
      <p class="muted small" id="owned-label-hint">The owned-node label selects owned metal; blank is the default, ${OWNED_NODE_LABEL_DEFAULT}.</p>
      <p data-policy>${e.words}.</p>
      <p data-placement>${e.placement.words}.</p>
    </section>
    <section class="settings-block">
      <h2>Prices</h2>
      <p class="muted small">What the forge costs you. The owned box costs the same each month whatever runs on it.</p>
      <form class="row-fields" method="post" action="${PATH}">
        ${priceField("ownedMonthUsd", "Owned box ($/month)", p.ownedMonthCents)}
        <label class="small"
          >Owned capacity (app-slots)
          <input
            class="input mono"
            type="number"
            name="ownedSlots"
            min="0"
            max="${String(SLOTS_MAX)}"
            step="1"
            value="${String(p.ownedSlots)}"
        /></label>
        ${priceField("cloudHourUsd", "Cloud ($/awake-hour)", p.cloudHourCents)}
        ${priceField("storageGbMonthUsd", "Storage ($/GB-month)", p.storageGbMonthCents)}
        ${btn("Save", { size: "sm", variant: "primary", label: "Save prices" })}
      </form>
      ${perSlot === undefined
        ? null
        : html`<dl class="stats" data-prices>
            <div><dt>Per app-slot ($/month)</dt><dd class="mono">${usd(perSlot)}</dd></div>
          </dl>`}
    </section>
    <section class="settings-block">
      <h2>This month so far</h2>
      <p class="muted small">From ${time(e.month.from)} to ${time(e.month.to)}, in US dollars.</p>
      <dl class="stats" data-cost>
        ${line("Owned metal", c.owned)} ${line("Cloud", c.cloud)} ${line("Storage", c.storage)}
        ${line("Crew", c.crew)} ${line("Total", c.total)}
      </dl>
    </section>
    <section class="settings-block">
      <h2>Changes</h2>
      ${history.length === 0
        ? html`<p class="muted">No change yet.</p>`
        : html`<ul class="list setting-list">
            ${history}
          </ul>`}
    </section>`;
  const response = page({
    ctx,
    title: "Economics",
    body: html`<div class="page-head"><h1>Economics</h1></div>
      ${settingsLayout(accountSections("economics", { admin: true }), body, "Account settings")}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /settings/economics
export async function economicsSet(ctx: Ctx): Promise<Response> {
  // Checked before the body is read: a non-admin learns nothing of the door.
  if (ctx.auth.user?.isAdmin !== true || ctx.auth.user.kind === "agent") return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  // A field the posted form does not carry is left undefined: kept as it stands.
  const given = (name: string) => (form.has(name) ? field(form, name) : undefined);
  const changed = changeEconomics(ctx.app, ctx.auth.user, {
    position: given("position"),
    marginPct: given("marginPct"),
    // The field left blank is the default label again.
    ownedNodeLabel: given("ownedNodeLabel"),
    ownedMonthUsd: given("ownedMonthUsd"),
    ownedSlots: given("ownedSlots"),
    cloudHourUsd: given("cloudHourUsd"),
    storageGbMonthUsd: given("storageGbMonthUsd"),
  });
  if (!changed.ok && changed.error === "not_found") return notFoundPage(ctx);
  return flashTo(
    ctx,
    PATH,
    changed.ok
      ? {
          message: `Saved: position ${changed.value.position}, margin ${changed.value.marginPct}%, owned box $${usdOfCents(changed.value.prices.ownedMonthCents)}/month.`,
        }
      : { tone: "danger", message: `${ECONOMICS_WORDS[changed.error as keyof typeof ECONOMICS_WORDS]}.` },
  );
}
