/**
 * Limits, for a forge admin: every limit the owner can hit, with its value,
 * its default and the reason it is there (`settings/limits.ts`). A change
 * governs the next request that meets the limit; each one is listed below:
 * who, when, from what to what. Anyone else gets the not-found page.
 */

import { changeLimit, listLimits } from "../../actions/limits.ts";
import { changeQuotas, readQuotas } from "../../actions/quotas.ts";
import { changeSignup, readSignup } from "../../actions/signup.ts";
import { SIGNUP_MODES } from "../../settings/signup.ts";
import { QUOTA_KEYS } from "../../settings/quotas.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, settingsLayout } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, card, icon, row, time } from "../ui.ts";
import { accountSections } from "./origins.ts";

// GET /admin/limits
export function limitsPage(ctx: Ctx): Response {
  const listed = listLimits(ctx.app, ctx.auth.user);
  if (!listed.ok) return notFoundPage(ctx);
  const { limits, changes } = listed.value;
  const rows = limits.map((l) =>
    row({
      lead: icon("activity"),
      title: html`${l.label} <span class="muted small mono">${l.key}</span>`,
      meta: html`${l.reason} <br />${l.isSet
          ? html`Set here; the default is
              <span class="mono">${String(l.defaultValue)}</span>.`
          : html`The default.`}
        Whole number, ${l.unit}, from
        <span class="mono">${String(l.min)}</span> to
        <span class="mono">${String(l.max)}</span>.`,
      trail: html`<form class="row-actions" method="post" action="/admin/limits">
        <input type="hidden" name="key" value="${l.key}" />
        <input
          class="input mono"
          type="number"
          name="value"
          min="${String(l.min)}"
          max="${String(l.max)}"
          step="1"
          value="${String(l.value)}"
          aria-label="${l.label}"
        />
        ${btn("Save", {
          size: "sm",
          variant: "primary",
          label: `Save ${l.label}`,
        })}
        ${when(
          l.isSet,
          () =>
            html`${btn("Default", {
              size: "sm",
              name: "reset",
              value: "1",
              label: `Back to the default for ${l.label}`,
            })}`,
        )}
      </form>`,
    }),
  );
  const history = changes.map((c) =>
    row({
      lead: icon("history"),
      title: html`<span class="mono">${c.key}</span>
        <span class="mono">${c.from}</span> →
        <span class="mono">${c.to}</span>`,
      meta: html`${c.actorName === "" ? "someone" : c.actorName} · ${time(c.at)}`,
    }),
  );
  const quotas = readQuotas(ctx.app, ctx.auth.user);
  const quotaHistory = (quotas.ok ? quotas.value.changes : []).map((c) =>
    row({
      lead: icon("history"),
      title: html`<span class="mono">${c.key}</span>
        <span class="mono">${c.from || "no limit"}</span> →
        <span class="mono">${c.to || "no limit"}</span>`,
      meta: html`${c.actorName === "" ? "someone" : c.actorName} · ${time(c.at)}`,
    }),
  );
  const quotaCard = card(
    html`<div class="card-body">
      <p class="muted small">
        What one account may own. Empty is no limit, and nothing enforces
        these yet.
      </p>
      <form class="row-actions" method="post" action="/admin/quotas">
        ${QUOTA_KEYS.map(
          (k) => html`<label class="small">${k}
            <input
              class="input mono"
              type="number"
              name="${k}"
              min="1"
              step="1"
              value="${quotas.ok ? String(quotas.value.quotas[k] ?? "") : ""}"
            /></label>`,
        )}
        ${btn("Save", { size: "sm", variant: "primary", label: "Save quotas" })}
      </form>
    </div>
    ${when(
      quotaHistory.length > 0,
      () => html`<ul class="list">${quotaHistory}</ul>`,
    )}`,
    {
      head: html`${icon("activity")}
        <h2>Account quotas</h2>`,
      pad: false,
    },
  );
  const signup = readSignup(ctx.app, ctx.auth.user);
  const signupHistory = (signup.ok ? signup.value.changes : []).map((c) =>
    row({
      lead: icon("history"),
      title: html`<span class="mono">${c.from}</span> →
        <span class="mono">${c.to}</span>`,
      meta: html`${c.actorName === "" ? "someone" : c.actorName} · ${time(c.at)}`,
    }),
  );
  const signupCard = card(
    html`<div class="card-body">
      <p class="muted small">
        Who may sign up: open, invite or closed. Nothing reads this yet.
      </p>
      <form class="row-actions" method="post" action="/admin/signup">
        <label class="small">signup
          <select class="input mono" name="signup">
            ${SIGNUP_MODES.map(
              (m) => html`<option value="${m}" ${signup.ok && signup.value.signup === m ? "selected" : ""}>${m}</option>`,
            )}
          </select></label>
        ${btn("Save", { size: "sm", variant: "primary", label: "Save signup" })}
      </form>
    </div>
    ${when(
      signupHistory.length > 0,
      () => html`<ul class="list">${signupHistory}</ul>`,
    )}`,
    {
      head: html`${icon("activity")}
        <h2>Signup</h2>`,
      pad: false,
    },
  );
  const body = html`${signupCard}${quotaCard}${card(
      html`<div class="card-body">
          <p class="muted small">
            Every limit you can hit, and why it is there. A change governs
            the next request that meets the limit; nothing needs a restart.
          </p>
        </div>
        <ul class="list">
          ${rows}
        </ul>`,
      {
        head: html`${icon("activity")}
          <h2>Limits</h2>`,
        pad: false,
      },
    )}
    ${card(
      history.length === 0
        ? html`<div class="card-body">
            <p class="muted small">No change yet.</p>
          </div>`
        : html`<ul class="list">
            ${history}
          </ul>`,
      {
        head: html`${icon("history")}
          <h2>Changes</h2>`,
        pad: false,
      },
    )}`;
  return page({
    ctx,
    title: "Limits",
    body: html`<div class="page-head"><h1>Limits</h1></div>
      ${settingsLayout(
        accountSections("limits", { admin: true }),
        body,
        "Account settings",
      )}`,
  });
}

