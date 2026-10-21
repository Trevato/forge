/**
 * A typed board query: validated into a plain result or a refusal, then run
 * as parameterised SQL. Identifiers come only from the registry in
 * `sources.ts`; every value travels as a bound parameter.
 */
import type { Database } from "bun:sqlite";
import { SOURCES, type ColumnType } from "./sources.ts";

/** `starts` is a prefix match on a text or time column (`target` starts `cpu:`); the rest compare. */
const OPS = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=", starts: null } as const;
/** A bucket's width in seconds; a query's `step` replaces it. */
export const BUCKETS = { minute: 60, hour: 3600, day: 86_400 } as const;
const AGGREGATES = ["count", "sum", "avg", "max"] as const;
const MAX_ROWS = 1000;
/**
 * A query grouped by time is never cut short: past this many rows it is
 * refused (`tooMany`), so the caller asks again at a coarser step.
 */
export const MAX_POINTS = 20_000;
/** The widest step, in seconds: a year. */
export const MAX_STEP = 31_536_000;
const MAX_FILTERS = 16;
const MAX_REPOS = 1000;

type Op = keyof typeof OPS;
export type Bucket = keyof typeof BUCKETS;
type Aggregate = (typeof AGGREGATES)[number];

export type Query = {
  source: string;
  from?: string;
  to?: string;
  filter?: { column: string; op: string; value: string | number }[];
  groupBy?: string | { bucket: string };
  /** Seconds per time bucket, in place of the bucket's own width; only with a `{bucket}` group. */
  step?: number;
  aggregate: string;
  column?: string;
  /** A second grouping column: each group is split into one row per value (stacked area, heat strip). */
  series?: string;
};

/** Whose rows the asker may see: these repos, or every repo (an admin). */
export type Scope = { repoIds: readonly string[] | "all" };

export type Row = { group: string | number | null; value: number | null; series?: string | number | null };
/** `tooMany`: a time-grouped answer has more rows than `MAX_POINTS`; a coarser step may fit. */
export type Refusal = { ok: false; error: string; tooMany?: true };
export type Answer = { ok: true; rows: Row[] } | Refusal;

const refuse = (error: string): Refusal => ({ ok: false, error });
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const ident = (name: string) => `"${name}"`;

function valueFits(type: ColumnType, v: unknown): boolean {
  if (type === "number") return typeof v === "number" && Number.isFinite(v);
  return typeof v === "string" && v.length <= 256;
}

type Source = (typeof SOURCES)[string];
/** The rows `q` reads before grouping: its source, and the WHERE its scope, window and filters make. */
type Rows = { query: Record<string, unknown>; src: Source; from: string; where: string[]; params: (string | number)[] };

/** Validate `q`'s source, scope, window and filters; the rows they name, nothing (`empty`) or a refusal. */
function rowsOf(q: unknown, scope: Scope): Rows | Refusal | "empty" {
  const ids = scope?.repoIds;
  if (ids !== "all") {
    if (!Array.isArray(ids) || ids.length > MAX_REPOS || ids.some((i) => typeof i !== "string")) {
      return refuse("scope must list repos or be all");
    }
    if (ids.length === 0) return "empty";
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
  if (ids !== "all" && src.owner === "admin") return "empty";
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
    const sqlOp = OPS[op as Op];
    if (sqlOp === null && cols[column] === "number") return refuse(`column ${column} is numeric: starts needs text`);
    params.push(value as string | number);
    // instr(), not LIKE: a % or _ in the value is a character, never a wildcard.
    where.push(sqlOp === null ? `instr(${ident(column)}, ?) = 1` : `${ident(column)} ${sqlOp} ?`);
  }
  const from = src.select === undefined ? ident(src.table) : `(${src.select}) AS ${ident(src.table)}`;
  return { query, src, from, where, params };
}

const whereSql = (where: readonly string[]) => (where.length ? ` WHERE ${where.join(" AND ")}` : "");

/**
 * The oldest time among the rows `q` reads, as stored, or null when there
 * are none (or `q` is refused): what a window with no start spans from.
 */
export function oldestTime(db: Database, q: unknown, scope: Scope): string | null {
  const r = rowsOf(q, scope);
  if (r === "empty" || !("src" in r)) return null;
  const row = db.query(`SELECT MIN(${ident(r.src.time)}) AS "at" FROM ${r.from}${whereSql(r.where)}`).get(...r.params) as
    | { at: string | null }
    | null;
  return row?.at ?? null;
}

/** Validate then run `q` against `db`, over the rows `scope` allows. Never throws on bad input. */
export function runQuery(db: Database, q: unknown, scope: Scope): Answer {
  const r = rowsOf(q, scope);
  if (r === "empty") return { ok: true, rows: [] };
  if (!("src" in r)) return r;
  const { query, src, from, where, params } = r;
  const cols = src.columns;

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
  let step: number | undefined;
  const g = query.groupBy;
  if (typeof g === "string") {
    if (!has(cols, g)) return refuse(`unknown column: ${JSON.stringify(g)}`);
    groupSql = ident(g);
  } else if (g !== undefined) {
    const b = typeof g === "object" && g !== null ? (g as Record<string, unknown>).bucket : undefined;
    if (typeof b !== "string" || !has(BUCKETS, b)) return refuse(`unknown bucket: ${JSON.stringify(b)}`);
    step = BUCKETS[b as Bucket];
    // The bucket's start: its time in whole seconds, floored to the step, in UTC.
    groupSql = `strftime('%Y-%m-%dT%H:%M:%SZ', CAST(strftime('%s', ${ident(src.time)}) AS INTEGER) / ? * ?, 'unixepoch')`;
  }
  if (query.step !== undefined) {
    const n = query.step;
    if (step === undefined) return refuse("step needs a group by a time bucket");
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_STEP) {
      return refuse(`step must be a whole number of seconds, 1 to ${MAX_STEP}`);
    }
    step = n;
  }

  let seriesSql = "";
  const s = query.series;
  if (s !== undefined) {
    if (typeof s !== "string" || !has(cols, s)) return refuse(`unknown column: ${JSON.stringify(s)}`);
    seriesSql = `, ${ident(s)} AS "series"`;
  }
  const grouped = [groupSql === "NULL" ? "" : "1", seriesSql === "" ? "" : "3"].filter(Boolean).join(", ");

  const sql =
    `SELECT ${groupSql} AS "group", ${valueSql} AS "value"${seriesSql} FROM ${from}` +
    whereSql(where) +
    (grouped === "" ? "" : ` GROUP BY ${grouped} ORDER BY ${grouped}`) +
    ` LIMIT ${step === undefined ? MAX_ROWS : MAX_POINTS + 1}`;
  const bound = step === undefined ? params : [step, step, ...params];
  const rows = db.query(sql).all(...bound) as Row[];
  if (step !== undefined && rows.length > MAX_POINTS) {
    return { ok: false, error: `more than ${MAX_POINTS} points: ask for a coarser step or a shorter range`, tooMany: true };
  }
  return { ok: true, rows };
}
