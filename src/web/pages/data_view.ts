/**
 * The data browser's body, shared by its three doors: `/data` (every file the
 * viewer may see), `/admin/data` (the forge's own) and `/:owner/:name/data`
 * (one app's, environment by environment). A door picks the sources and the
 * address; this draws files → tables → rows (sort, one-column filter, JSON
 * cells, copy row as JSON) and the read-only SQL box. Everything is a GET, so
 * every view, SQL included, is an address that can be shared.
 */

import { PAGE_SIZE, rows, tables, type RowsResult } from "../../data/browse.ts";
import { query } from "../../data/query.ts";
import type { Source } from "../../data/sources.ts";
import { html, type Html } from "../html.ts";
import { btn, empty, field, iconBtn, pager, row } from "../ui.ts";

/** Longest SQL an address may carry. */
export const SQL_MAX = 4000;

type Cell = string | number | null;

export interface DataView {
  /** The path every link points at, without a query. */
  readonly path: string;
  readonly sources: readonly Source[];
  /** Group file rows under their environment (an app's own tab). */
  readonly byEnv?: boolean;
  /** Asked before a SQL run: seconds to wait when this person has run too many, else undefined. */
  readonly sqlWait?: () => number | undefined;
}

const url = (path: string, params: Record<string, string | number | undefined>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s === "" ? path : `${path}?${s}`;
};

/** A cell: JSON text pretty-printed, null left empty, anything else as text. */
export function cellView(v: Cell): Html {
  if (v === null) return html``;
  const text = String(v);
  if (typeof v === "string" && (text.startsWith("{") || text.startsWith("["))) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null)
        return html`<pre class="mono">${JSON.stringify(parsed, null, 2)}</pre>`;
    } catch {
      // not JSON after all: plain text below
    }
  }
  return html`${text}`;
}

const asObject = (columns: readonly string[], r: readonly Cell[]): Record<string, Cell> =>
  Object.fromEntries(columns.map((c, i): [string, Cell] => [c, r[i] ?? null]));

