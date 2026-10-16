/**
 * Model — what an account may spend on a crew. A new account has nothing:
 * the page says so in one line, takes the person's own subscription for
 * their own repositories, and shows a grant an admin gave. An admin sets or
 * takes back the grant from the account's page (`accounts.ts` shows the
 * card). A token is typed once and never shown again.
 */

import { ADD_MESSAGES, addOwnModel, setAccountGrant } from "../../actions/model_grant.ts";
import {
  budgetLine,
  getModelGrant,
  GRANT_MAX_USD,
  ownSubscription,
} from "../../core/model_grant.ts";
import { API_BASE_MAX } from "../../core/subscriptions.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, card } from "../ui.ts";
import { accountOnly, accountSections } from "./origins.ts";

// GET /settings/model
export function modelPage(ctx: Ctx): Response {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const user = ctx.auth.user!;
  const own = ownSubscription(ctx.app.db, user.id);
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
  return page({
    ctx,
    title: "Model",
    body: html`<div class="page-head"><h1>Model</h1></div>
      ${settingsLayout(
        accountSections("model", { admin: user.isAdmin }),
        card(html`${form}`, {
          head: html`<h2>Your model budget</h2>
            <p class="muted" id="model-budget">
              ${budgetLine(ctx.app.db, user, new Date())}
            </p>`,
        }),
        "Account settings",
      )}`,
  });
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
      ? { message: "Your subscription is added, for your own repositories." }
      : { tone: "danger", message: ADD_MESSAGES[added.error] },
  );
}

/** The admin's card on a person's page: what they have, and the grant form. */
export function grantCard(ctx: Ctx, user: User, at: string): Html {
  const grant = getModelGrant(ctx.app.db, user.id);
  return card(
    html`<form class="stack" method="post" action="${at}/model">
      <div class="field">
        <label for="f-grant">Grant, dollars a month</label>
        <input class="input" id="f-grant" name="usd" inputmode="decimal"
          autocomplete="off" placeholder="0 takes it back"
          value="${grant === undefined ? "" : grant.usdPerMonth.toFixed(2)}" />
        <span class="hint">Spent on the forge's own credential, up to
          $${GRANT_MAX_USD} a month; a run past the cap stops.</span>
      </div>
      <div>${btn("Save", { variant: "primary", size: "sm" })}</div>
    </form>`,
    {
      head: html`<h2>Model budget</h2>
        <p class="muted">${budgetLine(ctx.app.db, user, new Date())}</p>`,
    },
  );
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
