/**
 * The home's figures: one section below the lanes, one card component, one
 * chart. Every card is a name, a value with its unit beside it, a note, and
 * (where the data has a series) a chart over days with its two ends named;
 * numbers come from one helper (`flow/figure_format.ts`). The data is the
 * lanes' worker's (`flow/figures.ts`), so a request reads memory and draws.
 *
 * What the old home's row of tiles held and is not here, because the strip or
 * a lane already says it: shipped per hour, the live version, builders
 * running. Kept: shipped (as the last 14 days, which the strip's 24 hours is
 * not), visitors, page speed, crew spend, check time, open bugs and the last
 * off-box backup.
 */

import {
  ageWords,
  count,
  duration,
  money,
  pageTime,
  share,
} from "../../flow/figure_format.ts";
import type { Figures } from "../../flow/figures.ts";
import type { LanePicture } from "../../flow/lanes.ts";
import { html, raw, type Html } from "../html.ts";

/** The events that change a figure; they change by the minute, so these are few. */
export const FIGURES_LIVE =
  "pull.merged,run.finished,release.*,app.serving,issue.opened,issue.closed";

const W = 120;
const H = 32;

/**
 * One chart, for every series: a line over a faint area, drawn in the
 * accent, scaled from zero to the series' own peak; a day with no value
 * breaks the line instead of falling to zero. `label` names it for a screen
 * reader and carries the peak.
 */
export function chart(
  series: readonly (number | null)[],
  label: string,
): Html | null {
  const known = series.filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  if (known.length === 0) return null;
  const top = Math.max(1, ...known);
  const x = (i: number): number =>
    series.length === 1 ? W / 2 : (i * W) / (series.length - 1);
  const y = (v: number): number => H - 2 - (v / top) * (H - 4);
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  series.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else run.push([x(i), y(v)]);
  });
  if (run.length > 0) runs.push(run);
  const path = (r: [number, number][]): string =>
    r.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" ");
  const body = runs
    .map((r) =>
      r.length === 1
        ? `<circle class="fg-dot" cx="${r[0]![0].toFixed(1)}" cy="${r[0]![1].toFixed(1)}" r="1.5"/>`
        : `<polygon class="fg-area" points="${path(r)} ${r[r.length - 1]![0].toFixed(1)},${H} ${r[0]![0].toFixed(1)},${H}"/><polyline class="fg-line" points="${path(r)}"/>`,
    )
    .join("");
  return raw(
    `<svg class="fg-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label}"><line class="fg-base" x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}"/>${body}</svg>`,
  );
}

interface Card {
  readonly label: string;
  readonly value: string;
  /** What the value is of: always shown. */
  readonly unit: string;
  readonly note: string;
  readonly series?: readonly (number | null)[];
  readonly seriesLabel?: string;
  /** The two ends of the series, in words. */
  readonly ends?: readonly [string, string];
  readonly tone?: "attn";
  readonly href?: string;
}

function card(c: Card): Html {
  const drawn =
    c.series === undefined ? null : chart(c.series, c.seriesLabel ?? c.label);
  const inner = html`<h3 class="fg-label">${c.label}</h3>
    <p class="fg-value">
      <span class="fg-n num">${c.value}</span
      ><span class="fg-unit">${c.unit}</span>
    </p>
    <p class="fg-note">${c.note}</p>
    <div class="fg-chart">${drawn}</div>
    <p class="fg-axis" aria-hidden="true">
      <span>${drawn === null ? "" : (c.ends?.[0] ?? "")}</span
      ><span>${drawn === null ? "" : (c.ends?.[1] ?? "")}</span>
    </p>`;
  return c.href === undefined
    ? html`<article
        class="fg-card"
        ${c.tone === undefined ? null : html` data-tone="${c.tone}"`}
      >
        ${inner}
      </article>`
    : html`<a
        class="fg-card"
        href="${c.href}"
        ${c.tone === undefined ? null : html` data-tone="${c.tone}"`}
        >${inner}</a
      >`;
}

const days = (n: number): readonly [string, string] => [
  `${n} days ago`,
  "today",
];

