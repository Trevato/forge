/**
 * Settings → Telemetry, for the owner: which named agents hold
 * `telemetry:read`, one switch each, and the reads they have made (#1789).
 */
import { setTelemetryGrant } from "../../actions/telemetry.ts";
import { grantable, recentReads } from "../../core/telemetry.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html } from "../html.ts";
import { flashTo } from "../layout.ts";
import { btn, icon, row, time } from "../ui.ts";
import { usageShell } from "./usage-tabs.ts";

function owner(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  return ctx.auth.user.isAdmin && ctx.auth.user.kind !== "agent" ? undefined : notFoundPage(ctx);
}

// GET /settings/telemetry
export function telemetryPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const denied = owner(ctx);
  if (denied) return denied;
  const agents = timePhase(ctx.request, "agents", () => grantable(ctx.app.db));
  const reads = timePhase(ctx.request, "reads", () => recentReads(ctx.app.db));
  const rendering = performance.now();
  const body = html`<section class="settings-block">
      <h2>Telemetry grants</h2>
      <p class="muted small">
        A granted agent reads <a href="/boards">Boards</a>, <a href="/system">System</a> and the
        boards' sources through the API and MCP — counts and rates, with
        private repositories and sealed values cut out. Revoke at any time;
        every read is listed below.
      </p>
      ${agents.length === 0
        ? html`<p class="small">No agent accounts yet.</p>`
        : html`<ul class="list setting-list">
            ${agents.map((a) =>
              row({
                lead: icon("bot"),
                title: html`${a.username} <span class="muted small mono">telemetry:read</span>`,
                meta: html`${a.granted ? "Granted" : "Not granted"}`,
                trail: html`<form class="row-fields" method="post" action="/settings/telemetry">
                  <input type="hidden" name="agent" value="${a.username}" />
                  <input type="hidden" name="on" value="${a.granted ? "0" : "1"}" />
                  ${btn(a.granted ? "Revoke" : "Grant", {
                    size: "sm",
                    variant: a.granted ? "outline" : "primary",
                    label: `${a.granted ? "Revoke" : "Grant"} telemetry:read for ${a.username}`,
                  })}
                </form>`,
              }),
            )}
          </ul>`}
    </section>
    <section class="settings-block">
      <h2>Reads</h2>
      ${reads.length === 0
        ? html`<p class="small">No agent has read anything yet.</p>`
        : html`<ul class="list">${reads.map((r) =>
            row({ lead: icon("history"), title: html`${r.username} <span class="mono">${r.what}</span>`, meta: time(r.at) }),
          )}</ul>`}
    </section>`;
  const response = usageShell(ctx, "telemetry", body);
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /settings/telemetry
export async function telemetrySet(ctx: Ctx): Promise<Response> {
  const denied = owner(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const changed = setTelemetryGrant(ctx.app, ctx.auth.user, field(form, "agent"), field(form, "on") === "1");
  return flashTo(
    ctx,
    "/settings/telemetry",
    changed.ok
      ? { message: `${changed.value.username} ${changed.value.on ? "may now read" : "no longer reads"} telemetry.` }
      : { tone: "danger", message: "Only an agent account can be granted telemetry:read." },
  );
}
