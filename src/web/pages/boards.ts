/**
 * Boards, for a forge admin who is a person: `GET /boards/data` lists the
 * sources and their columns, and draws one query as the chart chosen beside
 * it (line, bar, stacked area, number, table, heat strip) with the table of
 * its points under it. The query is the URL (GET params), so a
 * query is a link. Each point links to the rows behind it: the same query
 * narrowed to that point's window and listed by the source's first column.
 * Anyone else gets the not-found page.
 */
import { CHART_NAMES, CHARTS, type Cell, type Chart } from "../../boards/chart.ts";
import { runFor } from "../../boards/panel_data.ts";
import { runQuery, type Query, type Row } from "../../boards/query.ts";
import { gaps, SYSTEM } from "../../boards/sampler.ts";
import { SOURCES } from "../../boards/sources.ts";
import { listAllBoards } from "../../actions/boards.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { notFoundPage } from "../chrome.ts";
import { html, when } from "../html.ts";
import { page } from "../layout.ts";
import { btn, card, chartBox, empty, field, selectField } from "../ui.ts";

const BUCKET_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;
const AGGREGATES = ["count", "sum", "avg", "max"] as const;
const OPS = ["eq", "ne", "lt", "lte", "gt", "gte", "starts"] as const;
const MAX_PARAM = 256;
/** The fields a panel is made from: its chart and its query. */
export const PANEL_FIELDS = ["chart", "source", "aggregate", "column", "by", "series", "from", "to", "fcolumn", "fop", "fvalue"] as const;

type Bucket = keyof typeof BUCKET_MS;
const isBucket = (s: string): s is Bucket => Object.hasOwn(BUCKET_MS, s);
const isChart = (s: string): s is Chart => (CHARTS as readonly string[]).includes(s);

/** What the URL asks for: plain strings, bounded; `runQuery` judges them. */
export function readParams(search: URLSearchParams) {
  const get = (k: string, d = "") => (search.get(k) ?? d).slice(0, MAX_PARAM);
  const chart = get("chart", "line");
  return {
    chart: isChart(chart) ? chart : "line",
    source: get("source", "runs"),
    aggregate: get("aggregate", "count"),
    column: get("column"),
    by: get("by", "day"),
    series: get("series"),
    from: get("from"),
    to: get("to"),
    fcolumn: get("fcolumn"),
    fop: get("fop", "eq"),
    fvalue: get("fvalue"),
    gcolumn: get("gcolumn"),
    gvalue: get("gvalue"),
    rows: get("rows") === "1" ? "1" : "",
  };
}
export type Params = ReturnType<typeof readParams>;

export function toQuery(p: Params): Query {
  const src = Object.hasOwn(SOURCES, p.source) ? SOURCES[p.source]! : undefined;
  const q: Query = { source: p.source, aggregate: p.aggregate };
  if (p.column !== "") q.column = p.column;
  if (p.from !== "") q.from = p.from;
  if (p.to !== "") q.to = p.to;
  q.groupBy = isBucket(p.by) ? { bucket: p.by } : p.by;
  if (p.series !== "") q.series = p.series;
  const filter: NonNullable<Query["filter"]> = [];
  const add = (column: string, op: string, value: string) => {
    const numeric = src?.columns[column] === "number";
    filter.push({ column, op, value: numeric ? Number(value) : value });
  };
  if (p.fcolumn !== "") add(p.fcolumn, p.fop, p.fvalue);
  if (p.gcolumn !== "") add(p.gcolumn, "eq", p.gvalue);
  if (filter.length > 0) q.filter = filter;
  return q;
}

/** Rows as the cells a chart draws: a null group or series reads "all"/"none". */
export const cellsOf = (rows: readonly Row[], hrefs: readonly (string | null)[] = []): Cell[] =>
  rows.map((r, i) => ({
    label: String(r.group ?? "all"),
    value: r.value ?? 0,
    ...(r.series !== undefined ? { series: String(r.series ?? "none") } : {}),
    ...(hrefs[i] ? { href: hrefs[i]! } : {}),
  }));

