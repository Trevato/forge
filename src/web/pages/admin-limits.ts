/**
 * Limits, for a forge admin: every limit the owner can hit, with its value,
 * its default and the reason it is there (`settings/limits.ts`). A change
 * governs the next request that meets the limit; each one is listed below:
 * who, when, from what to what. Anyone else gets the not-found page.
 */

import { QUOTA_INVALID } from "../../actions/admin_limits_words.ts";
import { changeLimit, listLimits } from "../../actions/limits.ts";
import { changeQuotas, readQuotas } from "../../actions/quotas.ts";
import { inviteLink, list as listInviteLinks, mint as mintInviteLink, revoke as revokeInviteLink } from "../../actions/invites.ts";
import { INVITE_NOT_OPEN } from "../../actions/sever_invite_words.ts";
import { DEFAULT_DAYS, MAX_DAYS } from "../../core/invites.ts";
import { changeAgentStart, changeSignup, readAgentStart, readSignup } from "../../actions/signup.ts";
import { AGENT_START_MODES } from "../../settings/agent_start.ts";
import { SIGNUP_MEANS, SIGNUP_MODES } from "../../settings/signup.ts";
import { QUOTA_KEYS } from "../../settings/quotas.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { notFoundPage, settingsLayout } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, confirmAction, icon, row, time } from "../ui.ts";
import { accountSections } from "./origins.ts";

// GET /admin/limits
export function limitsPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const listed = timePhase(ctx.request, "limits", () => listLimits(ctx.app, ctx.auth.user));
  if (!listed.ok) return notFoundPage(ctx);
  const quotas = timePhase(ctx.request, "quotas", () => readQuotas(ctx.app, ctx.auth.user));
  const signup = timePhase(ctx.request, "signup", () => readSignup(ctx.app, ctx.auth.user));
  const agentStart = readAgentStart(ctx.app, ctx.auth.user);
  const invites = timePhase(ctx.request, "invites", () => listInviteLinks(ctx.app, ctx.auth.user));
  const rendering = performance.now();
  const { limits, changes } = listed.value;
  const rows = limits.map(
    (l) => html`<tr>
      <td>
        <strong>${l.label}</strong> <span class="muted small mono">${l.key}</span>
        <div class="muted small truncate" title="${l.reason}">${l.reason}</div>
      </td>
      <td class="nowrap">
        Now <span class="mono">${String(l.value)}</span>
        <span class="muted small"
          >${l.isSet ? html`set here, default <span class="mono">${String(l.defaultValue)}</span>` : "default"} ·
          <span class="mono">${String(l.min)}</span> to <span class="mono">${String(l.max)}</span> ${l.unit}</span
        >
      </td>
      <td>
        <form class="row-fields" method="post" action="/admin/limits">
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
          ${btn("Save", { size: "sm", variant: "primary", label: `Save ${l.label}` })}
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
        </form>
      </td>
    </tr>`,
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
  const quotaHistory = (quotas.ok ? quotas.value.changes : []).map((c) =>
    row({
      lead: icon("history"),
      title: html`<span class="mono">${c.key}</span>
        <span class="mono">${c.from || "no limit"}</span> →
        <span class="mono">${c.to || "no limit"}</span>`,
      meta: html`${c.actorName === "" ? "someone" : c.actorName} · ${time(c.at)}`,
    }),
  );
  const quotaRow = html`<div class="status-row">
    <dt>Account quotas</dt>
    <dd>
      <form class="row-fields" method="post" action="/admin/quotas">
        ${QUOTA_KEYS.map(
          (k) => html`<label class="small">${k === "storage" ? "storage (MB)" : k}
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
      <span class="muted small">What one account may own, run at once and store. Empty is no limit; an admin is never held to one.</span>
    </dd>
    <dd class="status-act"></dd>
  </div>`;
  const signupHistory = (signup.ok ? signup.value.changes : []).map((c) =>
    row({
      lead: icon("history"),
      title: html`<span class="mono">${c.from}</span> →
        <span class="mono">${c.to}</span>`,
      meta: html`${c.actorName === "" ? "someone" : c.actorName} · ${time(c.at)}`,
    }),
  );
  const signupRow = html`<div class="status-row">
    <dt>New accounts</dt>
    <dd>
      <form class="row-fields" method="post" action="/admin/signup">
        <select class="input mono" name="signup" aria-label="New accounts">
          ${SIGNUP_MODES.map(
            (m) => html`<option value="${m}" ${signup.ok && signup.value.signup === m ? "selected" : ""}>${m}</option>`,
          )}
        </select>
        ${btn("Save", { size: "sm", variant: "primary", label: "Save signup" })}
      </form>
      <ul class="muted small" id="signup-means">
        ${SIGNUP_MODES.map((m) => html`<li><strong>${m}</strong>: ${SIGNUP_MEANS[m]}</li>`)}
      </ul>
    </dd>
    <dd class="status-act"></dd>
  </div>`;
  const agentStartRow = html`<div class="status-row">
    <dt>Agents can start here</dt>
    <dd>
      <form class="row-fields" method="post" action="/admin/agent-start">
        <select class="input mono" name="agent_start" aria-label="Agents can start here">
          ${AGENT_START_MODES.map(
            (m) => html`<option value="${m}" ${agentStart.ok && agentStart.value === m ? "selected" : ""}>${m === "code" ? "invite code" : m}</option>`,
          )}
        </select>
        ${btn("Save", { size: "sm", variant: "primary", label: "Save agent start" })}
      </form>
    </dd>
    <dd class="status-act"></dd>
  </div>`;
  const inviteRows = (invites.ok ? invites.value : []).map((i) =>
    row({
      lead: icon("activity"),
      title: html`<span class="mono">${i.id}</span> <span class="muted small">${
        i.state !== "used"
          ? i.state
          : html`used${i.usedBy === null ? "" : html` by <a href="/${i.usedBy}">${i.usedBy}</a>`}${
              i.usedAt === null ? "" : ` on ${i.usedAt.slice(0, 10)}`
            }`
      }</span>`,
      meta: html`Made ${time(i.createdAt)} · expires ${time(i.expiresAt)}`,
      trail:
        i.state === "open"
          ? confirmAction({ action: `/admin/invites/${i.id}/revoke`, verb: "Revoke", size: "sm" })
          : html``,
    }),
  );
  const inviteRow = html`<div class="status-row">
    <dt>Invite links</dt>
    <dd>
      <form class="row-fields" method="post" action="/admin/invites">
        <label class="small">expires in (days)
          <input
            class="input mono"
            type="number"
            name="days"
            min="1"
            max="${String(MAX_DAYS)}"
            step="1"
            value="${String(DEFAULT_DAYS)}"
          /></label>
        ${btn("Make a link", { size: "sm", variant: "primary", label: "Make an invite link" })}
      </form>
      <span class="muted small">Shown once, when it is made; good for one signup.</span>
    </dd>
    <dd class="status-act"></dd>
  </div>`;
  const historyBlock = (title: string, items: Html[]): Html | null =>
    items.length === 0 ? null : html`<section class="settings-block"><h2>${title}</h2><ul class="list">${items}</ul></section>`;
  const body = html`<p class="small muted mb">
      Every limit you can hit, and why. A change applies to the next request that meets it; nothing needs a restart.
    </p>
    <dl class="status-rows">${signupRow}${agentStartRow}${inviteRow}${quotaRow}</dl>
    ${historyBlock("Invite links made", inviteRows)}
    <section class="settings-block mt">
      <h2>Limits</h2>
      <div class="table-scroll">
        <table class="table setting-table" data-dense>
          <caption class="sr-only">Limits, their values and how to change them</caption>
          <thead><tr><th scope="col">Limit</th><th scope="col">Now</th><th scope="col">Change</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
    ${historyBlock("Signup changes", signupHistory)}
    ${historyBlock("Quota changes", quotaHistory)}
    <section class="settings-block mt">
      <h2>Changes</h2>
      ${history.length === 0 ? html`<p class="muted small">No change yet.</p>` : html`<ul class="list">${history}</ul>`}
    </section>`;
  const response = page({
    ctx,
    title: "Limits",
    body: html`<div class="page-head"><h1>Limits</h1></div>
      ${settingsLayout(
        accountSections("limits", { admin: true }),
        body,
        "Account settings",
      )}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
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
      : { tone: "danger", message: QUOTA_INVALID },
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
      : { tone: "danger", message: "New accounts are open, request, invite or closed." },
  );
}

