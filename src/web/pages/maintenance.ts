/**
 * /maintenance: an admin's page to prepare the forge for a power-off and to
 * end it. It says plainly what stops, what the drain still waits for, and,
 * once the forge is back, when and what was verified.
 */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { ABOUT_TO_STOP_ROWS, prepare, resumeNow, status } from "../../maintenance/service.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { field as formField, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, field } from "../ui.ts";

function admin(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  return undefined;
}

/** One fact of the page: what it is and how it stands, as a `dl` row. */
const fact = (label: string, value: Html | string): Html => html`<div class="status-row"><dt>${label}</dt><dd>${value}</dd></div>`;

export function maintenancePage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const denied = admin(ctx);
  if (denied) return denied;
  const rendering = performance.now();
  const s = status(ctx.app);
  const body = html`<div class="page-head"><h1>Maintenance</h1></div>
    <p id="maintenance-says">${s.says}</p>
    ${s.phase === "idle"
      ? html`<p class="muted">Get the forge ready for a planned power-off. What stops:</p>
          <dl class="status-rows">${ABOUT_TO_STOP_ROWS.map((r) => fact(r.what, r.stops))}</dl>
          <form method="post" action="/maintenance/prepare" class="stack">
            ${field({ name: "reason", label: "Shown to visitors (optional)", maxlength: 200, autocomplete: "off" })}
            ${field({ name: "confirm", type: "checkbox", value: "yes", required: true, label: "I understand the crew and releases stop now" })}
            <div class="form-actions">${btn("Prepare for maintenance", { variant: "danger" })}</div>
          </form>
          ${s.last ? html`<p id="maintenance-last" class="muted">${s.last.says}</p>` : null}`
      : html`<dl class="status-rows">
            ${fact("Since", s.since ?? "")} ${s.reason ? fact("Reason", s.reason) : null}
            ${fact("Backup", s.backup?.says ?? "")} ${fact("Still working", String(s.working))}
          </dl>
          <div class="form-actions">
            <form method="post" action="/maintenance/prepare">${btn("Check again and retake the backup", { variant: "outline" })}</form>
            <form method="post" action="/maintenance/resume">${btn("End maintenance now")}</form>
          </div>`}`;
  const response = page({ ctx, title: "Maintenance", body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

export async function maintenancePrepare(ctx: Ctx): Promise<Response> {
  const denied = admin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  // Idle -> prepared stops the crew: asked first. A re-check while prepared has already been agreed.
  if (status(ctx.app).phase === "idle" && formField(form, "confirm") !== "yes")
    return flashTo(ctx, "/maintenance", { tone: "danger", message: "Tick the box to confirm: the crew and releases stop." });
  const r = await prepare(ctx.app, ctx.auth.user, formField(form, "reason"));
  return flashTo(ctx, "/maintenance", r.ok ? { message: r.value.says } : { tone: "danger", message: r.error.says });
}

export async function maintenanceResume(ctx: Ctx): Promise<Response> {
  const denied = admin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const r = resumeNow(ctx.app, ctx.auth.user);
  return flashTo(ctx, "/maintenance", r.ok ? { message: r.value.says } : { tone: "danger", message: r.error.says });
}
