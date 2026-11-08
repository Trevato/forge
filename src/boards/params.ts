/**
 * A data query as the URL says it (#9440): `readParams` reads the GET params
 * into plain, bounded strings, and `toQuery` turns them into the `Query` that
 * `runQuery` judges. The page at `/boards/data`, its panels and the terminal's
 * data explorer share these, so the web and the terminal read a link alike.
 */
import { CHARTS, type Chart } from "./chart.ts";
import { defaultsFor } from "./guide.ts";
import type { Query } from "./query.ts";
import { SOURCES } from "./sources.ts";

export const BUCKET_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;
export const MAX_PARAM = 256;

export type Bucket = keyof typeof BUCKET_MS;
export const isBucket = (s: string): s is Bucket => Object.hasOwn(BUCKET_MS, s);
const isChart = (s: string): s is Chart => (CHARTS as readonly string[]).includes(s);

/** What the URL asks for: plain strings, bounded; `runQuery` judges them. */
export function readParams(search: URLSearchParams) {
  const get = (k: string, d = "") => (search.get(k) ?? d).slice(0, MAX_PARAM);
  const chart = get("chart", "line");
  const source = get("source", "runs");
  // A link that names no aggregate is a source's front door: its own default chart.
  const d = search.has("aggregate") ? null : defaultsFor(source);
  const filtered = d !== null && !search.has("fcolumn");
  return {
    chart: isChart(chart) ? chart : "line",
    source,
    aggregate: d?.aggregate ?? get("aggregate", "count"),
    column: d && !search.has("column") ? d.column : get("column"),
    by: get("by", d?.by ?? "day"),
    series: get("series"),
    from: get("from"),
    to: get("to"),
    fcolumn: filtered ? d.fcolumn : get("fcolumn"),
    fop: filtered ? d.fop : get("fop", "eq"),
    fvalue: filtered ? d.fvalue : get("fvalue"),
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
