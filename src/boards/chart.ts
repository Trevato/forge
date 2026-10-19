/**
 * A panel's chart as a string: pure functions from points to markup, no I/O,
 * no dependencies, drawn the way `web/og/card.ts` draws. Line, bar, stacked
 * area, a single number with a sparkline and a heat strip are SVG; a table is
 * HTML. The viewBox is fixed and the element carries its aspect ratio, so the
 * space is held before the first paint and nothing shifts. Colour is
 * `currentColor` (series are told apart by opacity and named in a legend);
 * every label is stripped of what XML cannot carry, clamped, then escaped.
 */
import { escapeXml } from "../web/og/card.ts";

export type Point = { label: string; value: number; href?: string };
/** A point of a grouped query: `label` is the x (a time bucket), `series` the category. */
export type Cell = Point & { series?: string };

export const CHARTS = ["line", "bar", "area", "number", "table", "heat"] as const;
export type Chart = (typeof CHARTS)[number];
export const CHART_NAMES: Readonly<Record<Chart, string>> = {
  line: "line", bar: "bar", area: "stacked area", number: "number + sparkline", table: "table", heat: "heat strip",
};
/** The charts that read a query's `series`; the others are drawn from one value per group. */
export const usesSeries = (c: Chart) => c === "area" || c === "heat" || c === "table";

export const CHART_WIDTH = 720;
export const CHART_HEIGHT = 260;
const LEFT = 56;
const RIGHT = 16;
const TOP = 16;
const BOTTOM = 40;
const MAX_LABEL = 16;
const X_TICKS = 6;

const clean = (s: string) =>
  s.replace(/[^\u0009\u000A\u000D -퟿-�]/gu, "").replace(/\s+/g, " ").trim();
const clamp = (s: string, n = MAX_LABEL) => {
  const c = clean(s);
  return c.length > n ? `${c.slice(0, n - 1)}…` : c;
};
const num = (n: number) => String(Math.round(n * 100) / 100);

/** A short, readable number for an axis. */
export function formatValue(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${num(v / 1e9)}G`;
  if (a >= 1e6) return `${num(v / 1e6)}M`;
  if (a >= 1e4) return `${num(v / 1e3)}k`;
  return num(v);
}

const W = CHART_WIDTH - LEFT - RIGHT;
const H = CHART_HEIGHT - TOP - BOTTOM;
const MAX_SERIES = 8;
const MAX_ROWS = 12;
const t = (s: string, n = MAX_LABEL) => escapeXml(clamp(s, n));
const linked = (href: string | undefined, inner: string) =>
  href === undefined ? inner : `<a href="${escapeXml(href)}">${inner}</a>`;
const tip = (label: string, v: number) => `<title>${t(label, 40)}: ${escapeXml(formatValue(v))}</title>`;

/** The `<svg>` open tag and its title. */
const open = (title: string) => [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" width="${CHART_WIDTH}" height="${CHART_HEIGHT}" role="img" aria-label="${t(title, 120)}" class="chart" preserveAspectRatio="xMidYMid meet" font-size="10" font-family="inherit" fill="currentColor">`,
  `<title>${t(title, 120)}</title>`,
];
const nothing = (out: string[]) => {
  out.push(`<text x="${CHART_WIDTH / 2}" y="${CHART_HEIGHT / 2}" text-anchor="middle">No points</text></svg>`);
  return out.join("");
};

/** A y scale over [min(0, lo), max(0, hi)] with three gridlines drawn into `out`. */
function yAxis(out: string[], lo: number, hi: number) {
  const min = Math.min(0, lo);
  const span = Math.max(0, hi) - min || 1;
  const y = (v: number) => TOP + H - ((v - min) / span) * H;
  for (const f of [0, 0.5, 1]) {
    const v = min + span * f;
    const gy = y(v);
    out.push(
      `<line x1="${LEFT}" x2="${CHART_WIDTH - RIGHT}" y1="${num(gy)}" y2="${num(gy)}" stroke="currentColor" stroke-opacity="0.2"/>`,
      `<text x="${LEFT - 6}" y="${num(gy + 4)}" text-anchor="end">${escapeXml(formatValue(v))}</text>`,
    );
  }
  return y;
}

/** At most X_TICKS labels under the plot, at `x(i)`. */
function xLabels(out: string[], labels: readonly string[], x: (i: number) => number) {
  const step = Math.max(1, Math.ceil(labels.length / X_TICKS));
  labels.forEach((l, i) => {
    if (i % step !== 0) return;
    out.push(`<text x="${num(x(i))}" y="${CHART_HEIGHT - 16}" text-anchor="middle">${t(l)}</text>`);
  });
}