// POST /admin/limits
export async function limitsSet(ctx: Ctx): Promise<Response> {
  // Checked before the body is read: a non-admin learns nothing of the door.
  if (ctx.auth.user?.isAdmin !== true || ctx.auth.user.kind === "agent")
    return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const key = field(form, "key");
  const reset = field(form, "reset") === "1";
  const changed = changeLimit(
    ctx.app,
    ctx.auth.user,
    key,
    reset ? null : field(form, "value"),
  );
  if (!changed.ok && changed.error.kind === "not_found")
    return notFoundPage(ctx);
  return flashTo(
    ctx,
    "/admin/limits",
    changed.ok
      ? {
          message:
            changed.value.from === changed.value.to
              ? `${key} is already ${changed.value.to}.`
              : `${key}: ${changed.value.from} → ${changed.value.to}.`,
        }
      : {
          tone: "danger",
          message:
            changed.error.kind === "out_of_bounds"
              ? `${changed.error.message}.`
              : "There is no such limit.",
        },
  );
}

// POST /admin/quotas
export async function quotasSet(ctx: Ctx): Promise<Response> {
  if (ctx.auth.user?.isAdmin !== true || ctx.auth.user.kind === "agent")
    return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const changed = changeQuotas(
    ctx.app,
    ctx.auth.user,
    Object.fromEntries(QUOTA_KEYS.map((k) => [k, field(form, k)])),
  );
  if (!changed.ok && changed.error === "not_found") return notFoundPage(ctx);
  return flashTo(
    ctx,
    "/admin/limits",
    changed.ok
      ? { message: "Quotas saved." }
      : { tone: "danger", message: "A quota is a positive whole number, or empty for no limit." },
  );
}

// POST /admin/signup
export async function signupSet(ctx: Ctx): Promise<Response> {
  if (ctx.auth.user?.isAdmin !== true || ctx.auth.user.kind === "agent")
    return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const changed = changeSignup(ctx.app, ctx.auth.user, field(form, "signup"));
  if (!changed.ok && changed.error === "not_found") return notFoundPage(ctx);
  return flashTo(
    ctx,
    "/admin/limits",
    changed.ok
      ? { message: "Signup saved." }
      : { tone: "danger", message: "Signup is open, invite or closed." },
  );
}
