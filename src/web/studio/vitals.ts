/**
 * The web-vitals table of a check's run page: `vitalsRows`' plain words
 * (src/checks/summary.ts) as escaped HTML. Report-only, and nothing when no
 * look recorded anything.
 */

import { sidewaysLine, vitalsRows, type LookVitals } from "../../checks/summary.ts";
import { html, type Html } from "../html.ts";

export function vitalsTable(looks: readonly LookVitals[]): Html {
  const groups = vitalsRows(looks);
  if (groups.length === 0) return html``;
  const sideways = sidewaysLine(groups);
  return html`<div class="table-scroll" tabindex="0" role="region" aria-label="Web vitals per look">
    <table class="table" data-dense>
      <thead><tr><th>Look</th><th>Vital</th><th>Value</th><th>Thresholds</th><th>Grade</th><th class="num">Screens</th></tr></thead>
      <tbody>
        ${groups.map((g) =>
          g.skipped !== ""
            ? html`<tr><th scope="row">${g.look}</th><td colspan="5">skipped: ${g.skipped}</td></tr>`
            : g.rows.map(
                (r, i) => html`<tr>${i === 0 ? html`<th scope="row" rowspan="${g.rows.length}">${g.look}</th>` : ""}<td>${r.vital}</td><td>${r.value}</td><td>${r.thresholds}</td><td>${r.grade}</td>${i === 0 ? html`<td class="num" rowspan="${g.rows.length}">${g.screens}</td>` : ""}</tr>`,
              ),
        )}
      </tbody>
    </table>
  </div>${sideways === "" ? "" : html`<p class="muted small" data-sideways>${sideways}</p>`}`;
}
