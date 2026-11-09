/**
 * `/data` in the terminal: the SQLite files the viewer may see, a file's
 * tables, a table's rows 50 a page, secrets masked. The same reads, and the
 * same gate (`maySeeData`, `listSources`), as the web page and MCP `data`.
 * `s` sorts a table by a column (`-name` for descending), `f` filters it
 * (`text`, or `column=text`), `c` clears both; `x` on a file's tables runs one
 * read-only SELECT, on the page's per-person budget (`sqlWindow`).
 */

import { PAGE_SIZE, rows, tables, type RowsOptions } from "../../data/browse.ts";
import { query } from "../../data/query.ts";
import { listSources, maySeeData, type Source } from "../../data/sources.ts";
import { sqlWindow } from "../../data/sql_window.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { later, promptScreen } from "./common.ts";

/** A list of rows to move through; `open` is what Enter does on one. */
function listScreen(
  ctx: Ctx,
  title: string,
  intro: string,
  items: () => readonly string[],
  open: (index: number) => void,
  extra?: (key: string) => boolean,
  keys: ReturnType<typeof binding>[] = [],
): Screen {
  let at = 0;
  return {
    title,
    keys: [binding(["j", "k"], "move"), binding(["enter"], "open"), ...keys, binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      s.text(area.x + 1, area.y, truncate(intro, area.w - 2), style(c.mutedFg, c.bg), area.x + area.w);
      const list = items();
      if (list.length === 0) s.text(area.x + 1, area.y + 2, "Nothing here yet.", style(c.mutedFg, c.bg), area.x + area.w);
      const h = Math.max(1, area.h - 2);
      const from = Math.max(0, Math.min(at - h + 1, list.length - h));
      list.slice(from, from + h).forEach((line, i) => {
        const on = from + i === at;
        s.text(area.x + 1, area.y + 2 + i, truncate(`${on ? "> " : "  "}${line}`, area.w - 2), on ? style(c.accent, c.bg) : style(c.fg, c.bg), area.x + area.w);
      });
    },
    key(e) {
      if (e.ctrl || e.alt) return false;
      const n = items().length;
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "j" || e.key === "down") at = Math.min(Math.max(0, n - 1), at + 1);
      else if (e.key === "k" || e.key === "up") at = Math.max(0, at - 1);
      else if (e.key === "enter") {
        if (n > 0) open(at);
      } else return extra?.(e.key) ?? false;
      return true;
    },
  };
}

const cellText = (v: string | number | null): string => (v === null ? "" : String(v).replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, " "));

/** Splits `-name` / `name` into a sort; `undefined` for nothing. */
const parseSort = (text: string): RowsOptions["order"] | undefined => {
  const t = text.trim();
  if (t === "") return undefined;
  return t.startsWith("-") ? { column: t.slice(1), dir: "desc" } : { column: t, dir: "asc" };
};

/** `text` or `column=text`; an empty string is no filter. */
const parseFilter = (text: string, columns: readonly string[]): RowsOptions["filter"] | undefined => {
  const eq = text.indexOf("=");
  const head = eq > 0 ? text.slice(0, eq).trim() : "";
  if (head !== "" && columns.includes(head)) return { column: head, text: text.slice(eq + 1) };
  return text === "" ? undefined : { text };
};

