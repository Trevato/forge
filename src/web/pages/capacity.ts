/**
 * Capacity, for a forge admin: how many crew runs and checks go at once,
 * how many shards a check uses, and whether a cell's undeclared egress is
 * refused or reported (`core/capacity.ts`). A change here is honoured by
 * the next run, check or cell — never by a restart, which is the point —
 * and each one is listed below the settings: who, when, from what to what.
 */

import { changeCapacity, listCapacity, type CapacityRow } from "../../actions/capacity.ts";
import { CAPACITY, type CapacityKey } from "../../core/capacity.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when } from "../html.ts";
import { flashTo } from "../layout.ts";
import { btn, card, icon, row, time } from "../ui.ts";
import { usageShell } from "./usage-tabs.ts";

function requireAdmin(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  return undefined;
}

const DAY_MS = 86_400_000;

/** "today", "1 day ago", "9 days ago". */
export function daysAgo(at: string, now: number): string {
  const days = Math.max(0, Math.floor((now - Date.parse(at)) / DAY_MS));
  return days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`;
}

/** One muted line beside a setting away from its default; Put back is in the row's trail form. */
function awayLine(s: CapacityRow, now: number) {
  if (s.changed === undefined) return null;
  return html`<span class="muted small">changed from
    <span class="mono">${s.default === "" ? "auto" : s.default}</span>
    ${daysAgo(s.changed.at, now)} by ${s.changed.by}</span>`;
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
  const now = Date.now();
  const rows = settings.map((s) =>
    row({
      lead: icon("activity"),
      title: html`${s.label} <span class="muted small mono">${s.key}</span>`,
      meta: html`${s.help} <br />Now <span class="mono">${s.value === "" ? "auto" : s.value}</span>. ${s.source === "setting"
          ? html`Set here; the boot default is
              <span class="mono">${s.default === "" ? "auto" : s.default}</span>
              (<span class="mono">${s.env}</span>).`
          : html`The boot default, from <span class="mono">${s.env}</span>.`}
        ${awayLine(s, now)}`,
      trail: html`<form
        class="row-fields"
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
            html`${btn(s.changed === undefined ? "Default" : "Put back", {
              size: "sm",
              name: "reset",
              value: "1",
              label: s.changed === undefined ? `Back to the default for ${s.label}` : `Put ${s.label} back to the default`,
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
  const reported = settings.some(
    (s) => s.key === "cells.egress" && s.value === "report",
  );
  const errs = ctx.app.signals.errors.recent(10);
  const refused = ctx.app.signals.refused.recent();
  const happened = card(
    html`<div class="card-body">
      <p class="muted small" id="errors">
        ${errs.lastHour} error${errs.lastHour === 1 ? "" : "s"} in the last
        hour; the latest ${errs.latest.length}, newest first.
      </p>
      <ul class="list small mono">
        ${errs.latest.map(
          (e) => html`<li>${e.at} [${e.scope}] ${e.message}</li>`,
        )}
      </ul>
      <p class="muted small" id="internal">
        ${refused.lastHour} internal call${refused.lastHour === 1 ? "" : "s"}
        without the boot secret refused in the last hour${refused.latest
          ? html`; the latest was
              <span class="mono">${refused.latest.method} ${refused.latest.path}</span>`
          : ""}.
      </p>
    </div>`,
    {
      head: html`${icon("activity")}
        <h2>Errors and refused calls</h2>`,
      pad: false,
    },
  );
  const body = html`${happened}${when(
      reported,
      () => html`<p class="muted small mb" id="egress-reported">
        ${icon("activity")} Egress is reported, not enforced: every new app,
        preview, terminal and check cell may reach any public host on ports
        80 and 443, declared or not. Private, loopback and cluster addresses,
        and every other port, stay refused. Set it back to enforce once each
        app's reported hosts are in its forge.json.
      </p>`,
    )}
    ${card(
    html`<div class="card-body">
        <p class="muted small">
          How much the forge does at once. A change here takes effect on the
          next crew run, check or app start — running work is left to finish —
          and never needs a restart.
        </p>
      </div>
      <ul class="list setting-list">
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
  return usageShell(ctx, "capacity", body);
}

const ERRORS: Record<string, string> = {
  no_such_setting: "There is no such setting.",
  invalid_value: "That value is outside what this setting takes.",
  no_credential:
    "Add a passkey (or a password) to your own account first: with the edge off, you would be signed out for good.",
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
