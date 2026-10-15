/**
 * A typed board query: validated into a plain result or a refusal, then run
 * as parameterised SQL. Identifiers come only from the registry in
 * `sources.ts`; every value travels as a bound parameter.
 */
import type { Database } from "bun:sqlite";
import { SOURCES, type ColumnType } from "./sources.ts";

const OPS = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;
const BUCKETS = {
  minute: "%Y-%m-%dT%H:%M:00Z",
  hour: "%Y-%m-%dT%H:00:00Z",
  day: "%Y-%m-%dT00:00:00Z",
} as const;
const AGGREGATES = ["count", "sum", "avg", "max"] as const;
const MAX_ROWS = 1000;
const MAX_FILTERS = 16;
const MAX_REPOS = 1000;

type Op = keyof typeof OPS;
type Bucket = keyof typeof BUCKETS;
type Aggregate = (typeof AGGREGATES)[number];

export type Query = {
  source: string;
  from?: string;
  to?: string;
  filter?: { column: string; op: string; value: string | number }[];
  groupBy?: string | { bucket: string };
  aggregate: string;
  column?: string;
  /** A second grouping column: each group is split into one row per value (stacked area, heat strip). */
  series?: string;
};

/** Whose rows the asker may see: these repos, or every repo (an admin). */
export type Scope = { repoIds: readonly string[] | "all" };

export type Row = { group: string | number | null; value: number | null; series?: string | number | null };
export type Refusal = { ok: false; error: string };
export type Answer = { ok: true; rows: Row[] } | Refusal;

const refuse = (error: string): Refusal => ({ ok: false, error });
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const ident = (name: string) => `"${name}"`;

function valueFits(type: ColumnType, v: unknown): boolean {
  if (type === "number") return typeof v === "number" && Number.isFinite(v);
  return typeof v === "string" && v.length <= 256;
}

/** Validate then run `q` against `db`, over the rows `scope` allows. Never throws on bad input. */
export function runQuery(db: Database, q: unknown, scope: Scope): Answer {
  const ids = scope?.repoIds;
  if (ids !== "all") {
    if (!Array.isArray(ids) || ids.length > MAX_REPOS || ids.some((i) => typeof i !== "string")) {
      return refuse("scope must list repos or be all");
    }
    if (ids.length === 0) return { ok: true, rows: [] };
  }
  if (typeof q !== "object" || q === null || Array.isArray(q)) return refuse("query must be an object");
  const query = q as Record<string, unknown>;

  if (typeof query.source !== "string" || !has(SOURCES, query.source)) {
    return refuse(`unknown source: ${JSON.stringify(query.source)}`);
  }
  const src = SOURCES[query.source]!;
  const cols = src.columns;
  const where: string[] = src.where ? [src.where] : [];
  const params: (string | number)[] = [];
  if (ids !== "all" && src.owner === "admin") return { ok: true, rows: [] };
  if (ids !== "all") {
    const marks = ids.map(() => "?").join(",");
    where.push(
      src.owner === "repo_id"
        ? `"repo_id" IN (${marks})`
        : `"issue_id" IN (SELECT id FROM issue WHERE repo_id IN (${marks}))`,
    );
    params.push(...ids);
  }

  for (const [key, op] of [["from", ">="], ["to", "<"]] as const) {
    const v = query[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || Number.isNaN(Date.parse(v))) return refuse(`${key} must be a date string`);
    params.push(new Date(v).toISOString());
    where.push(`${ident(src.time)} ${op} ?`);
  }

  const filters = query.filter ?? [];
  if (!Array.isArray(filters) || filters.length > MAX_FILTERS) return refuse("filter must be a short list");
  for (const f of filters) {
    if (typeof f !== "object" || f === null) return refuse("filter entry must be an object");
    const { column, op, value } = f as Record<string, unknown>;
    if (typeof column !== "string" || !has(cols, column)) return refuse(`unknown column: ${JSON.stringify(column)}`);
    if (typeof op !== "string" || !has(OPS, op)) return refuse(`unknown op: ${JSON.stringify(op)}`);
    if (!valueFits(cols[column]!, value)) return refuse(`bad value for column ${column}`);
    params.push(value as string | number);
    where.push(`${ident(column)} ${OPS[op as Op]} ?`);
  }

  const agg = query.aggregate;
  if (typeof agg !== "string" || !(AGGREGATES as readonly string[]).includes(agg)) {
    return refuse(`unknown aggregate: ${JSON.stringify(agg)}`);
  }
  let valueSql = "COUNT(*)";
  if ((agg as Aggregate) !== "count") {
    const c = query.column;
    if (typeof c !== "string" || !has(cols, c)) return refuse(`unknown column: ${JSON.stringify(c)}`);
    if (cols[c] !== "number") return refuse(`column ${c} is not numeric`);
    valueSql = `${agg.toUpperCase()}(${ident(c)})`;
  }

  let groupSql = "NULL";
  let groupParam: string | undefined;
  const g = query.groupBy;
  if (typeof g === "string") {
    if (!has(cols, g)) return refuse(`unknown column: ${JSON.stringify(g)}`);
    groupSql = ident(g);
  } else if (g !== undefined) {
    const b = typeof g === "object" && g !== null ? (g as Record<string, unknown>).bucket : undefined;
    if (typeof b !== "string" || !has(BUCKETS, b)) return refuse(`unknown bucket: ${JSON.stringify(b)}`);
    groupSql = `strftime(?, ${ident(src.time)})`;
    groupParam = BUCKETS[b as Bucket];
  }

  let seriesSql = "";
  const s = query.series;
  if (s !== undefined) {
    if (typeof s !== "string" || !has(cols, s)) return refuse(`unknown column: ${JSON.stringify(s)}`);
    seriesSql = `, ${ident(s)} AS "series"`;
  }
  const grouped = [groupSql === "NULL" ? "" : "1", seriesSql === "" ? "" : "3"].filter(Boolean).join(", ");

  const sql =
    `SELECT ${groupSql} AS "group", ${valueSql} AS "value"${seriesSql} FROM ${ident(src.table)}` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    (grouped === "" ? "" : ` GROUP BY ${grouped} ORDER BY ${grouped}`) +
    ` LIMIT ${MAX_ROWS}`;
  const bound = groupParam === undefined ? params : [groupParam, ...params];
  return { ok: true, rows: db.query(sql).all(...bound) as Row[] };
}
