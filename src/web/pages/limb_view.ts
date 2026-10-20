/**
 * The parts the milestone and limb pages share, drawn from the §5
 * components: an issue as a row, and a list that folds its tail. No styling of their own.
 */

import { html, type Html } from "../html.ts";
import { card, row } from "../ui.ts";

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

/** A card of rows, wrapping. */
export const wrappedCard = (rows: Html[]): Html =>
  card(list(rows, true), { pad: false });

/** A card of rows that shows its first `shown` and folds the rest. */
export function folded(rows: Html[], what: string, shown: number): Html {
  if (rows.length <= shown) return card(list(rows), { pad: false });
  return card(list(rows.slice(0, shown)), {
    pad: false,
    foot: html`<details>
      <summary class="small">${rows.length - shown} more ${what}</summary>
      ${list(rows.slice(shown))}
    </details>`,
  });
}
