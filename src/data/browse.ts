/**
 * Tables and rows of one source, read on a connection opened for the call
 * and closed after it. Read-only: it takes no writer lock and a busy WAL
 * answers in milliseconds or not at all.
 */

import { Database } from "bun:sqlite";
import { cell, maskPlan, MASK } from "./mask.ts";
import type { Source } from "./sources.ts";

export const PAGE_SIZE = 50;
/** Deepest page served: a huge OFFSET is a slow scan. */
export const MAX_PAGE = 1000;

export interface TableInfo {
  readonly name: string;
  readonly rows: number;
}

export interface RowFilter {
  /** Rows where any column (or just `column`) contains `text`. */
  readonly text: string;
  readonly column?: string;
}

export interface RowsOptions {
  readonly filter?: RowFilter;
  readonly order?: { readonly column: string; readonly dir?: "asc" | "desc" };
  /** Zero-based. */
  readonly page?: number;
}

export interface RowsResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | number | null)[])[];
  readonly page: number;
  readonly total: number;
}

export function openReadOnly(path: string): Database {
  const db = new Database(path, { readonly: true });
  db.exec("PRAGMA busy_timeout = 250");
  db.exec("PRAGMA query_only = 1");
  return db;
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function withDb<T>(source: Source, fn: (db: Database) => T): T {
  const db = openReadOnly(source.path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const tableNames = (db: Database): string[] =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name);

export const tables = (source: Source): TableInfo[] =>
  withDb(source, (db) =>
    tableNames(db).map((name) => ({
      name,
      rows:
        db
          .query<{ n: number }, []>(`SELECT count(*) AS n FROM ${quote(name)}`)
          .get()?.n ?? 0,
    })),
  );

/** Rows of `table`, or `undefined` when the table does not exist. */
export function rows(
  source: Source,
  table: string,
  opts: RowsOptions = {},
): RowsResult | undefined {
  return withDb(source, (db) => {
    if (!tableNames(db).includes(table)) return undefined;
    const columns = db
      .query<{ name: string }, []>(`PRAGMA table_info(${quote(table)})`)
      .all()
      .map((c) => c.name);
    const masked = maskPlan(db, source.id).get(table) ?? new Set<string>();
    const where: string[] = [];
    const args: string[] = [];
    if (opts.filter && opts.filter.text !== "") {
      const col = opts.filter.column;
      if (col !== undefined && !columns.includes(col)) return undefined;
      // Searching a masked column would leak it a character at a time.
      const searchable = (col === undefined ? columns : [col]).filter(
        (c) => !masked.has(c),
      );
      const like = opts.filter.text.replace(/[\\%_]/g, (m) => `\\${m}`);
      where.push(
        searchable.length === 0
          ? "0"
          : searchable
              .map((c) => `CAST(${quote(c)} AS TEXT) LIKE ? ESCAPE '\\'`)
              .join(" OR "),
      );
      for (let i = 0; i < searchable.length; i++) args.push(`%${like}%`);
    }
    let order = "";
    if (opts.order) {
      if (!columns.includes(opts.order.column)) return undefined;
      if (masked.has(opts.order.column)) return undefined;
      order = ` ORDER BY ${quote(opts.order.column)} ${opts.order.dir === "desc" ? "DESC" : "ASC"}`;
    }
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const wanted = Number(opts.page ?? 0);
    const page = Number.isFinite(wanted)
      ? Math.min(MAX_PAGE, Math.max(0, Math.floor(wanted)))
      : 0;
    const total =
      db
        .query<{ n: number }, string[]>(
          `SELECT count(*) AS n FROM ${quote(table)}${clause}`,
        )
        .get(...args)?.n ?? 0;
    const raw = db
      .query<unknown[], string[]>(
        `SELECT ${columns.map(quote).join(", ")} FROM ${quote(table)}${clause}${order} LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`,
      )
      .values(...args);
    return {
      columns,
      page,
      total,
      rows: raw.map((r) =>
        r.map((v, i) =>
          masked.has(columns[i]!) && v !== null ? MASK : cell(v),
        ),
      ),
    };
  });
}
