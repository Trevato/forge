/**
 * Why ready issues wait, per autonomous repository: its ready list as one
 * table row with the count each filter holds (`flow/held.ts`). The flow panel
 * (`flow-panel.ts`), on `/boards` and `/flow`, draws it from here. A private
 * repository is in the rows for the owner only.
 */

import { HOLDS } from "../../crew/held.ts";
import type { HeldRow } from "../../flow/held.ts";
import { html, type Html } from "../html.ts";
import { meter } from "../ui.ts";

function heldCount(kind: string, n: number): Html {
  return html`<span data-held="${kind}"><span class="mono">${kind}=${String(n)}</span></span>`;
}

/** The startable share of the ready list; `attn` when none of it can start. */
function startableMeter(row: HeldRow): Html {
  const total = row.startable + HOLDS.reduce((n, h) => n + row.counts[h], 0);
  if (total === 0) return html`<span class="muted">—</span>`;
  return meter(
    (row.startable / total) * 100,
    `${row.startable} of ${total} ready can start`,
    row.startable === 0 ? "attn" : undefined,
  );
}

/** What the held card counts: said once, behind the page's `?` (#10998). */
export const HELD_EXPLAINED =
  "Each ready issue a builder could start, or the first filter that holds it: a run on it, an open pull, the planner, stalled, its run cap, parked twice, a red-main fix, a file 5 or more open pulls touch. When nothing can start and builders are free, the planner is asked to re-plan what is stalled or capped.";

/** Why ready issues cannot start, per autonomous repository (#2244). */
export function heldCard(rows: readonly HeldRow[]): Html {
  return html`<section class="settings-block" id="held">
      <h2>Ready, and why it waits</h2>
      ${rows.length === 0
        ? html`<p class="muted">No repository runs on its own.</p>`
        : html`<div class="table-scroll">
            <table class="table" aria-label="Ready, and why it waits">
              <thead>
                <tr>
                  <th scope="col">Repository</th>
                  <th scope="col">Can start</th>
                  <th scope="col">Held by</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map(
                  (r) =>
                    html`<tr data-held-repo="${r.repo}">
                      <th scope="row"><a href="/${r.repo}/map">${r.repo}</a></th>
                      <td>${heldCount("startable", r.startable)} ${startableMeter(r)}</td>
                      <td>
                        ${HOLDS.filter((h) => r.counts[h] > 0).map((h) => html`${heldCount(h, r.counts[h])} `)}
                        ${r.hot.length === 0
                          ? null
                          : html`<ul class="small" data-held-hot>
                              ${r.hot.map(
                                (h) =>
                                  html`<li data-held-hot-issue="${String(h.number)}">
                                    #${String(h.number)} waits: ${h.detail}
                                    <span class="held-pulls">${h.pulls.map((n) => html`<a class="mono" href="/${r.repo}/pulls/${String(n)}">#${String(n)}</a>`)}</span>
                                  </li>`,
                              )}
                            </ul>`}
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`}
    </section>`;
}
