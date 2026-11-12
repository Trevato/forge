/**
 * `/fleet` writes: `POST /fleet` previews (`step=preview`) or applies
 * (`step=apply`) one verb over the rows a query line selects,
 * `GET /fleet/ops/:id` is the receipt, `POST /fleet/ops/:id/undo` undoes it.
 * The operations are `actions/fleet.ts`'s; nothing here writes. Every POST
 * is same-origin (`readForm`), and only a signed-in person acts.
 */

import {
  applyPreviewed,
  getFleetOp,
  previewFleetOp,
  undoFleetOp,
} from "../../actions/fleet.ts";
import { actionOf } from "../../fleet/reading.ts";
import { viewFleet } from "../../fleet/rows.ts";
import { MAX_ROWS } from "../../fleet/selection.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { previewSection, receiptSection, undoable } from "../fleet-act.ts";
import { field, readForm, type Form } from "../form.ts";
import { html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { canAct, renderFleet } from "./fleet.ts";

/** POST /fleet */
export async function fleetAct(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!canAct(ctx)) return notFoundPage(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const q = field(form, "q").slice(0, 2000);
  const verb = field(form, "verb").slice(0, 40);
  const text = field(form, "value").slice(0, 2000);
  const action = actionOf(ctx.app, verb, text);
  const picked = picksOf(form);
  if (picked === undefined)
    return refusal(ctx, q, verb, text, `Pick at most ${MAX_ROWS} rows.`, []);
  if (field(form, "step") === "apply") {
    const done = await applyPreviewed(ctx.app, ctx.auth.user, q, action, field(form, "digest").slice(0, 64), picked);
    if (!done.ok) return refusal(ctx, q, verb, text, done.error.message, picked);
    return flashTo(ctx, `/fleet/ops/${done.value.id}`, { message: "Applied." });
  }
  const plan = previewFleetOp(ctx.app, ctx.auth.user, q, action, picked);
  if (!plan.ok) return refusal(ctx, q, verb, text, plan.error.message, picked);
  return renderFleet(ctx, q, {
    html: previewSection(plan.value, text, picked, matching(ctx, q)),
    verb,
    value: text,
    picked,
  });
}

const ID = /^[0-9A-Za-z_-]{1,64}$/;

/**
 * The ticked rows' ids, distinct, each shaped like an id; `undefined` when
 * there are more than a selection can hold. Whether each is in the
 * selection is `pickWithin`'s to decide, so nothing here widens it.
 */
export function picksOf(form: Form): string[] | undefined {
  const all = form.getAll("pick");
  if (all.length > MAX_ROWS) return undefined;
  const ids = new Set<string>();
  for (const v of all) if (typeof v === "string" && ID.test(v)) ids.add(v);
  return [...ids];
}

/** How many rows the query line selects for this viewer. */
const matching = (ctx: Ctx, q: string): number => {
  const view = viewFleet(ctx.app.db, ctx.auth.user, q);
  return view.ok ? view.rows.length : 0;
};

function refusal(
  ctx: Ctx,
  q: string,
  verb: string,
  value: string,
  message: string,
  picked: readonly string[],
): Response {
  return renderFleet(ctx, q, {
    html: html`<p class="muted" data-refused>${message}</p>`,
    verb,
    value,
    picked,
  });
}

/** GET /fleet/ops/:id */
export function fleetReceipt(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  const found = getFleetOp(ctx.app, ctx.auth.user, ctx.params.id ?? "");
  if (!found.ok) return notFoundPage(ctx);
  const op = found.value;
  return page({
    ctx,
    title: "Fleet result",
    wide: true,
    body: html`<div class="page-head"><h1>Fleet result</h1>
        <p class="muted"><code>${op.query}</code></p></div>
      ${receiptSection(op, canAct(ctx) && undoable(op))}
      <p><a href="/fleet?${new URLSearchParams({ q: op.query }).toString()}">Back to the rows</a></p>`,
  });
}

/** POST /fleet/ops/:id/undo */
export async function fleetUndo(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!canAct(ctx)) return notFoundPage(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const id = ctx.params.id ?? "";
  const undone = await undoFleetOp(ctx.app, ctx.auth.user, id);
  if (!undone.ok)
    return flashTo(ctx, `/fleet/ops/${encodeURIComponent(id)}`, {
      tone: "danger",
      message: undone.error.message,
    });
  return flashTo(ctx, `/fleet/ops/${undone.value.id}`, { message: "Undone." });
}
