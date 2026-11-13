/**
 * A panel's data over a window, at a step: the one door a board page, home's
 * pinned panels and `GET /api/v1/boards/:slug/panels/:id` read a panel
 * through. A panel grouped by time is bucketed in SQL to the step — asked
 * for, or else the finest that keeps the chart near `TARGET_POINTS` wide —
 * and never cut short: an answer too large for its step is asked again at
 * the next coarser one. Plain data in, plain data out; the caller has
 * checked the asker is an admin.
 */
import type { Database } from "bun:sqlite";
import { drawChart, usesSeries, type Cell, type Chart } from "./chart.ts";
import { BUCKETS, MAX_STEP, oldestTime, runQuery, type Answer, type Bucket, type Row } from "./query.ts";
import type { Board, Panel } from "./store.ts";

export const RANGE_MS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 } as const;
/** The steps a panel picks from on its own, in seconds: 1 min to a week. */
export const STEPS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400, 604_800] as const;
/** About one point per two pixels of a chart's plot: more says nothing a reader can see. */
export const TARGET_POINTS = 360;
const UNIT = { s: 1, m: 60, h: 3600, d: 86_400 } as const;

/** The window asked for: ISO times and a step in seconds, each absent when not asked. */
export type Window = { from?: string; to?: string; step?: number };
export type PanelData =
  | { ok: true; rows: Row[]; from: string | null; to: string | null; step: number | null }
  | { ok: false; error: string };

/**
 * Run `query` for `chart`: a chart that draws one value per group is asked
 * without the query's series, so its groups are not split. The run is
 * scoped to every repo — only an admin reaches a board.
 */
export function runFor(db: Database, chart: Chart, query: Record<string, unknown>): Answer {
  if (usesSeries(chart) || query.series === undefined) return runQuery(db, query, { repoIds: "all" });
  const { series: _, ...rest } = query;
  return runQuery(db, rest, { repoIds: "all" });
}

/** `300`, `15s`, `5m`, `1h` or `1d` as seconds; undefined for anything else or out of 1 s to a year. */
export function parseStep(s: string): number | undefined {
  const m = /^(\d{1,8})([smhd]?)$/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]) * UNIT[(m[2] || "s") as keyof typeof UNIT];
  return n >= 1 && n <= MAX_STEP ? n : undefined;
}

/** `from`, `to` and `step` from a URL, judged: the window, or why it is not one. */
export function parseWindow(search: URLSearchParams): { ok: true; window: Window } | { ok: false; error: string } {
  const window: Window = {};
  for (const key of ["from", "to"] as const) {
    const v = search.get(key);
    if (v === null || v === "") continue;
    const t = v.length <= 64 ? Date.parse(v) : Number.NaN;
    if (Number.isNaN(t)) return { ok: false, error: `${key} must be a date, like 2026-10-20T00:00:00Z` };
    window[key] = new Date(t).toISOString();
  }
  const step = search.get("step");
  if (step !== null && step !== "") {
    const n = parseStep(step);
    if (n === undefined) return { ok: false, error: "step must be seconds or a count of s, m, h or d, like 300 or 5m, up to a year" };
    window.step = n;
  }
  if (window.from !== undefined && window.to !== undefined && window.from >= window.to) {
    return { ok: false, error: "from must be before to" };
  }
  return { ok: true, window };
}

/** The finest step from `STEPS`, no finer than `natural`, that keeps `spanMs` within `TARGET_POINTS` buckets. */
export function stepFor(spanMs: number, natural: number): number {
  const fit = STEPS.find((s) => s >= natural && (spanMs / 1000) / s <= TARGET_POINTS);
  return fit ?? Math.max(natural, STEPS[STEPS.length - 1]!);
}

/** The panel's bucket width in seconds, or undefined when it is not grouped by time. */
function bucketOf(query: Record<string, unknown>): number | undefined {
  const g = query.groupBy;
  if (typeof g !== "object" || g === null) return undefined;
  const b = (g as Record<string, unknown>).bucket;
  return typeof b === "string" && Object.hasOwn(BUCKETS, b) ? BUCKETS[b as Bucket] : undefined;
}

