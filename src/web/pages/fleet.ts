/**
 * `GET /fleet?q=<query line>&sort=<column>`: the rows a fleet operation's
 * query line selects, as a table, so an operator sees them before acting.
 * The grammar and the visibility rule are `fleet/selection.ts`'s; a line
 * that does not parse shows its error beside the query line. The terminal
 * door is `tui/screens/fleet.ts`.
 */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { readSort } from "../../fleet/columns.ts";
import { viewFleet, type FleetView } from "../../fleet/rows.ts";
import { fieldsOf, GRAMMAR, GRAMMAR_EXAMPLES, FLEET_KINDS, MAX_ROWS } from "../../fleet/selection.ts";
import type { Ctx } from "../../http/context.ts";
import { fleetTable } from "../fleet-table.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { btn, field } from "../ui.ts";

/** GET /fleet */
export function fleetPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const q = (ctx.url.searchParams.get("q") ?? "").slice(0, 2000);
  const view: FleetView | undefined =
    q.trim() === "" ? undefined : viewFleet(ctx.app.db, ctx.auth.user, q);
  const rendering = performance.now();
  const shown = view?.ok ? view : undefined;
  const sort = shown && readSort(shown.kind, ctx.url.searchParams.get("sort"));
  const response = page({
    ctx,
    title: "Fleet",
    description: "The rows a fleet query line selects, before anything acts on them.",
    wide: true,
    body: html`<div class="page-head">
        <h1>Fleet</h1>
        <p class="muted">
          The rows a query line selects, at most ${MAX_ROWS}, before anything acts on them.
        </p>
      </div>
      <form method="get" action="/fleet" class="field-row mb">
        ${field({
          label: "Query",
          name: "q",
          id: "fleet-q",
          value: q,
          placeholder: "repo autonomy:autonomous",
          autocomplete: "off",
          mono: true,
          spellcheck: false,
          ...(view === undefined || view.ok ? {} : { error: view.error }),
        })}
        ${btn("Select", { type: "submit", variant: "secondary" })}
      </form>
      <div class="muted small mb" data-grammar>
        <p>${GRAMMAR} For example, ${GRAMMAR_EXAMPLES.map(
          (e, i) => html`${i === 0 ? "" : " or "}<code>${e}</code>`,
        )}.</p>
        <dl class="status-rows">
          ${FLEET_KINDS.map(
            (kind) =>
              html`<div class="status-row"><dt class="mono">${kind}</dt><dd>${fieldsOf(kind).join(", ")}</dd></div>`,
          )}
        </dl>
      </div>
      ${shown === undefined
        ? null
        : html`<p class="muted" data-count="${shown.rows.length}">
              ${shown.rows.length} ${shown.rows.length === 1 ? "row" : "rows"}
            </p>
            ${shown.rows.length === 0 ? null : fleetTable(shown.kind, q, shown.rows, sort)}`}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
