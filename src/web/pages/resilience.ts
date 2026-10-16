/**
 * /resilience: each protection in docs/THREATS.md as one line — green, red
 * or "no test yet" — naming the test file it cites, judged by the last full
 * gate's per-file results (`checks/gate_last.ts`). A cited file the last
 * gate did not run reads "untested", never green.
 */

import { readResilience } from "../../checks/resilience.ts";
import type { Standing } from "../../core/threats.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { badge, card } from "../ui.ts";

const TONE = { green: "success", red: "danger", untested: "default", "no test yet": "default" } as const;

// GET /resilience: a forge admin's, since live red lines name what to attack.
export function resiliencePage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  const rows = readResilience(ctx.app.config.dataDir);
  const count = (s: Standing): number => rows.filter((r) => r.s === s).length;
  const body = html`<div class="page-head">
      <h1>Resilience</h1>
      <p class="muted">
        Each protection in THREATS.md, judged by
        the test file it cites in the last full gate.
      </p>
    </div>
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
  return page({ ctx, title: "Resilience", body });
}
