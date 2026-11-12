/**
 * The drifting pulls on /boards (and so /flow): open pulls more than 25
 * landings or 6 h behind main, each a row with the one button that asks its
 * agent to bring it up to date (`POST …/pulls/N/update`). A plain section like
 * the other /boards blocks, no frame around the list. Nothing shown when none drifts.
 */

import type { DriftingPull } from "../../flow/alarm_drift.ts";
import { html, type Html } from "../html.ts";
import { btn } from "../ui.ts";

export function driftSection(pulls: readonly DriftingPull[]): Html | null {
  if (pulls.length === 0) return null;
  return html`<section class="settings-block" id="drifting">
    <h2>Drifting from main</h2>
    <ul class="list" data-drifting="${String(pulls.length)}">
      ${pulls.map(
        (p) => html`<li data-drift="${p.repo}#${String(p.number)}">
          <a href="/${p.repo}/pulls/${String(p.number)}">${p.repo} #${String(p.number)}</a>
          <span class="muted small">${String(p.landings)} landings · ${String(p.hours)} h behind</span>
          <form method="post" action="/${p.repo}/pulls/${String(p.number)}/update" class="bar">
            <input type="hidden" name="back" value="/boards" />
            ${btn("Bring up to date", { size: "sm" })}
          </form>
        </li>`,
      )}
    </ul>
  </section>`;
}