function grid(
  columns: readonly string[],
  data: readonly (readonly Cell[])[],
  caption: string,
  head: (c: string) => Html,
  copyIds: boolean,
): Html {
  return html`<div class="table-scroll">
    <table class="table" data-dense data-sortable>
      <caption class="sr-only">${caption}</caption>
      <thead><tr>${copyIds ? html`<th scope="col"><span class="sr-only">Copy</span></th>` : null}${columns.map(head)}</tr></thead>
      <tbody>
        ${data.map(
          (r, i) => html`<tr>
            ${copyIds
              ? html`<td>${iconBtn("copy", "Copy row as JSON", { copy: `row-${i}`, size: "sm" })}<pre id="row-${i}" hidden>${JSON.stringify(asObject(columns, r), null, 2)}</pre></td>`
              : null}
            ${r.map((v) => html`<td>${cellView(v)}</td>`)}
          </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

const intOr0 = (s: string | null): number => {
  const n = Number(s ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

/** The body for these sources and this query string, or `undefined` for a 404. */
export async function dataBody(view: DataView, q: URLSearchParams): Promise<Html | undefined> {
  const { path, sources } = view;
  const chosen = q.get("source") ?? (sources.length === 1 ? sources[0]!.id : null);
  const source = chosen === null ? undefined : sources.find((s) => s.id === chosen);
  if (chosen !== null && !source) return undefined;

  const fileRow = (s: Source) =>
    row({ href: url(path, { source: s.id }), title: view.byEnv ? (s.id.split(":").slice(3).join(":") || s.label) : s.label, current: s.id === source?.id });
  const envOf = (s: Source) => s.id.split(":")[2] ?? "";
  const files =
    sources.length === 0
      ? empty({
          title: "No database yet",
          note: "An app's SQLite files appear here once it has written one under its data directory.",
        })
      : view.byEnv
        ? html`${[...new Set(sources.map(envOf))].map(
            (env) => html`<h2>${env}</h2><ul class="list">${sources.filter((s) => envOf(s) === env).map(fileRow)}</ul>`,
          )}`
        : sources.length === 1 && source
          ? html``
          : html`<ul class="list">${sources.map(fileRow)}</ul>`;
  if (!source) return files;

  const tableName = q.get("table");
  const sql = (q.get("sql") ?? "").slice(0, SQL_MAX);
  const list = tables(source);
  let out = html`${files}
    <h2>${source.label}</h2>
    <ul class="list">
      ${list.map((t) =>
        row({
          href: url(path, { source: source.id, table: t.name }),
          title: t.name,
          trail: html`${String(t.rows)} rows`,
          current: t.name === tableName,
        }),
      )}
    </ul>`;

  if (tableName !== null) {
    const sort = q.get("sort") ?? undefined;
    const dir = q.get("dir") === "desc" ? "desc" : "asc";
    const text = (q.get("q") ?? "").slice(0, 200);
    const col = q.get("col") || undefined;
    const pageNo = intOr0(q.get("page"));
    const base = { source: source.id, table: tableName, sort, dir: sort ? dir : undefined, q: text, col };
    let shown: RowsResult | undefined = rows(source, tableName, {
      page: pageNo,
      ...(sort ? { order: { column: sort, dir } } : {}),
      ...(text !== "" ? { filter: { text, ...(col ? { column: col } : {}) } } : {}),
    });
    let note: string | null = null;
    if (!shown && (sort || text !== "")) {
      // An unknown or sealed column cannot be sorted or searched: show the table, say so.
      shown = rows(source, tableName, { page: pageNo });
      note = "That column cannot be sorted or searched here.";
    }
    if (!shown) return undefined;
    const cols = shown.columns;
    const more = (shown.page + 1) * PAGE_SIZE < shown.total;
    const header = (c: string): Html => {
      const next = sort === c && dir === "asc" ? "desc" : "asc";
      return html`<th scope="col" ${sort === c ? html`aria-sort="${dir === "asc" ? "ascending" : "descending"}"` : null}><a href="${url(path, { ...base, sort: c, dir: next })}">${c}</a></th>`;
    };
    out = html`${out}
      <h2>${tableName}</h2>
      <form method="get" action="${path}" role="search">
        <input type="hidden" name="source" value="${source.id}" />
        <input type="hidden" name="table" value="${tableName}" />
        ${sort ? html`<input type="hidden" name="sort" value="${sort}" /><input type="hidden" name="dir" value="${dir}" />` : null}
        ${field({
          name: "q",
          value: text,
          label: "Filter",
          labelHidden: true,
          placeholder: "Filter rows",
          type: "search",
        })}
        ${field({
          name: "col",
          type: "select",
          label: "Column",
          labelHidden: true,
          options: [{ value: "", label: "Any column" }, ...cols.map((c) => ({ value: c, label: c, selected: c === col }))],
        })}
        <div class="form-actions">
          ${btn("Filter", { size: "sm", type: "submit" })}
          ${text !== "" ? btn("Clear", { href: url(path, { source: source.id, table: tableName, sort, dir: sort ? dir : undefined }), size: "sm", variant: "outline" }) : null}
        </div>
      </form>
      ${note ? html`<p class="muted small">${note}</p>` : null}
      ${shown.rows.length === 0 ? empty({ title: "No rows", note: text !== "" ? "Nothing matches that filter." : "This table is empty." }) : grid(cols, shown.rows, `${tableName} in ${source.label}`, header, true)}
      ${pager({
        note: `${shown.total} rows`,
        words: { prev: "Previous page", next: "Next page" },
        ...(shown.page > 0 ? { prev: url(path, { ...base, page: shown.page - 1 }) } : {}),
        ...(more ? { next: url(path, { ...base, page: shown.page + 1 }) } : {}),
      })}`;
  }

  out = html`${out}
    <form method="get" action="${path}">
      <input type="hidden" name="source" value="${source.id}" />
      ${field({
        name: "sql",
        type: "textarea",
        value: sql,
        mono: true,
        rows: 4,
        placeholder: "SELECT * FROM … (read-only, one statement)",
        spellcheck: false,
        maxlength: SQL_MAX,
        label: "SQL",
      })}
      <div class="form-actions">${btn("Run", { size: "sm", type: "submit" })}</div>
    </form>`;
  if (sql.trim() !== "") {
    const wait = view.sqlWait?.();
    if (wait !== undefined) return html`${out}<p role="alert" class="muted">Too many queries; try again in ${String(wait)} s.</p>`;
    const t0 = performance.now();
    const result = await query(source, sql);
    const ms = Math.max(1, Math.round(performance.now() - t0));
    out = result.ok
      ? html`${out}
          <p class="muted small">${String(result.rows.length)} rows${result.truncated ? " (cut)" : ""} · ${String(ms)} ms</p>
          ${result.rows.length === 0 ? empty({ title: "No rows" }) : grid(result.columns, result.rows, "Query result", (c) => html`<th scope="col">${c}</th>`, false)}`
      : html`${out}<p role="alert" class="muted">${result.message} · ${String(ms)} ms</p>`;
  }
  return out;
}
