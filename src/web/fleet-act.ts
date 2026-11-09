/**
 * The write side of `/fleet`, as HTML: the verb form under the table, the
 * preview of what applying would do, and the receipt with Undo. Pure: plans
 * and operations in, HTML out. The writes are `actions/fleet.ts`'s.
 */

import type { FleetValue, Operation } from "../core/fleet_ops.ts";
import type { Plan } from "../actions/fleet.ts";
import { UNDO_WINDOW_MS } from "../actions/fleet.ts";
import { digestOf } from "../fleet/digest.ts";
import { VERBS } from "../fleet/verbs.ts";
import type { FleetKind } from "../fleet/selection.ts";
import { html, type Html } from "./html.ts";
import { btn, field, selectField } from "./ui.ts";

/** A value in words. */
export const valueWords = (value: FleetValue): string =>
  value === null
    ? "nothing"
    : Array.isArray(value)
      ? value.length === 0
        ? "none"
        : value.join(", ")
      : String(value);

/** The verbs a kind takes, by name. */
export const verbsOf = (kind: FleetKind): string[] =>
  Object.keys(VERBS).filter((v) => VERBS[v]!.kind === kind);

/** The form that asks for a verb and its value; posts to the preview. */
export function actForm(kind: FleetKind, q: string, chosen = "", value = ""): Html {
  return html`<form method="post" action="/fleet" class="field-row mb" data-act>
    <input type="hidden" name="q" value="${q}" />
    <input type="hidden" name="step" value="preview" />
    ${selectField({
      label: "Verb",
      name: "verb",
      id: "fleet-verb",
      options: verbsOf(kind).map((v) => ({ value: v, label: v, selected: v === chosen })),
    })}
    ${field({
      label: "Value",
      name: "value",
      id: "fleet-value",
      value,
      autocomplete: "off",
      mono: true,
      spellcheck: false,
      hint: "Some verbs take none.",
    })}
    ${btn("Preview", { type: "submit", variant: "secondary" })}
  </form>`;
}

const outcomeWords: Record<string, string> = {
  change: "will change",
  unchanged: "unchanged",
  refused: "refused",
  ok: "changed",
  failed: "failed",
};

interface Line {
  label: string;
  before: FleetValue;
  after: FleetValue;
  outcome: string;
  reason: string;
}

function lines(rows: readonly Line[]): Html {
  return html`<ul class="list" data-fleet-op>${rows.map(
    (r) => html`<li data-outcome="${r.outcome}">
      <span>${r.label}</span>
      <span class="mono">${valueWords(r.before)} → ${valueWords(r.after)}</span>
      <span class="muted">${outcomeWords[r.outcome] ?? r.outcome}${r.reason === "" ? null : ` — ${r.reason}`}</span>
    </li>`,
  )}</ul>`;
}

/** The dry run: each row's change, and one button to apply it. Nothing is written yet. */
export function previewSection(plan: Plan, rawValue: string): Html {
  const { change } = plan.counts;
  return html`<section data-preview>
    <h2>Preview: ${plan.verb}</h2>
    <p class="muted">Nothing is written until you apply.</p>
    ${lines(plan.rows)}
    ${change === 0
      ? html`<p class="muted">Nothing to apply.</p>`
      : html`<form method="post" action="/fleet" class="form-actions">
          <input type="hidden" name="q" value="${plan.query}" />
          <input type="hidden" name="step" value="apply" />
          <input type="hidden" name="verb" value="${plan.verb}" />
          <input type="hidden" name="value" value="${rawValue}" />
          <input type="hidden" name="digest" value="${digestOf(plan.rows)}" />
          ${btn(`Apply to ${change} ${change === 1 ? "row" : "rows"}`, { type: "submit" })}
        </form>`}
  </section>`;
}

/** Whether an Undo is still offered for a receipt. */
export const undoable = (op: Operation, now = Date.now()): boolean =>
  op.reversible &&
  op.undoOf === null &&
  op.undoneBy === null &&
  op.rows.some((r) => r.outcome === "ok") &&
  now - Date.parse(op.createdAt) <= UNDO_WINDOW_MS;

/** The result of an operation, with Undo while it can be undone. */
export function receiptSection(op: Operation, canUndo: boolean): Html {
  return html`<section data-receipt="${op.id}">
    <h2>${op.undoOf === null ? "Applied" : "Undone"}: ${op.verb}</h2>
    ${op.undoneBy === null ? null : html`<p class="muted">This was undone.</p>`}
    ${lines(op.rows)}
    ${canUndo
      ? html`<form method="post" action="/fleet/ops/${op.id}/undo" class="form-actions">
          ${btn("Undo", { type: "submit", variant: "outline" })}
        </form>`
      : null}
  </section>`;
}
