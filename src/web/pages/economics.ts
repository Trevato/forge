/**
 * Settings → Economics, for a forge admin who is a person: the profit
 * slider's position (0 cheapest, 100 most responsive) with the policy it
 * means in words beside it, and the margin on crew spend (docs/PROFIT.md).
 * Beside them, where work runs: owned metal first, selected by the owned-node
 * label set here, and whether a cloud body takes bursts — without one the
 * page says "no cloud body: bursts queue" (#509).
 * Server-rendered; the form is a same-origin POST (`readForm`). 50 is today's
 * behaviour.
 * Anyone else gets the not-found page.
 */

import { ECONOMICS_WORDS, changeEconomics, readEconomics } from "../../actions/economics.ts";
import { MARGIN_MAX, POSITION_MAX, POSITION_MIN } from "../../core/slider.ts";
import { OWNED_NODE_LABEL_DEFAULT } from "../../core/placement_policy.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, icon, row, time } from "../ui.ts";
import { accountSections } from "./origins.ts";

const PATH = "/settings/economics";

// GET /settings/economics
export function economicsPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  if (!ctx.auth.user) return signInFirst(ctx);
  const read = timePhase(ctx.request, "economics", () => readEconomics(ctx.app, ctx.auth.user));
  if (!read.ok) return notFoundPage(ctx);
  const rendering = performance.now();
  const e = read.value;
  const history = e.changes.map((c) =>
    row({
      lead: icon("history"),
      title: html`<span class="mono">${c.key}</span> <span class="mono">${c.from}</span> →
        <span class="mono">${c.to}</span>`,
      meta: html`${c.actorName === "" ? "someone" : c.actorName} · ${time(c.at)}`,
    }),
  );
  const body = html`<section class="settings-block">
      <h2>Profit slider</h2>
      <p class="muted small">One number for the whole forge, from 0 (cheapest) to 100 (most responsive).</p>
      <form class="row-fields" method="post" action="${PATH}">
        <label class="small"
          >Position
          <input
            class="input"
            type="range"
            name="position"
            min="${String(POSITION_MIN)}"
            max="${String(POSITION_MAX)}"
            step="1"
            value="${String(e.position)}"
            aria-label="Profit slider position: 0 cheapest, 100 most responsive"
        /></label>
        <span class="mono">${String(e.position)}</span>
        <label class="small"
          >Margin on crew spend (%)
          <input
            class="input mono"
            type="number"
            name="marginPct"
            min="0"
            max="${String(MARGIN_MAX)}"
            step="1"
            value="${String(e.marginPct)}"
        /></label>
        <label class="small"
          >Owned-node label
          <input
            class="input mono"
            type="text"
            name="ownedNodeLabel"
            maxlength="400"
            spellcheck="false"
            autocomplete="off"
            placeholder="${OWNED_NODE_LABEL_DEFAULT}"
            aria-describedby="owned-label-hint"
            value="${e.placement.ownedNodeLabel}"
        /></label>
        ${btn("Save", { size: "sm", variant: "primary", label: "Save economics" })}
      </form>
      <p class="muted small" id="owned-label-hint">The owned-node label selects owned metal; blank is the default, ${OWNED_NODE_LABEL_DEFAULT}.</p>
      <p data-policy>${e.words}.</p>
      <p data-placement>${e.placement.words}.</p>
    </section>
    <section class="settings-block">
      <h2>Changes</h2>
      ${history.length === 0
        ? html`<p class="muted">No change yet.</p>`
        : html`<ul class="list setting-list">
            ${history}
          </ul>`}
    </section>`;
  const response = page({
    ctx,
    title: "Economics",
    body: html`<div class="page-head"><h1>Economics</h1></div>
      ${settingsLayout(accountSections("economics", { admin: true }), body, "Account settings")}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /settings/economics
export async function economicsSet(ctx: Ctx): Promise<Response> {
  // Checked before the body is read: a non-admin learns nothing of the door.
  if (ctx.auth.user?.isAdmin !== true || ctx.auth.user.kind === "agent") return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const changed = changeEconomics(ctx.app, ctx.auth.user, {
    position: field(form, "position"),
    marginPct: field(form, "marginPct"),
    // A form without the field keeps the label; the field left blank is the default again.
    ownedNodeLabel: form.get("ownedNodeLabel") === null ? undefined : field(form, "ownedNodeLabel"),
  });
  if (!changed.ok && changed.error === "not_found") return notFoundPage(ctx);
  return flashTo(
    ctx,
    PATH,
    changed.ok
      ? { message: `Saved: position ${changed.value.position}, margin ${changed.value.marginPct}%.` }
      : { tone: "danger", message: `${ECONOMICS_WORDS[changed.error as keyof typeof ECONOMICS_WORDS]}.` },
  );
}