/** The cards for a picture's figures, in the order a person reads them: what was done, who came, what it cost, how it is. */
export function cards(f: Figures, now: number): Card[] {
  const peak = Math.max(0, ...f.shipped.days);
  const ceiling = f.spend.ceilingUsd;
  const spendShare =
    ceiling !== null && ceiling > 0 ? f.spend.todayUsd / ceiling : null;
  const backupAge = f.backup.at === null ? null : now - Date.parse(f.backup.at);
  return [
    {
      label: "Shipped",
      value: count(f.shipped.total),
      unit:
        f.shipped.total === 1
          ? "change merged in 14 days"
          : "changes merged in 14 days",
      note:
        peak === 0
          ? "Nothing merged in this time"
          : `Most in a day: ${count(peak)}`,
      series: f.shipped.days,
      seriesLabel: `Changes merged per day over 14 days, most ${count(peak)}`,
      ends: days(14),
      href: "/board",
    },
    {
      label: "Visitors",
      value: count(f.visitors.today),
      unit: f.visitors.today === 1 ? "visitor today" : "visitors today",
      note: `${count(f.visitors.week)} in 7 days · ${count(f.visitors.accountsToday)} of ${count(f.visitors.accounts)} accounts today`,
      series: f.visitors.days,
      seriesLabel: `Visitors per day over ${f.visitors.days.length} days`,
      ends: days(f.visitors.days.length),
      href: "/boards/reach",
    },
    {
      label: "Crew spend",
      value: money(f.spend.todayUsd),
      unit: "today, at list price",
      note:
        spendShare === null
          ? `${money(f.spend.totalUsd)} in 14 days · no daily ceiling set`
          : `${share(spendShare)} of the ${money(ceiling!)} daily ceiling`,
      series: f.spend.days,
      seriesLabel: `Crew spend per day over 14 days, most ${money(Math.max(0, ...f.spend.days))}`,
      ends: days(14),
      ...(spendShare !== null && spendShare >= 0.9
        ? { tone: "attn" as const }
        : {}),
      href: "/settings/crew",
    },
    {
      label: "Check time",
      value: f.checks.medianMs === null ? "—" : duration(f.checks.medianMs),
      unit:
        f.checks.medianMs === null
          ? "no check finished in 24 hours"
          : "median, last 24 hours",
      note: "How long a finished check took, per day below",
      series: f.checks.days.map((ms) => (ms === null ? null : ms / 60_000)),
      seriesLabel: "Median check time per day over 14 days, in minutes",
      ends: days(14),
      href: "/boards",
    },
    {
      label: "Page speed",
      value: f.speed.load === null ? "—" : pageTime(f.speed.load),
      unit:
        f.speed.load === null
          ? "no page view measured it in 7 days"
          : "page load, 75th percentile",
      note:
        [
          f.speed.lcp === null ? null : `LCP ${pageTime(f.speed.lcp)}`,
          f.speed.inp === null ? null : `INP ${pageTime(f.speed.inp)}`,
        ]
          .filter((p) => p !== null)
          .join(" · ") || "Reported by visitors' browsers over 7 days",
      href: "/boards/reach",
    },
    ...(f.bugs === null
      ? []
      : [
          {
            label: "Open bugs",
            value: count(f.bugs.open),
            unit: f.bugs.open === 1 ? "open bug" : "open bugs",
            note:
              f.bugs.overdue > 0
                ? `${count(f.bugs.overdue)} past their clock (4 h for high, 48 h otherwise)`
                : "None past their clock",
            ...(f.bugs.overdue > 0 ? { tone: "attn" as const } : {}),
            href: "/boards",
          },
        ]),
    {
      label: "Off-box backup",
      value: backupAge === null ? "—" : duration(backupAge),
      unit:
        backupAge === null
          ? "no backup off the machine yet"
          : "since the last one",
      note:
        backupAge === null
          ? f.backup.note || "No backup has left the machine yet"
          : f.backup.state === "red"
            ? f.backup.note || "The backup is failing"
            : f.backup.note ||
              (backupAge > 24 * 3_600_000
                ? `Overdue: more than ${ageWords(24 * 3_600_000)}`
                : "Safe off the machine"),
      ...(f.backup.state === "red" ||
      (backupAge !== null && backupAge > 24 * 3_600_000)
        ? { tone: "attn" as const }
        : {}),
      href: "/settings/backups",
    },
  ];
}

/** The cards in their grid: the live region's body. */
export function figuresGrid(picture: LanePicture, now: number): Html {
  const f = picture.figures;
  if (f === null)
    return html`<div
      class="fg-body"
      id="hf-figures-body"
      data-reading
      aria-busy="true"
      data-live="${FIGURES_LIVE}"
      data-live-src="/live/figures"
    >
      <p class="fg-reading">Reading the figures…</p>
    </div>`;
  return html`<div
    class="fg-body"
    id="hf-figures-body"
    data-live="${FIGURES_LIVE}"
    data-live-src="/live/figures"
  >
    <div class="fg-grid">${cards(f, now).map(card)}</div>
  </div>`;
}

/** The section: a disclosure whose open state the page remembers, around the live grid. Admin only: the numbers are the forge's. */
export function figuresSection(
  picture: LanePicture | undefined,
  now: number,
): Html {
  const grid =
    picture === undefined
      ? html`<div
          class="fg-body"
          id="hf-figures-body"
          data-reading
          aria-busy="true"
          data-live="${FIGURES_LIVE}"
          data-live-src="/live/figures"
        >
          <p class="fg-reading">Reading the figures…</p>
        </div>`
      : figuresGrid(picture, now);
  return html`<details class="fg" id="hf-figures" open>
    <summary class="fg-sum">
      <h2 class="fg-title">Figures</h2>
      <span class="fg-hint">What the forge measures beyond the lanes</span>
    </summary>
    ${grid}
  </details>`;
}
