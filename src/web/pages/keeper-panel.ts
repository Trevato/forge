/**
 * The release keeper on /releases (#7557): what stops the next cut, and
 * each release it cut with its stage, the known-good version it rolls back
 * to, and what the probes counted; the release tick's heartbeat and whether
 * main is green and ahead of production (#11507). Nothing when it has done nothing.
 * A plain section under an h2, no card (#9998).
 */

import type { Database } from "bun:sqlite";
import { aheadLine } from "../../flow/alarm_main_ahead.ts";
import { beatFact, lastBeat } from "../../keeper/beat.ts";
import { blocking, MAX_REASON, standingHolds } from "../../keeper/hold.ts";
import { secondsWords, withLandedToLive } from "../../keeper/landed.ts";
import { listKeeperReleases, type Stage } from "../../keeper/record.ts";
import { stallWords } from "../../perf/boot_stall.ts";
import { html, when, type Html } from "../html.ts";
import { badge, btn, time, type Tone } from "../ui.ts";

const STAGE: Record<Stage, { label: string; tone: Tone }> = {
  rolling: { label: "rolling", tone: "attn" },
  verifying: { label: "verifying", tone: "attn" },
  verified: { label: "verified live", tone: "success" },
  rolled_back: { label: "rolled back", tone: "danger" },
};

/** `mayHold` is `mayRollBack`: the section then offers the owner's hold and its lift. */
export function keeperPanel(db: Database, mayHold = false, now: Date = new Date()): Html | undefined {
  const releases = withLandedToLive(db, listKeeperReleases(db));
  const holds = standingHolds(db);
  const blocked = blocking(holds);
  const beat = lastBeat(db);
  const ahead = aheadLine(db, now);
  if (releases.length === 0 && blocked === undefined && beat === null && ahead === undefined && !mayHold) return undefined;
  const rows = releases.map((r, i) => {
    const s = STAGE[r.stage];
    return html`<tr>
      <td>${r.version} <span class="small muted">${r.commit}</span> ${badge(s.label, { tone: s.tone })}</td>
      <td>${time(r.cutAt)}</td>
      <td>${r.landedToLiveSeconds === null ? "–" : secondsWords(r.landedToLiveSeconds)}</td>
      <td>${r.knownGood.version}</td>
      <td>${r.rollNon200} of ${r.rollProbes}</td>
      <td>${r.probes} / ${r.pages}</td>
      <td>${r.worstMs} ms</td>
      <td>${stallWords(r.worstStallMs, releases[i + 1]?.worstStallMs)}</td>
      <td>${r.secondsDark} s</td>
    </tr>${when(r.reason !== "", () => html`<tr><td colspan="9" class="small muted">${r.reason}</td></tr>`)}`;
  });
  return html`<section class="settings-block" id="keeper">
    <h2>Release keeper</h2>
    <p class="small ${blocked === undefined ? "muted" : ""}" id="keeper-blocked">${blocked ?? "Nothing holds the next cut."}</p>
    <dl class="status-rows" id="keeper-facts">
      <div class="status-row"><dt>Release tick</dt><dd id="keeper-heartbeat">${beatFact(beat, now)}</dd></div>
      ${when(ahead !== undefined, () => html`<div class="status-row"><dt>Main vs production</dt><dd id="keeper-ahead">${ahead}</dd></div>`)}
    </dl>
    ${when(rows.length > 0, () => html`<div class="table-scroll" role="region" tabindex="0" aria-label="Keeper releases"><table class="table" data-sticky-lead>
      <thead><tr><th>Version</th><th>Cut</th><th>Landed to live</th><th>Known good</th><th>Roll non-200</th><th>Probes / pages</th><th>Worst</th><th>Stall, first 5 min</th><th>Dark</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`)}
    ${when(mayHold, () => html`${holds.filter((h) => h.kind === "owner").map(
      (h) => html`<form method="post" action="/releases/hold/${h.id}/lift" class="small">Owner hold ${h.id}: ${h.reason} ${btn("Lift", { type: "submit" })}</form>`,
    )}
    <form method="post" action="/releases/hold" class="small">
      <label>Hold releases <input name="reason" maxlength="${MAX_REASON}" required placeholder="why"></label> ${btn("Hold", { type: "submit" })}
    </form>`)}
  </section>`;
}