const link = (p: Params) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== "") s.set(k, v);
  return `/boards/data?${s}`;
};

/**
 * The rows behind one point, or null when the point has no rows to name (a
 * null group). The user's own filter stays; a column group joins it as a
 * second filter (`gcolumn`/`gvalue`), a bucket group as a time window. The
 * rows view counts rows by the source's first column, so it lists that
 * column's values, not whole rows.
 */
function behind(p: Params, row: Row): string | null {
  const { group } = row;
  const first = Object.keys(SOURCES[p.source]!.columns)[0]!;
  const rows = { ...p, rows: "1", by: first, aggregate: "count", column: "", series: "" };
  if (!isBucket(p.by)) {
    // A column group and a series would be two filters beside the user's; the rows view says one.
    if (group === null || row.series !== undefined) return null;
    return link({ ...rows, gcolumn: p.by, gvalue: String(group) });
  }
  if (typeof group !== "string") return null;
  if (row.series === null) return null;
  const start = new Date(group);
  return link({
    ...rows,
    from: start.toISOString(), to: new Date(start.getTime() + BUCKET_MS[p.by]).toISOString(),
    ...(row.series === undefined ? {} : { gcolumn: p.series, gvalue: String(row.series) }),
  });
}

/**
 * Ready-made queries over the machine's cores and thermometers, from `now`:
 * the last hour per CPU (one row each, under the 1000-row cap of a column
 * group), and twelve hours of hourly heat.
 */
export function machineLinks(now: number): { label: string; href: string }[] {
  const ago = (h: number) => new Date(Math.floor(now / 60_000) * 60_000 - h * 3_600_000).toISOString();
  const base = { ...readParams(new URLSearchParams()), source: "machine", by: "target", fcolumn: "target", fop: "starts", fvalue: "cpu:" };
  return [
    { label: "CPU per core, last hour", href: link({ ...base, chart: "bar", aggregate: "avg", column: "cpu_cores", from: ago(1) }) },
    { label: "Temperature per core, last hour (max °C)", href: link({ ...base, chart: "bar", aggregate: "max", column: "celsius", from: ago(1) }) },
    { label: "CPU per core, last 12 h", href: link({ ...base, chart: "heat", aggregate: "avg", column: "cpu_cores", by: "hour", series: "target", from: ago(12) }) },
    {
      label: "Every thermometer, last hour (max °C)",
      href: link({ ...base, chart: "bar", aggregate: "max", column: "celsius", fcolumn: "celsius", fop: "gt", fvalue: "-273.15", from: ago(1) }),
    },
  ];
}

/** The inputs that say a query, filled from `p`; the page's form and a panel's share them. */
let fieldSeq = 0;

