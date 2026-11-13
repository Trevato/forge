/**
 * A panel's chart as a string: pure functions from points to markup, no I/O,
 * no dependencies. Every chart is drawn one way: the plot is an SVG that
 * stretches to its box (strokes do not scale), and every word around it (the
 * three values of the y axis, the labels under the plot, the legend) is text
 * of the page at its own size, so a label is never scaled, clipped or
 * wrapped, on a phone or in a wide panel. The box holds its height before the
 * first paint, so nothing shifts. One series is the accent; several are the
 * series tokens (`.fg-s0`…), named in a legend. A point says its value on
 * hover (its `<title>`) and is a link when it has rows behind it; a sentence
 * for a screen reader says the range, the lowest, the highest and the latest.
 * Every label is stripped of what XML cannot carry, then escaped.
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

const X_TICKS = 5;
const MAX_SERIES = 8;
const MAX_ROWS = 12;
/** The most points that each get a hover column; past it one column stands for several. */
const MAX_HITS = 240;

const clean = (s: string) =>
  s.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/gu, "").replace(/\s+/g, " ").trim();
const num = (n: number) => String(Math.round(n * 100) / 100);
const grouped = (n: number, digits: number) => n.toLocaleString("en-US", { maximumFractionDigits: digits });

/** A number as a person reads it: 0.42 · 12.5 · 1,234 · 12.3k · 4.5M · 7.1G. */
export function formatValue(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${grouped(v / 1e9, a >= 1e10 ? 1 : 2)}G`;
  if (a >= 1e6) return `${grouped(v / 1e6, a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${grouped(v / 1e3, a >= 1e5 ? 0 : 1)}k`;
  return grouped(v, a >= 100 ? 0 : a >= 10 ? 1 : 2);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const STAMP = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2})(?::(\d{2}))?(?::[\d.]+)?Z?)?$/;

/** A time bucket as words ("Nov 13", "Nov 13, 16:40"); any other label as it is. Times are UTC, as the queries are. */
export function labelWords(label: string): string {
  const m = STAMP.exec(label);
  if (m === null) return clean(label);
  const day = `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${String(Number(m[3]))}`;
  return m[4] === undefined ? day : `${day}, ${m[4]}:${m[5] ?? "00"}`;
}

/** How a chart says its own labels: buckets that are all whole days are said as days alone, anything else in full. */
export function sayLabels(labels: readonly string[]): (label: string) => string {
  const daily = labels.every((l) => {
    const m = STAMP.exec(l);
    return m !== null && (m[4] === undefined || (m[4] === "00" && (m[5] ?? "00") === "00"));
  });
  return daily ? (l) => labelWords(l.slice(0, 10)) : labelWords;
}

/**
 * The labels under a plot, for the few points that get one: a day for day
 * buckets, and for ticks that each fall on a day of their own; otherwise the
 * time, with the day where it starts or changes.
 */
function tickWords(labels: readonly string[]): string[] {
  const parts = labels.map((l) => STAMP.exec(l));
  const dayOf = (m: RegExpExecArray) => `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${String(Number(m[3]))}`;
  const days = parts.map((m) => (m === null ? "" : dayOf(m)));
  const daily =
    parts.every((m) => m === null || m[4] === undefined || (m[4] === "00" && (m[5] ?? "00") === "00")) ||
    (labels.length > 1 && days.every((d, i) => d !== "" && d !== days[i - 1]));
  let day = "";
  return labels.map((l, i) => {
    const m = parts[i];
    if (m === null || m === undefined) return clean(l);
    const d = days[i]!;
    if (daily) return d;
    const at = `${m[4]}:${m[5] ?? "00"}`;
    const out = d === day ? at : `${d}, ${at}`;
    day = d;
    return out;
  });
}

const t = (s: string) => escapeXml(clean(s));
const linked = (href: string | undefined, inner: string) =>
  href === undefined ? inner : `<a href="${escapeXml(href)}">${inner}</a>`;
const tip = (label: string, v: number) => `<title>${escapeXml(label)}: ${escapeXml(formatValue(v))}</title>`;

/** The top of a y axis: the first of these steps, times a power of ten, at or above `v`. */
const STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
export function niceTop(v: number): number {
  if (!(v > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  return (STEPS.find((s) => s * pow >= v * 0.999999) ?? 10) * pow;
}

/** The y scale over [bottom, top]: 0 at the bottom unless a value is negative; `y` is in the plot's 0–100, top down. */
function scale(lo: number, hi: number) {
  const top = hi > 0 ? niceTop(hi) : 0;
  const bottom = lo < 0 ? -niceTop(-lo) : 0;
  const span = top - bottom || 1;
  return { top: bottom + span, bottom, y: (v: number) => 100 - ((v - bottom) / span) * 100 };
}

const GRID = [0, 50, 100].map((y) => `<line class="chart-grid" x1="0" x2="100" y1="${y}" y2="${y}"/>`).join("");
const plot = (inner: string) => `<svg class="chart-plot" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">${GRID}${inner}</svg>`;
const yAxis = (s: { top: number; bottom: number }) =>
  `<div class="chart-y" aria-hidden="true"><span>${escapeXml(formatValue(s.top))}</span><span>${escapeXml(formatValue((s.top + s.bottom) / 2))}</span><span>${escapeXml(formatValue(s.bottom))}</span></div>`;

/**
 * At most X_TICKS labels under the plot, evenly spread from its first point to
 * its last. A few marks that sit in slots (`slots`: bars, heat cells) get one
 * place per slot instead, so a label is centred under its own mark.
 */
function xAxis(labels: readonly string[], slots = false): string {
  const n = labels.length;
  const count = Math.min(X_TICKS, n);
  const picks = new Set(count < 2 ? [0] : Array.from({ length: count }, (_, k) => Math.round((k * (n - 1)) / (count - 1))));
  const picked = [...picks];
  const words = new Map(tickWords(picked.map((i) => labels[i]!)).map((w, k) => [picked[k]!, w]));
  const tick = (i: number) => `<span><span>${escapeXml(words.get(i) ?? "")}</span></span>`;
  if (slots && n <= 12) return `<div class="chart-x is-slots" aria-hidden="true">${labels.map((_, i) => (picks.has(i) ? tick(i) : "<span></span>")).join("")}</div>`;
  return `<div class="chart-x${count < 2 ? " is-one" : ""}" aria-hidden="true">${[...picks].map(tick).join("")}</div>`;
}

const legend = (names: readonly string[]) =>
  `<ul class="chart-key">${names.map((n, i) => `<li title="${t(n)}"><svg class="fg-s${i % 8}" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><rect width="8" height="8" rx="2"/></svg><span>${t(n)}</span></li>`).join("")}</ul>`;

/** What the picture says, for a reader who cannot see it. */
function says(title: string, labels: readonly string[], values: readonly number[]): string {
  if (values.length === 0) return `${clean(title)}: no points.`;
  const say = sayLabels(labels);
  const first = say(labels[0] ?? "");
  const last = say(labels[labels.length - 1] ?? "");
  const range = labels.length === 1 ? `1 point, ${first}` : `${labels.length} points from ${first} to ${last}`;
  return `${clean(title)}: ${range}; lowest ${formatValue(Math.min(...values))}, highest ${formatValue(Math.max(...values))}, latest ${formatValue(values[values.length - 1] ?? 0)}.`;
}

const frame = (kind: Chart, title: string, summary: string, inner: string) =>
  `<div class="chart" data-chart="${kind}" role="group" aria-label="${t(title).slice(0, 160)}"><p class="sr-only">${escapeXml(summary)}</p>${inner}</div>`;
const nothing = (kind: Chart, title: string) =>
  frame(kind, title, `${clean(title)}: no points.`, `<p class="chart-none">No points in this range.</p>`);

/** One column per point (or per few, past MAX_HITS) that says the point's value on hover and links to its rows. */
function hits(points: readonly Point[], x: (i: number) => number): string {
  const n = points.length;
  const say = sayLabels(points.map((p) => p.label));
  const every = Math.ceil(n / MAX_HITS);
  const out: string[] = [];
  for (let i = 0; i < n; i += every) {
    const p = points[Math.min(n - 1, i + Math.floor(every / 2))]!;
    const left = i === 0 ? 0 : (x(i - 1) + x(i)) / 2;
    const end = Math.min(n - 1, i + every - 1);
    const right = end === n - 1 ? 100 : (x(end) + x(end + 1)) / 2;
    out.push(linked(p.href, `<rect class="chart-hit" x="${num(left)}" y="0" width="${num(right - left)}" height="100">${tip(say(p.label), p.value)}</rect>`));
  }
  return out.join("");
}

const across = (n: number) => (i: number) => (n < 2 ? 50 : (i * 100) / (n - 1));
const path = (values: readonly number[], x: (i: number) => number, y: (v: number) => number) =>
  values.length === 1
    ? `M40 ${num(y(values[0]!))} L60 ${num(y(values[0]!))}`
    : values.map((v, i) => `${i === 0 ? "M" : "L"}${num(x(i))} ${num(y(v))}`).join(" ");

export function lineChart(points: readonly Point[], title: string): string {
  if (points.length === 0) return nothing("line", title);
  const values = points.map((p) => p.value);
  const s = scale(Math.min(...values), Math.max(...values));
  const x = across(points.length);
  const d = path(values, x, s.y);
  const wash = points.length < 2 ? "" : `<path class="chart-wash" d="${d} L100 ${num(s.y(0))} L0 ${num(s.y(0))} Z"/>`;
  return frame("line", title, says(title, points.map((p) => p.label), values),
    `${yAxis(s)}${plot(`${wash}<path class="chart-line" d="${d}"/>${hits(points, x)}`)}${xAxis(points.map((p) => p.label))}`);
}

/** One bar per point, from zero; a slot is 100 / n wide and the bar 70% of it. */
export function barChart(points: readonly Point[], title: string): string {
  if (points.length === 0) return nothing("bar", title);
  const values = points.map((p) => p.value);
  const s = scale(Math.min(...values), Math.max(...values));
  const slot = 100 / points.length;
  const say = sayLabels(points.map((p) => p.label));
  const bars = points.map((p, i) => {
    const top = Math.min(s.y(p.value), s.y(0));
    const h = Math.abs(s.y(p.value) - s.y(0));
    return linked(p.href, `<rect class="bar" x="${num(slot * i + slot * 0.15)}" y="${num(top)}" width="${num(slot * 0.7)}" height="${num(h)}">${tip(say(p.label), p.value)}</rect>`);
  });
  return frame("bar", title, says(title, points.map((p) => p.label), values),
    `${yAxis(s)}${plot(bars.join(""))}${xAxis(points.map((p) => p.label), true)}`);
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

/**
 * Series stacked on each other, one filled band per series in its series
 * colour. Negative values are drawn as 0 (a stack of signed values has no
 * single reading) and the scale is the tallest stack.
 */
export function stackedArea(cells: readonly Cell[], title: string): string {
  const { xs, names, values } = gridOf(cells, MAX_SERIES);
  if (xs.length === 0) return nothing("area", title);
  const pos = values.map((r) => r.map((v) => Math.max(0, v)));
  const tops = xs.map((_, i) => pos.reduce((a, r) => a + r[i]!, 0));
  const s = scale(0, Math.max(0, ...tops));
  // One x alone is drawn as a band across the plot, so it has an area to show.
  const x = xs.length < 2 ? (i: number) => i * 100 : across(xs.length);
  const twice = <T>(r: readonly T[]) => (xs.length < 2 ? [r[0]!, r[0]!] : r);
  const base = twice(xs).map(() => 0);
  const bands = names.map((n, k) => {
    const upper = twice(pos[k]!).map((v, i) => base[i]! + v);
    const fwd = upper.map((v, i) => `${i === 0 ? "M" : "L"}${num(x(i))} ${num(s.y(v))}`);
    const back = base.map((v, i) => `L${num(x(i))} ${num(s.y(v))}`).reverse();
    const total = pos[k]!.reduce((a, v) => a + v, 0);
    upper.forEach((v, i) => (base[i] = v));
    return `<path class="area fg-s${k % 8}" d="${[...fwd, ...back, "Z"].join(" ")}"><title>${t(n)}: ${escapeXml(formatValue(total))} in all</title></path>`;
  });
  return frame("area", title, `${says(title, xs, tops)} Stacked: ${names.map(clean).join(", ")}.`,
    `${yAxis(s)}${plot(bands.join(""))}${xAxis(xs)}${legend(names)}`);
}

/**
 * The latest point's value, large, with every point as a sparkline under it.
 * "Latest" is the last group in the query's order: the newest bucket when
 * the query is grouped by time.
 */
export function numberChart(points: readonly Point[], title: string): string {
  const last = points[points.length - 1];
  if (last === undefined) return nothing("number", title);
  const values = points.map((p) => p.value);
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo || 1;
  const d = path(values, across(points.length), (v) => 92 - ((v - lo) / span) * 84);
  return frame("number", title, says(title, points.map((p) => p.label), values),
    `<p class="chart-big">${linked(last.href, `<span class="big num">${escapeXml(formatValue(last.value))}</span>`)}<span class="chart-note">${escapeXml(sayLabels(points.map((p) => p.label))(last.label))}, the latest of ${points.length}</span></p>` +
    `<svg class="chart-plot" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path class="chart-line spark" d="${d}"/></svg>`);
}

/**
 * Time across, one row per category, each cell's opacity its share of the
 * largest cell (0 is faint, never invisible, so the grid reads as a grid).
 * Negative values are drawn as 0.
 */
export function heatStrip(cells: readonly Cell[], title: string): string {
  const { xs, names, values, hrefs } = gridOf(cells, MAX_ROWS);
  if (xs.length === 0) return nothing("heat", title);
  const max = Math.max(0, ...values.flat()) || 1;
  const say = sayLabels(xs);
  const cw = 100 / xs.length;
  const ch = 100 / names.length;
  const rects = names.flatMap((n, r) =>
    xs.map((l, i) => {
      const v = values[r]![i]!;
      const o = 0.06 + 0.94 * (Math.max(0, v) / max);
      return linked(hrefs[r]![i],
        `<rect class="cell" x="${num(cw * i)}" y="${num(ch * r)}" width="${num(cw)}" height="${num(ch)}" fill-opacity="${num(o)}"><title>${t(n)} · ${escapeXml(say(l))}: ${escapeXml(formatValue(v))}</title></rect>`);
    }));
  return frame("heat", title, `${clean(title)}: ${names.length} rows by ${xs.length} columns, from ${say(xs[0]!)} to ${say(xs[xs.length - 1]!)}; the largest cell is ${formatValue(max)}.`,
    `<div class="chart-y is-rows" aria-hidden="true">${names.map((n) => `<span title="${t(n)}">${t(n)}</span>`).join("")}</div>` +
    `<svg class="chart-plot" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">${rects.join("")}</svg>${xAxis(xs, true)}`);
}

/** The points as an HTML table: one row each, a series column when there is one. */
export function tableChart(cells: readonly Cell[], title: string): string {
  const split = cells.some((c) => c.series !== undefined);
  const say = sayLabels(cells.map((c) => c.label));
  return [
    `<table class="table chart-table" data-dense><caption class="sr-only">${t(title)}</caption>`,
    `<thead><tr><th scope="col">Group</th>${split ? `<th scope="col">Series</th>` : ""}<th scope="col" class="num">Value</th></tr></thead><tbody>`,
    ...cells.map((c) => `<tr><td>${linked(c.href, escapeXml(say(c.label)))}</td>${split ? `<td>${t(c.series ?? "")}</td>` : ""}<td class="num">${escapeXml(formatValue(c.value))}</td></tr>`),
    cells.length === 0 ? `<tr><td colspan="${split ? 3 : 2}" class="muted">No points in this range.</td></tr>` : "",
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
