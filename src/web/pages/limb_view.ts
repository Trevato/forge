/**
 * The parts the milestone and limb pages share, drawn from the §5
 * components: an issue as a row, and a list that folds its tail. No styling of their own.
 */

import { html, type Html } from "../html.ts";
import { row } from "../ui.ts";

/** An issue as a row: its title, its number, and whatever is known of it. */
export function issueRow(
  base: string,
  issue: { number: number; title: string },
  meta?: Html,
  trail?: Html,
): Html {
  return row({
    title: html`<a href="${base}/issues/${issue.number}">${issue.title}</a>
      <span class="muted small">#${issue.number}</span>`,
    ...(meta === undefined ? {} : { meta }),
    ...(trail === undefined ? {} : { trail }),
  });
}

/** A list of rows; `wrap` lets title and meta wrap instead of ellipsizing (§5d settings rows). */
export const list = (rows: Html[], wrap = false): Html =>
  html`<ul class="list${wrap ? " setting-list" : ""}">${rows}</ul>`;

/** Wrapping rows under a heading: no box around them. */
export const wrappedRows = (rows: Html[]): Html => list(rows, true);

/** Wrapping rows that show the first `shown` and fold the rest: a long title wraps on a phone rather than running past its edge. */
export function folded(rows: Html[], what: string, shown: number): Html {
  if (rows.length <= shown) return wrappedRows(rows);
  return html`${list(rows.slice(0, shown), true)}
    <details>
      <summary class="small muted">${rows.length - shown} more ${what}</summary>
      ${list(rows.slice(shown), true)}
    </details>`;
}
