/**
 * The fleet table on the web: the rows a query line selected, in the
 * columns `fleet/columns.ts` names, sortable by one column through `?sort=`
 * links. Pure: rows in, HTML out — every cell goes through `html`, which
 * escapes it.
 */

import {
  cellText,
  COLUMNS,
  sortRows,
  sortText,
  type Column,
  type Sort,
} from "../fleet/columns.ts";
import type { FleetRow } from "../fleet/rows.ts";
import type { FleetKind } from "../fleet/selection.ts";
import { html, type Html } from "./html.ts";

/** Where a cell leads, if anywhere. */
function href(column: Column, row: FleetRow): string | undefined {
  if (column.key === "repo") return `/${row.repo}`;
  if (column.key === "number") return `/${row.repo}/issues/${row.number}`;
  return undefined;
}

function cell(column: Column, row: FleetRow): Html | string {
  const text = cellText(column, row);
  if (text === "") return html`<span class="muted">—</span>`;
  const to = href(column, row);
  return to === undefined ? text : html`<a href="${to}">${text}</a>`;
}

/** The act form a row's box belongs to (`form="…"`): forms do not nest. */
export const ACT_FORM = "fleet-act";

/** A row's box: ticked rows narrow what the act form acts on. */
const pickBox = (row: FleetRow, picked: ReadonlySet<string>): Html =>
  html`<td><label class="check"><input
    type="checkbox"
    name="pick"
    value="${String(row.id)}"
    form="${ACT_FORM}"
    ${picked.has(String(row.id)) ? html`checked` : null}
    aria-label="Pick ${String(row.repo)}${row.number === undefined ? "" : ` #${row.number}`}"
  /></label></td>`;

/**
 * The table for `rows` of `kind`, its headers linking to `?q=…&sort=…`.
 * The sorted column's link flips its direction. With `picked`, each row
 * leads with a box that belongs to the act form.
 */
export function fleetTable(
  kind: FleetKind,
  query: string,
  rows: readonly FleetRow[],
  sort: Sort | undefined,
  picked?: ReadonlySet<string>,
): Html {
  const columns = COLUMNS[kind];
  const sorted = sortRows(rows, sort);
  const head = (c: Column): Html => {
    const on = sort?.key === c.key;
    const next = sortText({ key: c.key, descending: on && !sort.descending });
    const to = `/fleet?${new URLSearchParams({ q: query, sort: next }).toString()}`;
    return html`<th scope="col"${c.num ? html` class="num"` : ""}${
      on ? html` aria-sort="${sort.descending ? "descending" : "ascending"}"` : ""
    }><a href="${to}">${c.label}</a></th>`;
  };
  return html`<div class="table-scroll">
    <table class="table" data-dense>
      <caption class="sr-only">The ${kind} rows the query selects</caption>
      <thead><tr>${picked === undefined ? null : html`<th scope="col"><span class="sr-only">Pick</span></th>`}${columns.map(head)}</tr></thead>
      <tbody>
        ${sorted.map(
          (row) =>
            html`<tr>${picked === undefined ? null : pickBox(row, picked)}${columns.map(
              (c) => html`<td${c.num ? html` class="num"` : ""}>${cell(c, row)}</td>`,
            )}</tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}
