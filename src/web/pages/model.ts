/**
 * Model — what an account may spend on a crew. A new account has nothing:
 * the page says so in one line, takes the person's own subscription for
 * their own repositories, and shows a grant an admin gave. An admin sets or
 * takes back the grant from the account's page (`accounts.ts` shows the
 * card). A token is typed once and never shown again.
 */

import { ADD_MESSAGES, addOwnModel, setAccountCeilings, setAccountGrant } from "../../actions/model_grant.ts";
import { SUBSCRIPTION_ADDED } from "../../actions/model_words.ts";
import { CEILING_MAX_USD, dailyLeft, getAccountCeiling } from "../../core/account_ceiling.ts";
import {
  budgetLine,
  getModelGrant,
  GRANT_MAX_USD,
  ownSubscription,
} from "../../core/model_grant.ts";
import { API_BASE_MAX } from "../../core/subscriptions.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, row } from "../ui.ts";
import { accountOnly, accountSections } from "./origins.ts";

// GET /settings/model
export function modelPage(ctx: Ctx): Response {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const user = ctx.auth.user!;
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const own = timePhase(ctx.request, "subscription", () => ownSubscription(ctx.app.db, user.id));
  const budget = timePhase(ctx.request, "budget", () => budgetLine(ctx.app.db, user, new Date()));
  const grant = getModelGrant(ctx.app.db, user.id);
  const rendering = performance.now();
  const form = own
    ? html`<p class="muted">
        Your subscription <strong>${own.name}</strong> pays for the crew on your
        own repositories, and on no one else's.
      </p>`
    : html`<form class="stack" method="post" action="/settings/model">
        <div class="field">
          <label for="f-token">Token</label>
          <input class="input" id="f-token" name="token" type="password"
            required autocomplete="off" spellcheck="false"
            placeholder="sk-ant-… or any provider's key" />
          <span class="hint"><code>claude setup-token</code> prints a
            subscription's token. It is sealed on this forge, never shown
            again, and pays only for repositories you own.</span>
        </div>
        <div class="field">
          <label for="f-api-base">API base URL (optional)</label>
          <input class="input" id="f-api-base" name="apiBase" type="url"
            maxlength="${API_BASE_MAX}" autocomplete="off" spellcheck="false"
            placeholder="https://openrouter.ai/api" />
        </div>
        <div>${btn("Add", { variant: "primary", size: "sm" })}</div>
      </form>`;
  const response = page({
    ctx,
    title: "Model",
    body: html`<div class="page-head"><h1>Model</h1></div>
      ${settingsLayout(
        accountSections("model", { admin: user.isAdmin }),
        html`<section class="settings-block">
          <h2>Your model budget</h2>
          ${grant === undefined || own || user.isAdmin
            ? html`<p class="muted" id="model-budget">${budget}</p>`
            : html`<ul class="list setting-list" id="model-budget">${row({
                title: "A grant from an admin",
                meta: html`${budget}`,
              })}</ul>`}
          ${form}
        </section>`,
        "Account settings",
      )}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /settings/model
export async function modelAdd(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const added = addOwnModel(ctx.app, ctx.auth.user, {
    token: field(form, "token").trim(),
    apiBase: field(form, "apiBase").trim(),
  });
  return flashTo(
    ctx,
    "/settings/model",
    added.ok
      ? { message: SUBSCRIPTION_ADDED }
      : { tone: "danger", message: ADD_MESSAGES[added.error] },
  );
}

/** The admin's card for an account's spend ceilings, on a person's or an organization's page. */
export function ceilingCard(ctx: Ctx, user: User, at: string): Html {
  const ceiling = getAccountCeiling(ctx.app.db, user.id);
  const left = dailyLeft(ctx.app.db, user.id, new Date());
  return html`<section class="settings-block">
    <h2>Spend ceilings</h2>
    <p class="muted" id="ceiling-line">
      ${ceiling === undefined || left === undefined
        ? "No ceiling set."
        : `$${ceiling.dailyUsd.toFixed(2)} a day, $${ceiling.perRunUsd.toFixed(2)} a run; $${left.toFixed(2)} left today.`}
    </p>
    <form class="stack" method="post" action="${at}/ceiling">
      <div class="field">
        <label for="f-daily">Daily ceiling, dollars</label>
        <input class="input" id="f-daily" name="daily" inputmode="decimal"
          autocomplete="off" value="${ceiling === undefined ? "" : ceiling.dailyUsd.toFixed(2)}" />
      </div>
      <div class="field">
        <label for="f-per-run">Per-run ceiling, dollars</label>
        <input class="input" id="f-per-run" name="perRun" inputmode="decimal"
          autocomplete="off" value="${ceiling === undefined ? "" : ceiling.perRunUsd.toFixed(2)}" />
        <span class="hint">Up to $${CEILING_MAX_USD}. Both empty takes them back. A run that would pass
          either does not start, or stops at it; apart from the forge-wide
          ceiling.</span>
      </div>
      <div>${btn("Save", { variant: "primary", size: "sm" })}</div>
    </form>
  </section>`;
}

/** The admin's card on a person's page: what they have, and the grant form. */
export function grantCard(ctx: Ctx, user: User, at: string): Html {
  const grant = getModelGrant(ctx.app.db, user.id);
  const ceilings = ceilingCard(ctx, user, at);
  const grantForm = html`<section class="settings-block">
    <h2>Model budget</h2>
    <p class="muted">${budgetLine(ctx.app.db, user, new Date())}</p>
    <form class="stack" method="post" action="${at}/model">
      <div class="field">
        <label for="f-grant">Grant, dollars a month</label>
        <input class="input" id="f-grant" name="usd" inputmode="decimal"
          autocomplete="off" placeholder="0 takes it back"
          value="${grant === undefined ? "" : grant.usdPerMonth.toFixed(2)}" />
        <span class="hint">Spent on the forge's own credential, up to
          $${GRANT_MAX_USD} a month; a run past the cap stops.</span>
      </div>
      <div>${btn("Save", { variant: "primary", size: "sm" })}</div>
    </form>
  </section>`;
  return html`${grantForm}${ceilings}`;
}

// POST /settings/accounts/:username/model
export async function grantAct(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const username = ctx.params.username ?? "";
  const raw = field(form, "usd").trim().replace(/^\$/, "");
  const usd = raw === "" || Number(raw) === 0 ? null : /^\d{1,6}(\.\d{1,2})?$/.test(raw) ? Number(raw) : NaN;
  const done = setAccountGrant(ctx.app, ctx.auth.user, username, usd);
  const back = `/settings/accounts/${encodeURIComponent(username)}`;
  if (!done.ok) {
    if (done.error === "not_found") return notFoundPage(ctx);
    return flashTo(ctx, back, {
      tone: "danger",
      message:
        done.error === "invalid_amount"
          ? `A grant is dollars a month, from 0.01 to ${GRANT_MAX_USD}; 0 takes it back.`
          : "You cannot give that to an admin or an agent.",
    });
  }
  return flashTo(ctx, back, {
    message:
      done.value.usdPerMonth === null
        ? `${username}'s grant is taken back.`
        : `${username} has $${done.value.usdPerMonth.toFixed(2)} a month.`,
  });
}

// POST /settings/accounts/:username/ceiling
export async function ceilingAct(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const username = ctx.params.username ?? "";
  // Both fields empty takes the ceilings back.
  const amount = (name: string): number | null => {
    const raw = field(form, name).trim().replace(/^\$/, "");
    if (raw === "") return null;
    return /^\d{1,6}(\.\d{1,2})?$/.test(raw) ? Number(raw) : NaN;
  };
  const done = setAccountCeilings(ctx.app, ctx.auth.user, username, amount("daily"), amount("perRun"));
  const back = `/settings/accounts/${encodeURIComponent(username)}`;
  if (!done.ok) {
    if (done.error === "not_found") return notFoundPage(ctx);
    return flashTo(ctx, back, {
      tone: "danger",
      message: `A ceiling is dollars, from 0.01 to ${CEILING_MAX_USD}.`,
    });
  }
  if (done.value.dailyUsd === null || done.value.perRunUsd === null)
    return flashTo(ctx, back, { message: `${username}'s ceilings are taken back.` });
  return flashTo(ctx, back, {
    message: `${username} has $${done.value.dailyUsd.toFixed(2)} a day and $${done.value.perRunUsd.toFixed(2)} a run.`,
  });
}