export function queryFields(p: Params) {
  const src = Object.hasOwn(SOURCES, p.source) ? SOURCES[p.source]! : undefined;
  const cols = src ? Object.keys(src.columns) : [];
  // A page can hold several forms (one per panel), so each call gets its own ids.
  const n = ++fieldSeq;
  const sel = (name: string, label: string, options: [string, string][], now: string, hint?: string) =>
    selectField({ label, name, ...(hint ? { hint } : {}), id: `f-${name}-${n}`, options: options.map(([value, text]) => ({ value, label: text, selected: value === now })) });
  const text = (name: string, label: string, value: string, placeholder: string) =>
    field({ label, name, value, placeholder, mono: true, maxlength: MAX_PARAM, spellcheck: false, id: `f-${name}-${n}` });
  const colOpts = (first: [string, string][], pick: (c: string) => string, keep = (_c: string) => true): [string, string][] => [
    ...first,
    ...cols.filter(keep).map((c) => [c, pick(c)] as [string, string]),
  ];
  return html`
    ${sel("chart", "Chart", CHARTS.map((c) => [c, CHART_NAMES[c]]), p.chart)}
    ${sel("source", "Source", Object.keys(SOURCES).map((s) => [s, s]), p.source)}
    ${sel("aggregate", "Aggregate", AGGREGATES.map((a) => [a, a]), p.aggregate)}
    ${sel("column", "Column", colOpts([["", "(rows)"]], (c) => c, (c) => src!.columns[c] === "number"), p.column, "Column to aggregate")}
    ${sel("by", "Group by", [...(Object.keys(BUCKET_MS) as Bucket[]).map((b): [string, string] => [b, `per ${b}`]), ...colOpts([], (c) => `by ${c}`)], p.by)}
    ${sel("series", "Series", colOpts([["", "(one series)"]], (c) => `split by ${c}`), p.series, "Stacked area, heat strip, table")}
    ${text("from", "From", p.from, "from 2026-10-01")}
    ${text("to", "To", p.to, "to 2026-10-08")}
    ${sel("fcolumn", "Filter column", colOpts([["", "(no filter)"]], (c) => c), p.fcolumn)}
    ${sel("fop", "Filter operator", OPS.map((o) => [o, o]), p.fop)}
    ${text("fvalue", "Filter value", p.fvalue, "value")}
  `;
}

/** The form's fields back from a stored query and its chart; what a form cannot say is dropped. */
export function paramsOf(q: Record<string, unknown>, chart: Chart = "line"): Params {
  const text = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
  const g = q.groupBy;
  const f = Array.isArray(q.filter) ? (q.filter[0] as Record<string, unknown> | undefined) : undefined;
  const base = readParams(new URLSearchParams());
  return {
    ...base,
    chart,
    source: text(q.source) || base.source,
    aggregate: text(q.aggregate) || base.aggregate,
    column: text(q.column),
    by: typeof g === "string" ? g : typeof g === "object" && g !== null ? text((g as { bucket?: unknown }).bucket) : base.by,
    series: text(q.series),
    from: text(q.from),
    to: text(q.to),
    ...(f ? { fcolumn: text(f.column), fop: text(f.op) || "eq", fvalue: text(f.value) } : {}),
  };
}

