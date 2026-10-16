/**
 * Settings → Telemetry, for the owner: which named agents hold
 * `telemetry:read`, one switch each, and the reads they have made (#1789).
 */
import { setTelemetryGrant } from "../../actions/telemetry.ts";
import { grantable, recentReads } from "../../core/telemetry.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, card, icon, row, time } from "../ui.ts";
import { accountSections } from "./origins.ts";

function owner(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  return ctx.auth.user.isAdmin && ctx.auth.user.kind !== "agent" ? undefined : notFoundPage(ctx);
}

// GET /settings/telemetry
export function telemetryPage(ctx: Ctx): Response {
  const denied = owner(ctx);
  if (denied) return denied;
  const agents = grantable(ctx.app.db);
  const reads = recentReads(ctx.app.db);
  const body = html`${card(
      html`<div class="card-body"><p class="muted small">
        A granted agent reads <a href="/flow">Flow</a>, <a href="/system">System</a> and the
        boards' sources through the API and MCP — counts and rates, with
        private repositories and sealed values cut out. Revoke at any time;
        every read is listed below.
      </p></div>
      <ul class="list">
        ${agents.length === 0
          ? html`<li class="muted small">No agent accounts yet.</li>`
          : agents.map((a) =>
              row({
                lead: icon("bot"),
                title: html`${a.username} <span class="muted small mono">telemetry:read</span>`,
                meta: html`${a.granted ? "Granted" : "Not granted"}`,
                trail: html`<form class="row-actions" method="post" action="/settings/telemetry">
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
      </ul>`,
      { head: html`${icon("activity")}<h2>Telemetry grants</h2>`, pad: false },
    )}
    ${card(
      reads.length === 0
        ? html`<div class="card-body"><p class="muted small">No agent has read anything yet.</p></div>`
        : html`<ul class="list">${reads.map((r) =>
            row({ lead: icon("history"), title: html`${r.username} <span class="mono">${r.what}</span>`, meta: time(r.at) }),
          )}</ul>`,
      { head: html`${icon("history")}<h2>Reads</h2>`, pad: false },
    )}`;
  return page({
    ctx,
    title: "Telemetry",
    body: html`<div class="page-head"><h1>Telemetry</h1></div>
      ${settingsLayout(accountSections("telemetry", { admin: true }), body, "Account settings")}`,
  });
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
