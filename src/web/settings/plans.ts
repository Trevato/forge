/**
 * The plans card on /admin/limits, for a forge admin: every plan's name,
 * words, size, price, crew credit and forge count as one form
 * (`settings/plans.ts`). POST /admin/plans saves it; the next spawn and
 * GET /api/v1/plans use it at once.
 */

import { editPlans, readPlans } from "../../actions/plans.ts";
import type { Ctx } from "../../http/context.ts";
import { SIZES } from "../../spawn/sizes.ts";
import { notFoundPage } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo } from "../layout.ts";
import { btn, row } from "../ui.ts";

const FIELDS = ["name", "says", "size", "priceUsd", "creditUsd", "forges"] as const;

export function plansRow(ctx: Ctx): Html {
  const rows = readPlans(ctx.app).map((p) =>
    row({
      title: p.key,
      facts: [
        { label: "Name", value: html`<input class="input" name="${p.key}.name" value="${p.name}" maxlength="40" aria-label="${p.key} name" />` },
        { label: "Words", value: html`<input class="input" name="${p.key}.says" value="${p.says}" maxlength="160" aria-label="${p.key} words" />` },
        {
          label: "Size",
          value: html`<select class="input mono" name="${p.key}.size" aria-label="${p.key} size">${Object.keys(SIZES).map((s) => html`<option value="${s}" ${p.size === s ? "selected" : ""}>${s}</option>`)}</select>`,
        },
        { label: "Price $/mo", value: html`<input class="input mono" name="${p.key}.priceUsd" inputmode="decimal" value="${String(p.priceUsd)}" ${p.key === "free" ? "readonly" : ""} aria-label="${p.key} price a month in dollars" />` },
        { label: "Crew credit $/mo", value: html`<input class="input mono" name="${p.key}.creditUsd" inputmode="decimal" value="${String(p.creditUsd)}" aria-label="${p.key} crew credit a month in dollars" />` },
        { label: "Forges", value: html`<input class="input mono" name="${p.key}.forges" type="number" min="1" max="1000" step="1" value="${String(p.forges)}" aria-label="${p.key} forges one person may hold" />` },
      ],
    }),
  );
  return html`<div class="status-row">
    <dt>Plans</dt>
    <dd>
      <form method="post" action="/admin/plans">
        <ul class="list">${rows}</ul>
        ${btn("Save", { size: "sm", variant: "primary", label: "Save plans" })}
      </form>
      <span class="muted small">The next spawn takes what is saved; until payment exists only a forge admin may take a paid plan.</span>
    </dd>
  </div>`;
}

// POST /admin/plans
export async function plansSet(ctx: Ctx): Promise<Response> {
  if (ctx.auth.user?.isAdmin !== true || ctx.auth.user.kind === "agent") return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const edits: Record<string, Record<string, unknown>> = {};
  for (const p of readPlans(ctx.app)) {
    const mine: Record<string, unknown> = {};
    for (const f of FIELDS) {
      const v = field(form, `${p.key}.${f}`);
      if (v !== "") mine[f] = v;
    }
    edits[p.key] = mine;
  }
  const changed = editPlans(ctx.app, ctx.auth.user, edits);
  if (!changed.ok && changed.error === "not_found") return notFoundPage(ctx);
  return flashTo(
    ctx,
    "/admin/limits",
    changed.ok ? { message: "Plans saved." } : { tone: "danger", message: `${typeof changed.error === "object" ? changed.error.invalid : "Plans were not saved"}.` },
  );
}
