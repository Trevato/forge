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
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { previewSection, receiptSection, undoable } from "../fleet-act.ts";
import { field, readForm } from "../form.ts";
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
  if (field(form, "step") === "apply") {
    const done = await applyPreviewed(ctx.app, ctx.auth.user, q, action, field(form, "digest").slice(0, 64));
    if (!done.ok) return refusal(ctx, q, verb, text, done.error.message);
    return flashTo(ctx, `/fleet/ops/${done.value.id}`, { message: "Applied." });
  }
  const plan = previewFleetOp(ctx.app, ctx.auth.user, q, action);
  if (!plan.ok) return refusal(ctx, q, verb, text, plan.error.message);
  return renderFleet(ctx, q, { html: previewSection(plan.value, text), verb, value: text });
}

function refusal(ctx: Ctx, q: string, verb: string, value: string, message: string): Response {
  return renderFleet(ctx, q, {
    html: html`<p class="muted" data-refused>${message}</p>`,
    verb,
    value,
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