// POST /admin/agent-start
export async function agentStartSet(ctx: Ctx): Promise<Response> {
  if (ctx.auth.user?.isAdmin !== true || ctx.auth.user.kind === "agent") return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const changed = changeAgentStart(ctx.app, ctx.auth.user, field(form, "agent_start"));
  if (!changed.ok && changed.error === "not_found") return notFoundPage(ctx);
  return flashTo(
    ctx,
    "/admin/limits",
    changed.ok
      ? { message: "Agent start saved." }
      : { tone: "danger", message: "Agents can start here: open, invite code or off." },
  );
}

// POST /admin/invites
export async function inviteMint(ctx: Ctx): Promise<Response> {
  if (ctx.auth.user?.isAdmin !== true || ctx.auth.user.kind === "agent")
    return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const raw = field(form, "days").trim();
  const made = mintInviteLink(ctx.app, ctx.auth.user, /^\d{1,3}$/.test(raw) ? Number(raw) : -1);
  if (!made.ok && made.error === "not_found") return notFoundPage(ctx);
  if (!made.ok)
    return flashTo(ctx, "/admin/limits", {
      tone: "danger",
      message: `Days is a whole number from 1 to ${MAX_DAYS}.`,
    });
  return flashTo(ctx, "/admin/limits", {
    message: "Invite link made. It is shown only now:",
    code: inviteLink(ctx.app.config.url ?? ctx.url.origin, made.value.token),
  });
}

// POST /admin/invites/:id/revoke
export async function inviteRevoke(ctx: Ctx): Promise<Response> {
  if (ctx.auth.user?.isAdmin !== true || ctx.auth.user.kind === "agent")
    return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const done = revokeInviteLink(ctx.app, ctx.auth.user, ctx.params.id ?? "");
  return flashTo(
    ctx,
    "/admin/limits",
    done.ok
      ? { message: "Invite link revoked." }
      : { tone: "danger", message: INVITE_NOT_OPEN },
  );
}