/**
 * `panel`'s rows over `window` at `now`. The window's `from` and `to` stand
 * in for the query's, and the board's range is the start when neither
 * names one; with no start at all, the span runs from the oldest row. A
 * step asked for is kept, or refused when it would be cut short; a step not
 * asked for fits the span and grows until the answer fits.
 */
export function panelData(
  db: Database,
  board: Board,
  panel: Panel,
  window: Window = {},
  now = Date.now(),
  run: typeof runFor = runFor,
): PanelData {
  const query: Record<string, unknown> = { ...panel.query };
  if (window.from !== undefined) query.from = window.from;
  if (window.to !== undefined) query.to = window.to;
  if (query.from === undefined && board.range !== "all") query.from = new Date(now - RANGE_MS[board.range]).toISOString();
  const from = typeof query.from === "string" ? query.from : null;
  const to = typeof query.to === "string" ? query.to : null;
  const natural = bucketOf(query);
  if (natural === undefined) {
    const answer = run(db, panel.chart, query);
    return answer.ok ? { ok: true, rows: answer.rows, from, to, step: null } : { ok: false, error: answer.error };
  }
  if (window.step !== undefined) {
    const answer = run(db, panel.chart, { ...query, step: window.step });
    return answer.ok ? { ok: true, rows: answer.rows, from, to, step: window.step } : { ok: false, error: answer.error };
  }
  // With no start (a board whose range is `all`), the span runs from the oldest row the panel reads.
  const oldest = from === null ? oldestTime(db, query, { repoIds: "all" }) : from;
  const start = oldest === null ? Number.NaN : Date.parse(oldest);
  const end = to === null ? now : Date.parse(to);
  let step = Number.isNaN(start) || Number.isNaN(end) ? natural : stepFor(end - start, natural);
  for (;;) {
    const answer = run(db, panel.chart, { ...query, step });
    if (answer.ok) return { ok: true, rows: answer.rows, from, to, step };
    const coarser = STEPS.find((s) => s > step);
    if (answer.tooMany !== true || coarser === undefined) return { ok: false, error: answer.error };
    step = coarser;
  }
}

/** Rows as the cells a chart draws: a null group or series reads "all"/"none". */
export const cellsOf = (rows: readonly Row[], hrefs: readonly (string | null)[] = []): Cell[] =>
  rows.map((r, i) => ({
    label: String(r.group ?? "all"),
    value: r.value ?? 0,
    ...(r.series !== undefined ? { series: String(r.series ?? "none") } : {}),
    ...(hrefs[i] ? { href: hrefs[i]! } : {}),
  }));

/** A panel as it is drawn: its chart's markup and, for one series over time, its latest value; or why it could not be read. */
export type PanelDrawn = { ok: true; chart: string; latest: number | null } | { ok: false; error: string };

/** Draw `panel` from its rows: the chart is markup from here on, so whoever reads the rows off the serving thread draws them there too. */
export function drawnPanel(panel: Panel, answer: PanelData): PanelDrawn {
  if (!answer.ok) return answer;
  const newest = panel.chart === "line" || panel.chart === "bar" ? answer.rows[answer.rows.length - 1] : undefined;
  // One series drawn over time says its latest value beside its name; a split, a table or groups of anything else have no one latest.
  const latest = newest !== undefined && newest.series === undefined && /^\d{4}-\d{2}-\d{2}/.test(String(newest.group)) ? (newest.value ?? 0) : null;
  return { ok: true, chart: drawChart(panel.chart, cellsOf(answer.rows), panel.title), latest };
}

/** A text cell a spreadsheet will not read as a formula, quoted when it holds a comma, quote or newline. */
function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Rows as CSV: `group,value`, or `group,series,value` when the rows are split by a series. */
export function rowsCsv(rows: readonly Row[]): string {
  const split = rows.some((r) => r.series !== undefined);
  const head = split ? ["group", "series", "value"] : ["group", "value"];
  const lines = rows.map((r) => (split ? [r.group, r.series, r.value] : [r.group, r.value]).map(csvCell).join(","));
  return [head.join(","), ...lines].join("\r\n") + "\r\n";
}