function rowsScreen(ctx: Ctx, source: Source, table: string): Screen {
  let page = 0;
  let order: RowsOptions["order"] | undefined;
  let filter: RowsOptions["filter"] | undefined;
  let note = "";
  const read = () => {
    const wanted = { page, ...(order ? { order } : {}), ...(filter ? { filter } : {}) };
    const r = rows(source, table, wanted);
    if (r || (!order && !filter)) return r;
    // An unknown or sealed column cannot be sorted or searched: show the table, say so.
    note = " · that column cannot be sorted or searched";
    return rows(source, table, { page });
  };
  const screen: Screen = listScreen(
    ctx,
    `${table} · ${source.label}`,
    "",
    () => {
      note = "";
      const r = read();
      if (!r) return [];
      const how = `${order ? ` · by ${order.column} ${order.dir}` : ""}${filter ? ` · filter ${filter.column ? `${filter.column}=` : ""}${filter.text}` : ""}`;
      return [
        `${r.total} rows, page ${r.page + 1}${how}${note} · ${r.columns.join(" | ")}`,
        ...r.rows.map((row) => row.map(cellText).join(" | ")),
      ];
    },
    () => undefined,
    (key) => {
      const r = read();
      if (!r) return false;
      if (key === "n" && (r.page + 1) * PAGE_SIZE < r.total) page = r.page + 1;
      else if (key === "p" && r.page > 0) page = r.page - 1;
      else if (key === "c") {
        order = undefined;
        filter = undefined;
        page = 0;
      } else if (key === "s" || key === "f") {
        const sorting = key === "s";
        ctx.push(
          promptScreen(ctx, screen, {
            title: sorting ? "Sort by" : "Filter",
            label: sorting ? "Column" : "Text",
            placeholder: sorting ? "name, or -name for descending" : "text, or column=text",
            onSubmit: (v) => {
              if (sorting) order = parseSort(v);
              else filter = parseFilter(v.trim().slice(0, 200), r.columns);
              page = 0;
              return undefined;
            },
          }),
        );
      } else return false;
      return true;
    },
    [binding(["n", "p"], "next / previous page"), binding(["s", "f", "c"], "sort / filter / clear")],
  );
  return screen;
}

/** One SELECT's rows as lines, or the reason it was refused. */
async function sqlLines(source: Source, sql: string): Promise<string[]> {
  const t0 = performance.now();
  const r = await query(source, sql);
  const ms = Math.max(1, Math.round(performance.now() - t0));
  if (!r.ok) return [`${r.message} · ${ms} ms`];
  return [
    `${r.rows.length} rows${r.truncated ? " (cut)" : ""} · ${ms} ms · ${r.columns.join(" | ")}`,
    ...r.rows.map((row) => row.map(cellText).join(" | ")),
  ];
}

function tablesScreen(ctx: Ctx, session: Session, source: Source): Screen {
  const list = tables(source);
  const screen: Screen = listScreen(
    ctx,
    source.label,
    "Tables; secrets are masked.",
    () => list.map((t) => `${t.name}  ${t.rows} rows`),
    (i) => {
      const t = list[i];
      if (t) ctx.push(rowsScreen(ctx, source, t.name));
    },
    (key) => {
      if (key !== "x") return false;
      ctx.push(
        promptScreen(ctx, screen, {
          title: "SQL",
          label: "SELECT",
          placeholder: "SELECT * FROM … (read-only, one statement)",
          onSubmit: (sql) => {
            const text = sql.trim().slice(0, 4000);
            if (text === "") return "Type one SELECT.";
            const wait = session.user ? sqlWindow(session.app, session.user.id) : 1;
            if (wait !== undefined) return `Too many queries; try again in ${wait} s.`;
            return sqlLines(source, text).then((lines) => {
              void later(ctx, () => listScreen(ctx, "SQL", "", () => lines, () => undefined));
            });
          },
        }),
      );
      return true;
    },
    [binding(["x"], "run SQL")],
  );
  return screen;
}

export function dataScreen(session: Session, ctx: Ctx): Screen {
  const sources = () => listSources(session.app.db, session.app.config.dataDir, session.user);
  return listScreen(
    ctx,
    "Data",
    "The SQLite files you may read.",
    () => sources().map((s) => s.label),
    (i) => {
      const s = sources()[i];
      if (s) ctx.push(tablesScreen(ctx, session, s));
    },
  );
}

/** Offered to an admin and to an app's writers; a reader and a guest see nothing. */
export const dataCommand = (session: Session, ctx: Ctx) =>
  maySeeData(session.app.db, session.user)
    ? [
        {
          id: "data",
          title: "Data",
          hint: "the SQLite files you may read, secrets masked",
          run: () => ctx.push(dataScreen(session, ctx)),
        },
      ]
    : [];