// GET /boards/data
export async function boardsPage(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user?.isAdmin !== true || user.kind === "agent") return notFoundPage(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const p = readParams(ctx.url.searchParams);
  const src = Object.hasOwn(SOURCES, p.source) ? SOURCES[p.source]! : undefined;
  const answer = timePhase(ctx.request, "query", () =>
    p.rows === "" ? runFor(ctx.app.db, p.chart, toQuery(p)) : runQuery(ctx.app.db, toQuery(p), { repoIds: "all" }),
  );
  const rendering = performance.now();
  let boardsMs = 0;
  const cols = src ? Object.keys(src.columns) : [];

  const sources = card(
    html`<ul class="list">
      ${Object.entries(SOURCES).map(
        ([name, s]) => html`<li class="row">
          <a href="${link({ ...p, source: name, by: "day", column: "", series: "", fcolumn: "", fvalue: "", gcolumn: "", gvalue: "", rows: "" })}"><strong>${name}</strong></a>
          <span class="muted small mono">${Object.entries(s.columns).map(([c, t]) => `${c}:${t}`).join(" ")}</span>
          ${s.docs && name === p.source
            ? html`<dl class="small">${Object.entries(s.docs).map(([c, d]) => html`<dt class="mono">${c}</dt><dd class="muted">${d}</dd>`)}</dl>`
            : null}
        </li>`,
      )}
    </ul>`,
    { head: html`<h2>Sources</h2>`, pad: false },
  );

  const form = card(
    html`<form method="get" action="/boards/data" class="bar">
      ${queryFields(p)}
      ${btn("Draw", { variant: "primary" })}
    </form>`,
    { head: html`<h2>Query</h2>` },
  );

  let result;
  if (!answer.ok) {
    result = empty({ icon: "activity", title: "That query was refused", note: answer.error });
  } else if (answer.rows.length === 0) {
    result = empty({ icon: "activity", title: "No rows", note: "Nothing matches this query." });
  } else {
    const hrefs = answer.rows.map((r) => (p.rows === "" ? behind(p, r) : null));
    const points = cellsOf(answer.rows, hrefs);
    const split = answer.rows[0]?.series !== undefined;
    const chart =
      p.rows === ""
        ? chartBox(p.chart, points, `${p.aggregate} of ${p.source}`)
        : html`<p class="muted small">The rows behind a point, as the values of ${cols[0] ?? ""} with how many rows have each. <a href="${link({ ...p, rows: "" })}">Back to the chart</a>.</p>`;
    result = html`${chart}
      ${when(p.rows !== "" || p.chart !== "table", () => html`<table class="table mt">
        <thead><tr><th scope="col">${p.by}</th>${split ? html`<th scope="col">${p.series}</th>` : null}<th scope="col" class="num">${p.aggregate}</th></tr></thead>
        <tbody>
          ${answer.rows.map(
            (r, i) => html`<tr>
              <td class="mono">${hrefs[i] ? html`<a href="${hrefs[i]!}">${points[i]!.label}</a>` : points[i]!.label}</td>
              ${split ? html`<td class="mono">${points[i]!.series ?? ""}</td>` : null}
              <td class="num mono">${String(r.value ?? "")}</td>
            </tr>`,
          )}
        </tbody>
      </table>`)}`;
  }

  const listing = performance.now();
  const listed = await timePhaseAsync(ctx.request, "boards", () => listAllBoards(ctx.app, user));
  boardsMs = performance.now() - listing;
  const boards = listed.ok ? listed.value : [];
  const pin =
    boards.length === 0 || !answer.ok
      ? null
      : card(
          html`<form method="post" action="/boards/pin" class="bar">
            ${PANEL_FIELDS.map(
              (k) => html`<input type="hidden" name="${k}" value="${p[k as keyof Params]}" />`,
            )}
            <input type="hidden" name="w" value="1" /><input type="hidden" name="h" value="1" />
            ${selectField({ label: "Board", name: "slug", id: "f-pin-slug", options: boards.map((b) => ({ value: b.slug, label: b.board.title })) })}
            ${field({ label: "Panel title", name: "title", id: "f-pin-title", required: true, maxlength: 80, value: `${p.aggregate} of ${p.source}` })}
            ${btn("Pin to board")}
          </form>`,
          { head: html`<h2>Pin this query</h2>` },
        );

  // The machine source says what it cannot measure here, rather than draw nothing as zero.
  const missing = p.source === "machine" ? gaps(SYSTEM) : [];
  const absent =
    p.source !== "machine"
      ? null
      : card(
          html`<p class="muted small">Sampled every 15 s: the forge's pod from its cgroup, each check and app cell from its process tree, the node and each of its CPUs (<code>cpu:&lt;nnn&gt;</code>) from /proc, and temperatures in °C from /sys/class/hwmon.</p>
          <ul class="small">${machineLinks(Date.now()).map((l) => html`<li><a href="${l.href}">${l.label}</a></li>`)}</ul>
          ${missing.length === 0
            ? html`<p class="small">Every series is readable on this machine.</p>`
            : html`<ul class="small">${missing.map((g) => html`<li>Absent — ${g}</li>`)}</ul>`}`,
          { head: html`<h2>What this machine measures</h2>`, extra: "machine-gaps" },
        );

  const response = page({
    ctx,
    title: "Boards",
    body: html`<div class="page-head"><h1>Data</h1>${btn("All boards", { href: "/boards", variant: "ghost" })}</div>
      ${form} ${absent} ${card(result, { head: html`<h2>${p.source}</h2>` })} ${pin} ${sources}`,
  });
  notePhase(ctx.request, "render", Math.max(0, performance.now() - rendering - boardsMs));
  return response;
}