const lo = (ps: readonly Point[]) => Math.min(...ps.map((p) => p.value));
const hi = (ps: readonly Point[]) => Math.max(...ps.map((p) => p.value));

export function lineChart(points: readonly Point[], title: string): string {
  const out = open(title);
  const y = yAxis(out, lo(points), hi(points));
  if (points.length === 0) return nothing(out);
  const x = (i: number) => LEFT + (points.length < 2 ? W / 2 : (i * W) / (points.length - 1));
  xLabels(out, points.map((p) => p.label), x);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${num(x(i))} ${num(y(p.value))}`).join(" ");
  out.push(`<path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`);
  points.forEach((p, i) => {
    out.push(linked(p.href, `<circle cx="${num(x(i))}" cy="${num(y(p.value))}" r="4">${tip(p.label, p.value)}</circle>`));
  });
  out.push("</svg>");
  return out.join("");
}

/** One bar per point, from zero; a slot is W / n wide and the bar 70% of it. */
export function barChart(points: readonly Point[], title: string): string {
  const out = open(title);
  const y = yAxis(out, lo(points), hi(points));
  if (points.length === 0) return nothing(out);
  const slot = W / points.length;
  const bw = Math.max(1, slot * 0.7);
  const x = (i: number) => LEFT + slot * i + slot / 2;
  xLabels(out, points.map((p) => p.label), x);
  points.forEach((p, i) => {
    const top = Math.min(y(p.value), y(0));
    const h = Math.abs(y(p.value) - y(0));
    out.push(linked(p.href,
      `<rect class="bar" x="${num(x(i) - bw / 2)}" y="${num(top)}" width="${num(bw)}" height="${num(h)}">${tip(p.label, p.value)}</rect>`));
  });
  out.push("</svg>");
  return out.join("");
}

/**
 * Cells as a grid: x labels in the order first seen (a grouped query is
 * ordered by its group), series sorted, a missing cell is 0. Past `keep`
 * series the smallest totals fold into one named "other".
 */
export function gridOf(cells: readonly Cell[], keep: number) {
  const xs: string[] = [];
  const at = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const c of cells) {
    if (!at.has(c.label)) at.set(c.label, xs.push(c.label) - 1);
    const s = c.series ?? "all";
    totals.set(s, (totals.get(s) ?? 0) + Math.abs(c.value));
  }
  let names = [...totals.keys()].sort();
  const fold = names.length > keep
    ? new Set([...totals.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(keep - 1).map(([n]) => n))
    : new Set<string>();
  if (fold.size > 0) names = [...names.filter((n) => !fold.has(n)), "other"];
  const row = new Map(names.map((n, i) => [n, i]));
  const values = names.map(() => xs.map(() => 0));
  const hrefs: (string | undefined)[][] = names.map(() => xs.map(() => undefined));
  for (const c of cells) {
    const s = c.series ?? "all";
    const r = row.get(fold.has(s) ? "other" : s)!;
    const i = at.get(c.label)!;
    values[r]![i]! += c.value;
    hrefs[r]![i] = fold.has(s) ? undefined : c.href;
  }
  return { xs, names, values, hrefs };
}

/** Series opacity: the first is the strongest, each next one lighter. */
const shade = (i: number, n: number) => num(n < 2 ? 0.8 : 0.85 - (0.6 * i) / (n - 1));

function legend(out: string[], names: readonly string[]) {
  const each = W / Math.max(1, names.length);
  names.forEach((n, i) => {
    const lx = LEFT + each * i;
    out.push(
      `<rect class="key" x="${num(lx)}" y="${CHART_HEIGHT - 10}" width="8" height="8" fill-opacity="${shade(i, names.length)}"/>`,
      `<text x="${num(lx + 12)}" y="${CHART_HEIGHT - 2}">${t(n, 14)}</text>`,
    );
  });
}

/**
 * Series stacked on each other, one filled path per series. Negative values
 * are drawn as 0 — a stack of signed values has no single reading — and the
 * scale is the tallest stack.
 */
export function stackedArea(cells: readonly Cell[], title: string): string {
  const out = open(title);
  const { xs, names, values } = gridOf(cells, MAX_SERIES);
  const pos = values.map((r) => r.map((v) => Math.max(0, v)));
  const tops = xs.map((_, i) => pos.reduce((a, r) => a + r[i]!, 0));
  const y = yAxis(out, 0, Math.max(0, ...tops));
  if (xs.length === 0) return nothing(out);
  const x = (i: number) => LEFT + (xs.length < 2 ? W / 2 : (i * W) / (xs.length - 1));
  xLabels(out, xs, x);
  const base = xs.map(() => 0);
  names.forEach((n, s) => {
    const upper = base.map((b, i) => b + pos[s]![i]!);
    const fwd = upper.map((v, i) => `${i === 0 ? "M" : "L"}${num(x(i))} ${num(y(v))}`);
    const back = base.map((v, i) => `L${num(x(i))} ${num(y(v))}`).reverse();
    const total = pos[s]!.reduce((a, v) => a + v, 0);
    out.push(`<path class="area" d="${[...fwd, ...back, "Z"].join(" ")}" fill-opacity="${shade(s, names.length)}" stroke="currentColor" stroke-width="1">${tip(n, total)}</path>`);
    upper.forEach((v, i) => (base[i] = v));
  });
  legend(out, names);
  out.push("</svg>");
  return out.join("");
}

/**
 * The latest point's value, large, with every point as a sparkline under it.
 * "Latest" is the last group in the query's order — the newest bucket when
 * the query is grouped by time.
 */
export function numberChart(points: readonly Point[], title: string): string {
  const out = open(title);
  const last = points[points.length - 1];
  if (last === undefined) return nothing(out);
  out.push(
    linked(last.href, `<text class="big" x="${CHART_WIDTH / 2}" y="110" text-anchor="middle" font-size="72">${escapeXml(formatValue(last.value))}</text>`),
    `<text x="${CHART_WIDTH / 2}" y="140" text-anchor="middle">${t(`latest of ${points.length}: ${last.label}`, 60)}</text>`,
  );
  const lo0 = lo(points);
  const span = hi(points) - lo0 || 1;
  const x = (i: number) => LEFT + (points.length < 2 ? W / 2 : (i * W) / (points.length - 1));
  const y = (v: number) => CHART_HEIGHT - 16 - ((v - lo0) / span) * 80;
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${num(x(i))} ${num(y(p.value))}`).join(" ");
  out.push(`<path class="spark" d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`, "</svg>");
  return out.join("");
}

