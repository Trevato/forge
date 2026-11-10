/**
 * A SQLite file committed to a repository, read-only: each table and view
 * with its columns and row count, and `?table=<name>` for the first rows of
 * one. The blob is opened in memory (`Database.deserialize`), never written
 * anywhere, and closed before this returns. There is no SQL from the reader:
 * a table name is only ever one read back from `sqlite_master`.
 */

import { Database } from "bun:sqlite";
import { escapeHtml, html, raw } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

/** Rows drawn for one table, tables listed, columns and characters per cell drawn. */
export const ROW_LIMIT = 100;
export const TABLE_CAP = 200;
export const COLUMN_CAP = 100;
export const CELL_CHARS = 300;

interface Entry {
  readonly name: string;
  readonly type: "table" | "view";
  readonly rows: number | undefined;
  readonly columns: readonly string[];
  /** Why this table could not be read, shown in its place. */
  readonly note?: string;
}

const plural = (n: number, one: string): string => `${n.toLocaleString()} ${one}${n === 1 ? "" : "s"}`;

/** True when `name` is a table or view of this database (cheap; used before a page is kept). */
export function hasTable(body: Uint8Array, name: string): boolean {
  let db: Database | undefined;
  try {
    db = Database.deserialize(body, { readonly: true });
    return db.query("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ? AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").get(name) !== null;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** One cell as text: NULL and a BLOB's size are words, a long value is cut. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return `<td class="muted">NULL</td>`;
  if (v instanceof Uint8Array) return `<td class="muted num">BLOB · ${fileSize(v.length)}</td>`;
  const s = String(v);
  const cut = s.length > CELL_CHARS ? `${s.slice(0, CELL_CHARS)}…` : s;
  return `<td${typeof v === "number" || typeof v === "bigint" ? ' class="num"' : ""}>${escapeHtml(cut)}</td>`;
}

function entries(db: Database): Entry[] {
  const found = db
    .query(
      `SELECT name, type FROM sqlite_master
       WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       ORDER BY name LIMIT ${TABLE_CAP}`,
    )
    .all() as { name: string; type: "table" | "view" }[];
  return found.map(({ name, type }) => {
    let columns: string[] = [];
    let rows: number | undefined;
    try {
      columns = (db.query("SELECT name FROM pragma_table_info(?)").all(name) as { name: string }[]).map((c) => c.name);
      // A view is a stored query of unknown cost, so it is never counted.
      if (type === "table") rows = (db.query(`SELECT count(*) AS n FROM ${quote(name)}`).get() as { n: number }).n;
    } catch {
      return { name, type, rows: undefined, columns, note: "could not be read" };
    }
    return { name, type, rows, columns };
  });
}

function rowsOf(db: Database, entry: Entry): string {
  const width = Math.min(entry.columns.length, COLUMN_CAP);
  const data = db.query(`SELECT * FROM ${quote(entry.name)} LIMIT ${ROW_LIMIT}`).values() as unknown[][];
  const head = entry.columns.slice(0, width).map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const body = data.map((r) => `<tr>${r.slice(0, width).map(cell).join("")}</tr>`).join("");
  return `<table class="table" data-dense aria-label="${escapeHtml(entry.name)} rows"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function sqlite(input: RenderInput): Rendered {
  let db: Database | undefined;
  try {
    db = Database.deserialize(input.body, { readonly: true });
    const list = entries(db);
    const href = input.pathHref ?? "";
    const wanted = input.table;
    const chosen = wanted === undefined ? undefined : list.find((e) => e.name === wanted);
    const notice =
      wanted !== undefined && chosen === undefined
        ? `<p class="muted small">This database has no table named “${escapeHtml(wanted.slice(0, 100))}”.</p>`
        : "";
    const tables = list.filter((e) => e.type === "table").length;
    const summary = `${plural(tables, "table")} · ${plural(list.length - tables, "view")} · ${fileSize(input.size)}`;

    const items = list
      .map((e) => {
        const cols = e.columns.slice(0, COLUMN_CAP).join(", ");
        const count = e.note !== undefined ? e.note : e.rows === undefined ? "" : plural(e.rows, "row");
        return `<tr><td><a href="${escapeHtml(href)}?table=${encodeURIComponent(e.name)}">${escapeHtml(e.name)}</a></td><td class="muted">${e.type}</td><td class="num${e.note !== undefined ? " muted" : ""}">${escapeHtml(count)}</td><td class="muted small">${escapeHtml(cols)}</td></tr>`;
      })
      .join("");
    const listing = `<div class="csv-scroll"><table class="table" data-dense aria-label="Tables and views"><thead><tr><th>Name</th><th>Kind</th><th class="num">Rows</th><th>Columns</th></tr></thead><tbody>${items}</tbody></table></div>`;
    const empty = list.length === 0 ? `<p class="muted small">This database has no tables.</p>` : "";
    const more = list.length >= TABLE_CAP ? `<p class="muted small">Showing the first ${TABLE_CAP} tables and views.</p>` : "";

    let content: string;
    if (chosen !== undefined) {
      const total = chosen.rows === undefined ? "" : ` of ${chosen.rows.toLocaleString()}`;
      if (chosen.note !== undefined) return { content: html`<div class="sqlite-view"><p class="small"><a href="${href}">← All tables</a> · <strong>${chosen.name}</strong> <span class="muted">${chosen.note}</span></p></div>`, lines: 0, summary };
      content = `<p class="small"><a href="${escapeHtml(href)}">← All tables</a> · <strong>${escapeHtml(chosen.name)}</strong> <span class="muted">first ${Math.min(ROW_LIMIT, chosen.rows ?? ROW_LIMIT).toLocaleString()}${total} rows</span></p><div class="csv-scroll">${rowsOf(db, chosen)}</div>`;
    } else {
      content = `${notice}${listing}${empty}${more}`;
    }
    return { content: html`<div class="sqlite-view">${raw(content)}</div>`, lines: 0, summary };
  } catch {
    return { content: html``, lines: 0, fallback: "This SQLite file is cut short or damaged, so its tables cannot be read." };
  } finally {
    db?.close();
  }
}
