/**
 * The knobs card on the crew page (#10461): one row per knob with its name,
 * what it does, its value, its live effect and the control right there. A
 * change posts to `knobSet`, which turns it through `actions/knobs.ts` and
 * leaves the event the setting's own page leaves.
 */

import { setKnob } from "../../actions/knobs.ts";
import { derivedLine, readKnobs, type KnobRow } from "../../crew/knobs.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo } from "../layout.ts";
import { btn } from "../ui.ts";

function control(r: KnobRow): Html {
  if (r.control === "fixed") return html`<span class="badge">${r.value}</span>`;
  if (r.control === "derived") return html`<span class="mono" data-derived="${r.id}" title="Read-only: ${r.follows} sets it">${r.value}${r.unit ?? ""}</span>`;
  const label = `${r.name}${r.repo === undefined ? "" : ` for ${r.repo}`}`;
  const input =
    r.control === "words"
      ? html`<select class="input" name="value" aria-label="${label}">${(r.words ?? []).map(
          (w) => html`<option value="${w}" ${w === r.value ? "selected" : ""}>${w}</option>`,
        )}</select>`
      : html`<input class="input input-num mono" type="number" name="value" value="${r.value}" min="${r.min ?? 0}" max="${r.max ?? 100}" aria-label="${label}">${r.control === "percent" ? html` %` : html``}`;
  return html`<form method="post" action="/settings/crew/knobs" class="status-act">
    <input type="hidden" name="knob" value="${r.id}">
    <input type="hidden" name="repo" value="${r.repo ?? ""}">
    ${input} ${btn("Set", { variant: "ghost", size: "sm" })}
  </form>`;
}

/** The knobs: one row each, name, live effect, the control in place. */
export function knobsCard(ctx: Ctx): Html {
  const rows = readKnobs(ctx.app);
  return html`<section id="knobs">
    <h2 class="mb">Knobs</h2>
    <p class="muted small">Dials for the crew; a change applies on the next pump.</p>
    <dl class="status-rows">
      ${rows.map(
        (r) => html`<div class="status-row" data-knob="${r.id}">
          <dt title="${r.does}">${r.name}${r.repo === undefined ? html`` : html` <span class="mono muted">${r.repo}</span>`}</dt>
          <dd>${r.effect}</dd>
          ${control(r)}
        </div>`,
      )}
    </dl>
  </section>`;
}

// POST /settings/crew/knobs
export async function knobSet(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const knob = field(form, "knob");
  const set = await setKnob(ctx.app, ctx.auth.user, knob, field(form, "value"), field(form, "repo"));
  if (!set.ok && set.error === "not_found") return notFoundPage(ctx);
  return flashTo(
    ctx,
    "/settings/crew",
    set.ok
      ? { message: `${knob}: ${set.value.value}, from the next pump on.` }
      : {
          tone: "danger",
          message: set.error === "derived" ? derivedLine(knob) : "That value is outside what this knob takes.",
        },
  );
}
