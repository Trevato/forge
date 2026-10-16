/**
 * Failure domains, for a forge admin: each failure domain (`kernel/domains.ts`),
 * what breaks, the words the forge says, and its last drill with the verdict
 * — or the sentence on why it is not drilled (`actions/resilience.ts`).
 */

import { listResilience, type ResilienceRow } from "../../actions/resilience.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { card, icon, row, time } from "../ui.ts";
import { accountSections } from "./origins.ts";

function drilled(d: ResilienceRow): Html {
  if (d.drill.name === null)
    return html`<span class="muted small">Not drilled: ${d.drill.why}</span>`;
  const last = d.drill.last;
  if (last === null)
    return html`<span class="muted small">${d.drill.name}: never run.</span>`;
  return html`<span class="small"
    >${d.drill.name}: ${time(last.at)} ·
    <strong class="${last.green ? "ok" : "bad"}"
      >${last.green ? "green" : "red"}</strong
    >
    — ${last.why} · back in ${String(last.backSeconds)}s (budget
    ${String(d.backMinutes)} min)</span
  >`;
}

// GET /settings/resilience (named "Failure domains"; /resilience is THREATS.md)
export function domainsPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  const listed = listResilience(ctx.app, ctx.auth.user);
  if (!listed.ok) return notFoundPage(ctx);
  const rows = listed.value.map((d) => {
    const says =
      d.says.length === 0
        ? "Says nothing yet."
        : d.says.map((s) => `“${s}”`).join(" · ");
    return row({
      lead: icon("activity"),
      title: html`${d.name}`,
      meta: html`${d.breaks}<br />${says}<br />${drilled(d)}`,
    });
  });
  const body = card(
    html`<ul class="list" id="resilience-list">
      ${rows}
    </ul>`,
    {
      head: html`${icon("activity")}
        <h2>Failure domains</h2>`,
      pad: false,
    },
  );
  return page({
    ctx,
    title: "Failure domains",
    body: html`<div class="page-head"><h1>Failure domains</h1></div>
      ${settingsLayout(
        accountSections("resilience", { admin: true }),
        body,
        "Account settings",
      )}`,
  });
}
