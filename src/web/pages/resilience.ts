/**
 * /resilience: each protection in docs/THREATS.md as one line — green, red
 * or "no test yet" — naming the test file it cites, judged by the last full
 * gate's per-file results (`checks/gate_last.ts`). A cited file the last
 * gate did not run reads "untested", never green.
 *
 * Above them, one line on backups: where snapshots go, or — on a preview or
 * any forge given no bucket — that they are off here and why, said plainly.
 */

import { readResilience } from "../../checks/resilience.ts";
import type { Standing } from "../../core/threats.ts";
import type { Ctx } from "../../http/context.ts";
import { nightlyLines } from "../../nightly/says.ts";
import { backupsLine } from "../../snapshot/backups_line.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { badge, card } from "../ui.ts";

const TONE = { green: "success", red: "danger", untested: "default", "no test yet": "default" } as const;

/** The shared backups line (`snapshot/backups_line.ts`), with where to act on it. */
export function backupsLineHtml(ctx: Ctx): Html {
  const line = backupsLine(ctx.app);
  if (line.where === undefined)
    return html`<p id="backups-line" class="muted">
      ${line.says} <a href="/settings/backups">Backups</a> says how to give it one.
    </p>`;
  return html`<p id="backups-line">${line.says} <a href="/settings/backups">Backups</a> lists them.</p>`;
}

/** What the nightly jobs last did (`nightly/says.ts`): that a night ran, and what it filed. */
export function nightlyHtml(ctx: Ctx): Html {
  return html`<ul id="nightly" class="muted">
    ${nightlyLines(ctx.app.config.dataDir).map((line) => html`<li>${line}</li>`)}
  </ul>`;
}

// GET /resilience: a forge admin's, since live red lines name what to attack.
export function resiliencePage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  const rows = timePhase(ctx.request, "threats", () => readResilience(ctx.app.config.dataDir));
  const rendering = performance.now();
  const count = (s: Standing): number => rows.filter((r) => r.s === s).length;
  const body = html`<div class="page-head">
      <h1>Resilience</h1>
      <p class="muted">
        Each protection in THREATS.md, judged by
        the test file it cites in the last full gate.
      </p>
    </div>
    ${backupsLineHtml(ctx)}
    ${nightlyHtml(ctx)}
    <p id="tally">
      ${String(count("green"))} green · ${String(count("red"))} red ·
      ${String(count("untested"))} untested · ${String(count("no test yet"))} with no test yet
    </p>
    ${card(
      html`<ul class="list">
        ${rows.map(
          ({ p, s }) =>
            html`<li class="row" data-standing="${s}">
              <span class="row-main">
                <span class="row-title">${p.text}</span>
                <span class="row-meta">${p.adversary}${p.test === undefined ? "" : " · "}${p.test === undefined ? "" : html`<code>${p.test}</code>`}</span>
              </span>
              <span class="row-trail">${badge(s, { tone: TONE[s] })}</span>
            </li>`,
        )}
      </ul>`,
      { pad: false },
    )}`;
  const response = page({ ctx, title: "Resilience", body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
