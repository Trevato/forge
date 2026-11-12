/**
 * Who comes back (#11265), on Settings → Traffic and the billing page: new
 * versus returning visitors per day (drawn here as SVG, no chart library), the
 * returning-visitor list, and for a forge started the visits that led
 * to it. A visitor with no cookie (a salted hash of coarse request facts)
 * says "guessed" on every row and is never merged with a cookie id. Admin only
 * by the pages that render it. The setting `traffic.returning` is changed here.
 */

import type { Ctx } from "../../http/context.ts";
import { daysOf, ledReport, visitorsReport, type DayCount, type Led, type Visitor } from "../../perf/visitor_report.ts";
import { getReturning, setReturning } from "../../settings/returning.ts";
import { notFoundPage } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo } from "../layout.ts";
import { TRAFFIC_TONES } from "../studio/kpi_row.ts";
import { btn, row } from "../ui.ts";

const W = 600;
const H = 72;

/** The chart's tones are the Traffic chart's own: the lightest for new, the darkest for returning. */
const toneOf = (cls: "people" | "deep"): string => TRAFFIC_TONES.find(([c]) => c === cls)![1];

/** Two series per day, returning over new; a visitor without a cookie counts in the series it belongs to. */
function bars(perDay: readonly DayCount[]): Html {
  const back = (d: DayCount): number => d.returningCookie + d.returningProbable;
  const fresh = (d: DayCount): number => d.newCookie + d.newProbable;
  const peak = Math.max(1, ...perDay.map((d) => back(d) + fresh(d)));
  const step = W / Math.max(1, perDay.length);
  const rects: Html[] = [];
  perDay.forEach((d, i) => {
    let y = H;
    for (const [n, tone] of [
      [back(d), toneOf("deep")],
      [fresh(d), toneOf("people")],
    ] as const) {
      const h = (n / peak) * (H - 2);
      if (h === 0) continue;
      y -= h;
      rects.push(html`<rect x="${(i * step + 0.5).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, step - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="currentColor" fill-opacity="${tone}"></rect>`);
    }
  });
  return html`<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Visitors per day, returning and new">${rects}</svg>`;
}

const GUESSED = html` <span class="muted small">guessed</span>`;

function returningRow(v: Visitor): Html {
  return row({
    title: html`<span class="mono">${v.id}</span>${v.probable ? GUESSED : null}`,
    meta: html`first came from ${v.firstRef}`,
    data: { visitor: v.id },
    facts: [
      { label: "Visits", value: String(v.visits) },
      { label: "First seen", value: v.firstSeen },
      { label: "Last seen", value: v.lastSeen },
      { label: "Got as far as", value: v.step },
    ],
  });
}

function led(l: Led): Html {
  return row({
    title: html`<span class="mono">${l.forge}</span>${l.probable ? GUESSED : null}`,
    meta: html`${l.step}`,
    data: { forge: l.forge },
    facts: [
      { label: "First came from", value: l.firstRef },
      { label: "First seen", value: l.firstSeen },
      ...l.visits.map((v, i) => ({ label: `Visit ${i + 1}, ${v.day}`, value: v.pages.join(" → ") })),
    ],
  });
}

/** The forges a visitor started, and the visits that led to each. */
export function ledBlock(ctx: Ctx): Html {
  const forges = ledReport(ctx.app.db);
  return html`<section class="settings-block">
    <h2>What led to a forge</h2>
    ${forges.length === 0
      ? html`<p class="muted small">No forge has been linked to a visitor yet. Forges started from a plan or a code are; a Stripe checkout is not yet.</p>`
      : html`<ul class="list setting-list">${forges.map(led)}</ul>`}
  </section>`;
}

/** The whole block for Settings → Traffic. */
export function visitorsBlock(ctx: Ctx, now: number): Html {
  const on = getReturning(ctx.app.db);
  const r = on ? visitorsReport(ctx.app.db, daysOf(ctx.url.searchParams.get("days")), now) : undefined;
  return html`<section class="settings-block" id="returning">
    <h2>Who comes back</h2>
    <form class="row-fields" method="post" action="/settings/traffic/returning">
      <input type="hidden" name="returning" value="${on ? "off" : "on"}" />
      <span class="small">${on ? "Keeping a visitor id for this forge's visitors." : "Off: no visitor id is kept for this forge's visitors."}</span>
      ${btn(on ? "Turn off" : "Turn on", { size: "sm", label: on ? "Turn off returning visitors" : "Turn on returning visitors" })}
    </form>
    ${r === undefined
      ? null
      : html`<p class="small muted">${r.newVisitors} new and ${r.returningVisitors} returning visitors in the last ${r.days} days; the darker bars are the ones who came back.</p>
          <div class="muted">${bars(r.perDay)}</div>
          ${r.returning.length === 0
            ? html`<p class="muted small" data-empty>No visitor has come back in the window.</p>`
            : html`<ul class="list setting-list">${r.returning.map(returningRow)}</ul>`}
          <p class="small muted">A visitor with no cookie is guessed from the browser, system, language and network, and marked guessed. <a href="/privacy">What is kept</a>.</p>`}
  </section>`;
}

/** POST /settings/traffic/returning: an admin turns the setting on or off. */
export async function returningSet(ctx: Ctx): Promise<Response> {
  if (ctx.auth.user?.isAdmin !== true || ctx.auth.user.kind === "agent") return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const value = field(form, "returning");
  if (value !== "on" && value !== "off") return flashTo(ctx, "/settings/traffic", { tone: "danger", message: "Returning visitors are on or off." });
  setReturning(ctx.app.db, value === "on", ctx.auth.user.id);
  return flashTo(ctx, "/settings/traffic", { message: value === "on" ? "Returning visitors are on." : "Returning visitors are off." });
}
