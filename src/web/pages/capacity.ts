/**
 * Capacity, for a forge admin: how many crew runs and checks go at once,
 * how many shards a check uses, and whether a cell's undeclared egress is
 * refused or reported (`core/capacity.ts`). A change here is honoured by
 * the next run, check or cell — never by a restart, which is the point —
 * and each one is listed below the settings: who, when, from what to what.
 */

import { changeCapacity, listCapacity } from "../../actions/capacity.ts";
import { CAPACITY, type CapacityKey } from "../../core/capacity.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, card, icon, row, time } from "../ui.ts";
import { accountSections } from "./origins.ts";

function requireAdmin(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  return undefined;
}

function input(key: CapacityKey, value: string) {
  const kind = CAPACITY[key].kind;
  if (kind.type === "choice")
    return html`<select
      class="input"
      name="value"
      aria-label="${CAPACITY[key].label}"
    >
      ${kind.values.map(
        (v) =>
          html`<option value="${v}" ${v === value ? "selected" : ""}>
            ${v}
          </option>`,
      )}
    </select>`;
  return html`<input
    class="input mono"
    type="number"
    name="value"
    min="${String(kind.min)}"
    max="${String(kind.max)}"
    value="${value}"
    aria-label="${CAPACITY[key].label}"
  />`;
}

// GET /settings/capacity
export function capacityPage(ctx: Ctx): Response {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const listed = listCapacity(ctx.app, ctx.auth.user);
  if (!listed.ok) return notFoundPage(ctx);
  const { settings, changes } = listed.value;
  const rows = settings.map((s) =>
    row({
      lead: icon("activity"),
      title: html`${s.label} <span class="muted small mono">${s.key}</span>`,
      meta: html`${s.help} <br />${s.source === "setting"
          ? html`Set here; the boot default is
              <span class="mono">${s.default === "" ? "auto" : s.default}</span>
              (<span class="mono">${s.env}</span>).`
          : html`The boot default, from <span class="mono">${s.env}</span>.`}`,
      trail: html`<form
        class="row-actions"
        method="post"
        action="/settings/capacity"
      >
        <input type="hidden" name="key" value="${s.key}" />
        ${input(s.key, s.value)}
        ${btn("Save", {
          size: "sm",
          variant: "primary",
          label: `Save ${s.label}`,
        })}
        ${when(
          s.source === "setting",
          () =>
            html`${btn("Default", {
              size: "sm",
              name: "reset",
              value: "1",
              label: `Back to the default for ${s.label}`,
            })}`,
        )}
      </form>`,
    }),
  );
  const history = changes.map((c) =>
    row({
      lead: icon("history"),
      title: html`<span class="mono">${c.key}</span>
        <span class="mono">${c.from === "" ? "auto" : c.from}</span> →
        <span class="mono">${c.to === "" ? "auto" : c.to}</span>`,
      meta: html`${c.actorName === "" ? "someone" : c.actorName} · ${time(c.at)}`,
    }),
  );
  const body = html`${card(
    html`<div class="card-body">
        <p class="muted small">
          How much the forge does at once. A change here takes effect on the
          next crew run, check or app start — running work is left to finish —
          and never needs a restart.
        </p>
      </div>
      <ul class="list">
        ${rows}
      </ul>`,
    {
      head: html`${icon("activity")}
        <h2>Capacity</h2>`,
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
    title: "Capacity",
    body: html`<div class="page-head"><h1>Capacity</h1></div>
      ${settingsLayout(
        accountSections("capacity", { admin: true }),
        body,
        "Account settings",
      )}`,
  });
}

const ERRORS: Record<string, string> = {
  no_such_setting: "There is no such setting.",
  invalid_value: "That value is outside what this setting takes.",
};

// POST /settings/capacity
export async function capacitySet(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const key = field(form, "key");
  const reset = field(form, "reset") === "1";
  const changed = changeCapacity(
    ctx.app,
    ctx.auth.user,
    key,
    reset ? null : field(form, "value"),
  );
  if (!changed.ok && changed.error === "not_found") return notFoundPage(ctx);
  return flashTo(
    ctx,
    "/settings/capacity",
    changed.ok
      ? {
          message:
            changed.value.from === changed.value.to
              ? `${key} is already ${changed.value.to || "auto"}.`
              : `${key}: ${changed.value.from || "auto"} → ${changed.value.to || "auto"}, from the next pick on.`,
        }
      : {
          tone: "danger",
          message: ERRORS[changed.error] ?? "That could not be set.",
        },
  );
}