/**
 * Time across, one row per category, each cell's opacity its share of the
 * largest cell (0 is faint, never invisible, so the grid reads as a grid).
 * Negative values are drawn as 0.
 */
export function heatStrip(cells: readonly Cell[], title: string): string {
  const out = open(title);
  const { xs, names, values, hrefs } = gridOf(cells, MAX_ROWS);
  if (xs.length === 0) return nothing(out);
  const max = Math.max(0, ...values.flat()) || 1;
  const cw = W / xs.length;
  const ch = H / names.length;
  xLabels(out, xs, (i) => LEFT + cw * i + cw / 2);
  names.forEach((n, r) => {
    out.push(`<text x="${LEFT - 6}" y="${num(TOP + ch * r + ch / 2 + 4)}" text-anchor="end">${t(n, 8)}</text>`);
    xs.forEach((l, i) => {
      const v = values[r]![i]!;
      const o = 0.06 + 0.94 * (Math.max(0, v) / max);
      out.push(linked(hrefs[r]![i],
        `<rect class="cell" x="${num(LEFT + cw * i)}" y="${num(TOP + ch * r)}" width="${num(Math.max(1, cw - 1))}" height="${num(Math.max(1, ch - 1))}" fill-opacity="${num(o)}">${tip(`${n} · ${l}`, v)}</rect>`));
    });
  });
  out.push("</svg>");
  return out.join("");
}

/** The points as an HTML table: one row each, a series column when there is one. */
export function tableChart(cells: readonly Cell[], title: string): string {
  const split = cells.some((c) => c.series !== undefined);
  const cell = (c: Cell, s: string) => `<td class="mono">${linked(c.href, escapeXml(clean(s)))}</td>`;
  return [
    `<table class="table chart-table"><caption class="sr-only">${t(title, 120)}</caption>`,
    `<thead><tr><th scope="col">group</th>${split ? `<th scope="col">series</th>` : ""}<th scope="col" class="num">value</th></tr></thead><tbody>`,
    ...cells.map((c) => `<tr>${cell(c, c.label)}${split ? `<td class="mono">${escapeXml(clean(c.series ?? ""))}</td>` : ""}<td class="num mono">${escapeXml(num(c.value))}</td></tr>`),
    cells.length === 0 ? `<tr><td colspan="${split ? 3 : 2}" class="muted">No points</td></tr>` : "",
    "</tbody></table>",
  ].join("");
}

/** One chart by name: the one door a page draws a panel through. */
export function drawChart(chart: Chart, cells: readonly Cell[], title: string): string {
  switch (chart) {
    case "line": return lineChart(cells, title);
    case "bar": return barChart(cells, title);
    case "area": return stackedArea(cells, title);
    case "number": return numberChart(cells, title);
    case "heat": return heatStrip(cells, title);
    case "table": return tableChart(cells, title);
  }
}
