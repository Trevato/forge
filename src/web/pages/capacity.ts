/**
 * Capacity, for a forge admin: how many crew runs and checks go at once,
 * how many shards a check uses, and whether a cell's undeclared egress is
 * refused or reported (`core/capacity.ts`). A change here is honoured by
 * the next run, check or cell — never by a restart, which is the point —
 * and each one is listed below the settings: who, when, from what to what.
 */

import { DERIVED_WORDS, changeCapacity, edgeOffDryRun, listCapacity, type CapacityRow } from "../../actions/capacity.ts";
import { CAPACITY, belowCeiling, type CapacityKey } from "../../core/capacity.ts";
import { bytes } from "../../system/format.ts";
import { egressRowsFor } from "../../spawn/process_counters.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo } from "../layout.ts";
import { badge, btn, row, time } from "../ui.ts";
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

/** A titled part of the page: a small heading over its rows, never a card box (docs/DESIGN.md §7). */
function block(title: string, content: Html) {
  return html`<section class="settings-block"><h2>${title}</h2>${content}</section>`;
}

// GET /settings/capacity
export function capacityPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const listed = timePhase(ctx.request, "capacity", () =>
    listCapacity(ctx.app, ctx.auth.user),
  );
  if (!listed.ok) return notFoundPage(ctx);
  const { settings, changes, egress, selfSwap } = listed.value;
  const errs = timePhase(ctx.request, "errors", () =>
    ctx.app.signals.errors.recent(10),
  );
  const refused = timePhase(ctx.request, "refused", () =>
    ctx.app.signals.refused.recent(),
  );
  const now = Date.now();
  const rendering = performance.now();
  const rows = settings.map((s) => {
    const low = belowCeiling(ctx.app.db, s.key);
    return row({
      title: html`${s.label} <span class="muted small mono">${s.key}</span>${when(
        low !== null,
        () => html` ${badge(`below ceiling ${low?.ceiling}`, { tone: "attn" })}`,
      )}`,
      meta: html`${s.help} <br />Now <span class="mono">${s.value === "" ? "auto" : s.value}</span>. ${s.source === "setting"
          ? html`Set here; the boot default is
              <span class="mono">${s.default === "" ? "auto" : s.default}</span>
              (<span class="mono">${s.env}</span>).`
          : s.source === "derived"
            ? html`Derived from Speed (<span class="mono">crew.concurrency</span>); read-only here: change Speed and it moves.`
            : html`The boot default, from <span class="mono">${s.env}</span>.`}
        ${awayLine(s, now)}`,
      trail: s.source === "derived"
        ? html`<span class="mono" data-derived="${s.key}">${s.value}</span>`
        : html`<form
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
          s.key === "signin.edge",
          () => html`${btn("Dry run", { size: "sm", name: "dry", value: "1", label: "List who switching the edge off would lock out" })}`,
        )}
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
    });
  });
  const history = changes.map((c) =>
    row({
      title: html`<span class="mono">${c.key}</span>
        <span class="mono">${c.from === "" ? "auto" : c.from}</span> →
        <span class="mono">${c.to === "" ? "auto" : c.to}</span>`,
      meta: html`${c.actorName === "" ? "someone" : c.actorName} · ${time(c.at)}`,
    }),
  );
  const reported = settings.some(
    (s) => s.key === "cells.egress" && s.value === "report",
  );
  const happened = block(
    "Errors and refused calls",
    html`<p class="muted small" id="errors">
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
      </p>`,
  );
  const open = egressRowsFor(ctx.app);
  // The bun cache at work (#7546): a warm cache keeps this near zero.
  const npm = html`The npm registry sent
    <span class="mono">${bytes(egress.npmBytesLastHour)}</span> over the last hour${
      egress.npmTopRepoLastHour === null
        ? "."
        : html`, most to
            <span class="mono">${egress.npmTopRepoLastHour.repo}</span>
            (<span class="mono">${bytes(egress.npmTopRepoLastHour.bytes)}</span>).`
    }`;
  const connections = block(
    "Egress connections",
    open.length === 0
      ? html`<p class="muted small" id="egress-npm">${npm}</p>
          <p class="muted small" id="egress-open">
            No app holds an egress connection open.
          </p>`
      : html`<ul class="list setting-list" id="egress-open">
          ${row({ id: "egress-npm", title: npm })}
          ${open.map((r) =>
            row({
              title: r.label === "" ? "(unlabelled)" : r.label,
              meta: html`<span class="mono">${r.destination}</span> ·
                ${bytes(r.bytesIn)} in · ${bytes(r.bytesOut)} out`,
              trail: html`<span class="mono">${r.open} open</span>`,
            }),
          )}
        </ul>`,
  );
  // Whether a landing here can swap the forge in place (#8383): the reason, before one is refused.
  const swap = block(
    "Self-swap",
    html`<ul class="list setting-list">
      ${row({
        id: "self-swap",
        title: selfSwap.blocked ?? "A landed release of the forge takes over the port in place.",
        meta: html`<span class="mono">FORGE_SELF_SWAP</span> ${selfSwap.enabled ? "is set" : "is off"}
          · <span class="mono">net.ipv4.tcp_migrate_req</span> reads
          <span class="mono">${selfSwap.migrateReq}</span>`,
        trail: badge(selfSwap.blocked === null ? "ready" : "blocked", {
          tone: selfSwap.blocked === null ? "success" : "attn",
        }),
      })}
    </ul>`,
  );
  // The settings first: they are what this page is for; what happened follows.
  const body = html`<p class="muted small mb">
      How much the forge does at once. A change takes effect on the next crew
      run, check or app start — running work is left to finish — and never
      needs a restart.
    </p>
    ${when(
      reported,
      () => html`<p class="muted small mb" id="egress-reported">
        Egress is reported, not enforced: every new app,
        preview, terminal and check cell may reach any public host on ports
        80 and 443, declared or not. Private, loopback and cluster addresses,
        and every other port, stay refused. Set it back to enforce once each
        app's reported hosts are in its forge.json.
      </p>`,
    )}
    ${block("Capacity", html`<ul class="list setting-list">${rows}</ul>`)}
    ${block(
      "Changes",
      history.length === 0
        ? html`<p class="muted small">No change yet.</p>`
        : html`<ul class="list">${history}</ul>`,
    )}
    ${happened}${connections}${swap}`;
  const response = usageShell(ctx, "capacity", body);
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

const ERRORS: Record<string, string> = {
  no_such_setting: "There is no such setting.",
  derived: DERIVED_WORDS,
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
  if (field(form, "dry") === "1") {
    const dry = edgeOffDryRun(ctx.app.db, ctx.auth.user);
    if (!dry.ok) return notFoundPage(ctx);
    const d = dry.value;
    const names = d.lockedOut.map((a) => a.username + (a.isAdmin ? " (admin)" : "")).join(", ");
    return flashTo(ctx, "/settings/capacity", {
      tone: d.lockedOut.length === 0 && d.allowed ? "success" : "danger",
      message: `${d.own} of ${d.total} accounts sign in without the edge. ${
        d.lockedOut.length === 0 ? "Nobody would be locked out." : `Would be locked out: ${names}.`
      }${d.youLockedOut ? " You would be too, so the switch is refused until you add a passkey." : ""}`,
    });
  }
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
