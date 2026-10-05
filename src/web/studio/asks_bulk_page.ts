/**
 * The page side of acting on many asks (`actions/asks_bulk.ts`): the
 * selection from `/asks` posts here and gets the preview — each ask, what
 * it is now and what it would be, and what is refused and why — with one
 * button to do it. Doing it answers with the receipt and, when the action
 * can be undone, an Undo. Every step is a plain form post.
 */

import {
  applyAsksBulk,
  isAsksOperation,
  previewAsksBulk,
  type Skipped,
} from "../../actions/asks_bulk.ts";
import {
  getFleetOp,
  undoFleetOp,
  type FleetError,
} from "../../actions/fleet.ts";
import type { FleetValue } from "../../core/fleet_ops.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { btn, listCard, row } from "../ui.ts";

const VERB_WORDS: Readonly<Record<string, string>> = {
  dismiss: "Dismiss",
  ship: "Ship",
  close: "Close",
  replan: "Hand back to the planner",
};

const shown = (v: FleetValue): string =>
  v === null ? "nobody" : Array.isArray(v) ? v.join(", ") : String(v);

interface RowView {
  readonly label: string;
  readonly before: FleetValue;
  readonly after: FleetValue;
  readonly outcome: string;
  readonly reason: string;
}

function rowsCard(rows: readonly RowView[], skipped: readonly Skipped[]): Html {
  const lines = [
    ...rows.map((r) =>
      row({
        title: r.label,
        meta: html`${shown(r.before)} →
        ${shown(r.after)}${r.reason === "" ? "" : ` · ${r.reason}`}`,
        trail: html`<span class="badge" data-outcome="${r.outcome}"
          >${r.outcome}</span
        >`,
      }),
    ),
    ...skipped.map((s) =>
      row({
        title: s.item,
        meta: html`${s.reason}`,
        trail: html`<span class="badge" data-outcome="skipped">skipped</span>`,
      }),
    ),
  ];
  return listCard(lines, { id: "asks-bulk-rows" });
}

function refusal(ctx: Ctx, error: FleetError): Response {
  if (error.code === "unauthorized") return signInFirst(ctx);
  if (error.code === "not_found") return notFoundPage(ctx);
  return page({
    ctx,
    title: "Nothing done",
    body: html`<h1>Nothing done</h1>
      <p>${error.message}.</p>
      ${btn("Back to what needs you", { href: "/asks" })}`,
  });
}

/** POST /asks/bulk — the preview, or with `apply` the deed and its receipt. */
export async function asksBulkSubmit(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const action = field(form, "action");
  const items = form
    .getAll("item")
    .filter((i): i is string => typeof i === "string");
  if (items.length === 0)
    return refusal(ctx, {
      code: "bad_action",
      message: "Select at least one ask first",
    });
  const verb = VERB_WORDS[action] ?? action;
  if (field(form, "apply") !== "1") {
    const plan = previewAsksBulk(ctx.app, ctx.auth.user, action, items);
    if (!plan.ok) return refusal(ctx, plan.error);
    const p = plan.value;
    const body = html`<h1 id="asks-bulk-title">
        ${verb}: ${p.counts.change} of ${items.length}
      </h1>
      <p class="muted">
        ${p.counts.change} will change, ${p.counts.unchanged} already are,
        ${p.counts.refused + p.skipped.length} refused or skipped.
        ${p.reversible
          ? "You can undo it afterwards."
          : "This is not undone afterwards."}
      </p>
      ${rowsCard(p.rows, p.skipped)}
      <form method="post" action="/asks/bulk" class="bar mt">
        <input type="hidden" name="action" value="${action}" />
        <input type="hidden" name="apply" value="1" />
        ${items.map(
          (i) => html`<input type="hidden" name="item" value="${i}" />`,
        )}
        ${p.counts.change > 0
          ? btn(`${verb} ${p.counts.change}`, {
              size: "sm",
              variant: "primary",
            })
          : null}
        ${btn("Back", { href: "/asks", size: "sm" })}
      </form>`;
    return page({ ctx, title: `${verb}: preview`, body });
  }
  const op = await applyAsksBulk(ctx.app, ctx.auth.user, action, items);
  if (!op.ok) return refusal(ctx, op.error);
  const done = op.value.rows.filter((r) => r.outcome === "ok").length;
  const undoable = op.value.reversible && done > 0;
  const body = html`<h1 id="asks-bulk-title">${verb}: ${done} done</h1>
    ${rowsCard(op.value.rows, op.value.skipped)}
    <div class="bar mt">
      ${undoable
        ? html`<form method="post" action="/asks/bulk/${op.value.id}/undo">
            ${btn("Undo", { size: "sm" })}
          </form>`
        : null}
      ${btn("Back to what needs you", {
        href: "/asks",
        size: "sm",
        variant: "primary",
      })}
    </div>`;
  return page({ ctx, title: `${verb}: done`, body });
}

/** POST /asks/bulk/:id/undo — reverse a bulk action on asks, once. */
export async function asksBulkUndo(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const found = getFleetOp(ctx.app, ctx.auth.user, ctx.params.id ?? "");
  if (!found.ok || !isAsksOperation(found.value)) return notFoundPage(ctx);
  const op = await undoFleetOp(ctx.app, ctx.auth.user, found.value.id);
  if (!op.ok) return refusal(ctx, op.error);
  const verb = VERB_WORDS[op.value.verb] ?? op.value.verb;
  const undone = op.value.rows.filter((r) => r.outcome === "ok").length;
  const body = html`<h1 id="asks-bulk-title">${verb} undone: ${undone}</h1>
    ${rowsCard(op.value.rows, [])}
    <div class="bar mt">
      ${btn("Back to what needs you", {
        href: "/asks",
        size: "sm",
        variant: "primary",
      })}
    </div>`;
  return page({ ctx, title: `${verb}: undone`, body });
}
