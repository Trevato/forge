/**
 * The money line (#510): "This month · cost $359.34 · revenue $412.00 ·
 * +$52.66 · spend: balanced", the slider's position in words beside it,
 * and thirty days of daily cost and revenue drawn as a server-rendered SVG
 * — two polylines with the gap shaded between them, no chart library. The
 * board shows the forge's; an app's card shows the same three numbers
 * (`moneyRows`).
 *
 * The slot is the same height whatever the numbers, zeros included: the
 * line is two rows (the month and the slider; today), each reserved in the
 * CSS, and the SVG has a fixed width and height, so nothing moves when the
 * figures arrive (no layout shift). On the board the slider's word is the
 * one link to Settings → Economics, where it is set (#11102); the gap beside
 * it takes the warning tint for a loss and the text colour otherwise — the
 * accent stays on something you can press (docs/DESIGN.md §5).
 */

import type { AppMoney, ForgeMoney, MoneyDay, MoneyLine } from "../../actions/money.ts";
import { positionWord } from "../../core/slider.ts";
import { html, type Html } from "../html.ts";

/** US dollars to the cent, as on a statement. */
export const dollars = (n: number): string => `$${Math.abs(n).toFixed(2)}`;

/** The gap with its sign: "+$52.66", "-$3.10", "$0.00". */
export function signed(n: number): string {
  const c = Math.round(n * 100);
  return c > 0 ? `+${dollars(n)}` : c < 0 ? `-${dollars(n)}` : dollars(0);
}

/**
 * "up" for a profit, "down" for a loss, "even" at zero. A loss is in the
 * warning tint everywhere; on the board, where the gap is a link, a profit
 * takes the accent.
 */
export function gapSign(n: number): "up" | "down" | "even" {
  const c = Math.round(n * 100);
  return c > 0 ? "up" : c < 0 ? "down" : "even";
}

const gap = (n: number): Html => html`<span class="money-gap num" data-sign="${gapSign(n)}">${signed(n)}</span>`;

/**
 * The board's month, in one line (#11056, #11102): "This month · cost
 * $359.34 · revenue $412.00 · +$52.66 · spend: balanced", the gap read
 * against the slider's position in words, and that word the board's one
 * link to Settings → Economics, where it is set. Its accessible name says
 * what the word is and where it goes.
 */
export function monthLine(m: MoneyLine, position: number): Html {
  const word = positionWord(position);
  return html`This month · cost <span class="num">${dollars(m.cost)}</span> · revenue
    <span class="num">${dollars(m.revenue)}</span> · ${gap(m.gap)} ·
    <a class="money-spend" href="/settings/economics" aria-label="Spend slider: ${word}, open Economics settings">spend: ${word}</a>`;
}

// ---- the chart ----

/** The SVG's drawing box, in its own units; the CSS keeps the same size. */
export const CHART_W = 240;
export const CHART_H = 48;
const PAD = 2;

/**
 * Thirty days as two polylines (cost, revenue) over a shared y scale from
 * 0 to the largest figure, and between each pair of days a band shaded by
 * whether revenue was above cost (`up`) or below (`down`). All zeros draws
 * two flat lines on the baseline, in the same box.
 */
export function moneyChart(days: readonly MoneyDay[]): Html {
  const top = Math.max(0, ...days.map((d) => Math.max(d.cost, d.revenue)));
  const scale = top > 0 ? (CHART_H - 2 * PAD) / top : 0;
  const step = days.length > 1 ? (CHART_W - 2 * PAD) / (days.length - 1) : 0;
  const x = (i: number): number => Math.round((PAD + i * step) * 10) / 10;
  const y = (v: number): number => Math.round((CHART_H - PAD - v * scale) * 10) / 10;
  const points = (pick: (d: MoneyDay) => number): string =>
    days.map((d, i) => `${x(i)},${y(pick(d))}`).join(" ");
  const bands: Html[] = [];
  for (let i = 0; i + 1 < days.length; i++) {
    const a = days[i]!;
    const b = days[i + 1]!;
    const sign = gapSign(a.gap + b.gap);
    if (sign === "even") continue;
    bands.push(
      html`<polygon data-sign="${sign}" points="${x(i)},${y(a.revenue)} ${x(i + 1)},${y(b.revenue)} ${x(i + 1)},${y(b.cost)} ${x(i)},${y(a.cost)}"></polygon>`,
    );
  }
  const first = days[0]?.day ?? "";
  const last = days[days.length - 1]?.day ?? "";
  return html`<svg
    class="money-chart"
    viewBox="0 0 ${CHART_W} ${CHART_H}"
    width="${CHART_W}"
    height="${CHART_H}"
    role="img"
    aria-labelledby="money-chart-t"
  >
    <title id="money-chart-t">Daily cost and revenue, ${first} to ${last} (UTC)</title>
    <g class="money-band">${bands}</g>
    <polyline class="money-cost" points="${points((d) => d.cost)}"></polyline>
    <polyline class="money-revenue" points="${points((d) => d.revenue)}"></polyline>
  </svg>`;
}

// ---- the board's line ----

/**
 * The forge's line for the board: the month with the slider's word, today's
 * gap, and the chart.
 */
export function forgeMoneyLine(m: ForgeMoney): Html {
  return html`<section class="money-line" id="money" aria-label="Money">
    <p class="num">
      <span>${monthLine(m.thisMonth, m.position)}</span>
      <span class="muted">Today: gap ${signed(m.today.gap)}</span>
    </p>
    ${moneyChart(m.days)}
  </section>`;
}

// ---- one app ----

const hours = (s: number): string => `${(s / 3600).toFixed(1)} h`;
const pct = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%");

/**
 * An app's month as `dl` rows: the same three numbers, then where it was
 * awake (the forge's own server against cloud), and in one sentence the
 * assumption its cost rests on.
 */
export function moneyRows(m: AppMoney, statementHref: string): Html {
  const awake = m.ownedSeconds + m.cloudSeconds;
  return html`<dl>
    <dt>Cost</dt>
    <dd class="num">${dollars(m.thisMonth.cost)}</dd>
    <dt>Revenue</dt>
    <dd class="num"><a href="${statementHref}">${dollars(m.thisMonth.revenue)}</a></dd>
    <dt>Gap</dt>
    <dd>${gap(m.thisMonth.gap)}</dd>
    <dt>Awake</dt>
    <dd>
      <span class="num">${hours(awake)}</span> · ${pct(m.ownedSeconds, awake)} on the forge's own server ·
      ${pct(m.cloudSeconds, awake)} on cloud
    </dd>
  </dl>
  <p class="muted small">
    Its cost includes ${pct(m.ownedShare * 100, 100)} of the forge's own server for the month, its share of the time apps ran there.
  </p>`;
}
