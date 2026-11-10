/**
 * Devices, for the forge's owner: declare a LAN printer by name and IPP URL,
 * and see its model, state and supplies. A fine printer is one line (P9
 * Calm); a printer that cannot be reached is one plain line, never an error
 * page. The address was validated when it was declared (`core/devices.ts`);
 * the probe (`devices/ipp.ts`) is bounded and its answer is kept 30 s.
 */

import type { Ctx } from "../../http/context.ts";
import { DEVICE_ERRORS, declare, grant, revoke, devicesWithStatus, remove, statusLine } from "../../actions/devices.ts";
import { allAppSlugs, grantedSlugs } from "../../core/device_grants.ts";
import { NAME_MAX, URL_MAX, type Device } from "../../core/devices.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { PrinterReport } from "../../devices/ipp.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, row } from "../ui.ts";
import { accountSections } from "../pages/origins.ts";

function guard(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  return undefined;
}

function supplies(report: PrinterReport): Html | null {
  if (report.supplies.length === 0) return null;
  // A fine printer stays one line; the detail opens on demand.
  return html`<details class="small">
    <summary>Supplies</summary>
    <ul class="list">
      ${report.supplies.map(
        (s) => html`<li>${s.name}: ${s.percent === null ? "level unknown" : html`<span class="mono">${String(s.percent)}%</span>`}</li>`,
      )}
    </ul>
  </details>`;
}

/** Who may print here, as one fact: each granted app is a row with its revoke button, then a picker for one more. */
function access(ctx: Ctx, d: Device): Html {
  const granted = grantedSlugs(ctx.app.db, d.id);
  const rest = allAppSlugs(ctx.app.db).filter((s) => !granted.includes(s));
  if (granted.length === 0 && rest.length === 0) return html``;
  return html`<dl class="status-rows"><div class="status-row"><dt>Allowed apps</dt><dd>
    <ul class="list">${granted.map(
      (slug) => html`<li>${row({
        title: html`<span class="mono">${slug}</span>`,
        trail: html`<form class="row-actions" method="post" action="/settings/devices/revoke">
          <input type="hidden" name="id" value="${String(d.id)}" />
          <input type="hidden" name="app" value="${slug}" />
          ${btn("Revoke", { size: "sm", icon: "x", label: `Revoke ${slug} from ${d.name}` })}
        </form>`,
      })}</li>`,
    )}</ul>
    ${when(rest.length > 0, () => html`<form class="edit-row" method="post" action="/settings/devices/grant">
      <input type="hidden" name="id" value="${String(d.id)}" />
      <select class="input" name="app" aria-label="App to grant ${d.name}">
        ${rest.map((slug) => html`<option value="${slug}">${slug}</option>`)}
      </select>
      ${btn("Grant", { size: "sm", icon: "plus", label: `Grant an app ${d.name}` })}
    </form>`)}
  </dd></div></dl>`;
}

function card(ctx: Ctx, d: Device): Html {
  return html`<li>
    ${row({
      title: html`${d.name} <span class="muted small">printer</span>`,
      meta: html`${statusLine(d.probe)} · <span class="mono">${d.url}</span>`,
      trail: html`<form class="row-actions" method="post" action="/settings/devices/delete">
        <input type="hidden" name="id" value="${String(d.id)}" />
        ${btn("Remove", { size: "sm", icon: "x", label: `Remove ${d.name}` })}
      </form>`,
    })}
    ${d.probe ? supplies(d.probe) : null}
    ${access(ctx, d)}
  </li>`;
}

// GET /settings/devices
export async function devicesPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const denied = guard(ctx);
  if (denied) return denied;
  const devices = await devicesWithStatus(ctx.app);
  const rendering = performance.now();
  const response = page({
    ctx,
    title: "Devices",
    body: html`<div class="page-head"><h1>Devices</h1></div>
      ${settingsLayout(
        accountSections("devices", { admin: true }),
        html`<section class="settings-block">
          <p class="muted">Printers on your network, as the forge sees them; only addresses like 192.168.1.161 are accepted.</p>
          ${when(devices.length === 0, () => html`<p class="muted">No devices declared.</p>`)}
          ${when(devices.length > 0, () => html`<ul class="list setting-list">${devices.map((d) => card(ctx, d))}</ul>`)}
          <form class="edit-row mt" method="post" action="/settings/devices">
            <input type="hidden" name="kind" value="printer" />
            <input class="input" type="text" name="name" placeholder="Name" aria-label="Device name" maxlength="${String(NAME_MAX)}" required />
            <input class="input mono" type="text" name="url" placeholder="ipp://192.168.1.161:631/ipp/print" aria-label="IPP address" maxlength="${String(URL_MAX)}" autocomplete="off" spellcheck="false" required />
            ${btn("Declare", { variant: "primary", size: "sm", icon: "plus" })}
          </form>
        </section>`,
        "Account settings",
      )}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /settings/devices
export async function deviceDeclare(ctx: Ctx): Promise<Response> {
  const denied = guard(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const made = declare(ctx.app, ctx.auth.user, {
    name: field(form, "name"),
    kind: field(form, "kind"),
    url: field(form, "url"),
  });
  return flashTo(
    ctx,
    "/settings/devices",
    made.ok ? { message: `${made.value.name} is declared.` } : { tone: "danger", message: DEVICE_ERRORS[made.error] },
  );
}

// POST /settings/devices/delete
export async function deviceRemove(ctx: Ctx): Promise<Response> {
  const denied = guard(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const gone = remove(ctx.app, ctx.auth.user, Number(field(form, "id")));
  return flashTo(
    ctx,
    "/settings/devices",
    gone.ok ? { message: "Removed." } : { tone: "danger", message: DEVICE_ERRORS[gone.error] },
  );
}

// POST /settings/devices/grant and /settings/devices/revoke
async function grantChange(ctx: Ctx, change: typeof grant, done: string): Promise<Response> {
  const denied = guard(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const result = change(ctx.app, ctx.auth.user, Number(field(form, "id")), field(form, "app"));
  return flashTo(
    ctx,
    "/settings/devices",
    result.ok ? { message: `${result.value} ${done}.` } : { tone: "danger", message: DEVICE_ERRORS[result.error] },
  );
}

export const deviceGrant = (ctx: Ctx): Promise<Response> => grantChange(ctx, grant, "may print here now");
export const deviceRevoke = (ctx: Ctx): Promise<Response> => grantChange(ctx, revoke, "may no longer print here");
