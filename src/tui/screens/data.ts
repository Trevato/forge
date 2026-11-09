/**
 * `/data` in the terminal: the SQLite files the viewer may see, a file's
 * tables, a table's rows 50 a page, secrets masked. The same reads, and the
 * same gate (`maySeeData`, `listSources`), as the web page and MCP `data`.
 */

import { PAGE_SIZE, rows, tables } from "../../data/browse.ts";
import { listSources, maySeeData, type Source } from "../../data/sources.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";

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

function rowsScreen(ctx: Ctx, source: Source, table: string): Screen {
  let page = 0;
  const read = () => rows(source, table, { page });
  return listScreen(
    ctx,
    `${table} · ${source.label}`,
    "",
    () => {
      const r = read();
      if (!r) return [];
      return [
        `${r.total} rows, page ${r.page + 1} · ${r.columns.join(" | ")}`,
        ...r.rows.map((row) => row.map(cellText).join(" | ")),
      ];
    },
    () => undefined,
    (key) => {
      const r = read();
      if (!r) return false;
      if (key === "n" && (r.page + 1) * PAGE_SIZE < r.total) page = r.page + 1;
      else if (key === "p" && r.page > 0) page = r.page - 1;
      else return false;
      return true;
    },
    [binding(["n", "p"], "next / previous page")],
  );
}

function tablesScreen(ctx: Ctx, source: Source): Screen {
  const list = tables(source);
  return listScreen(
    ctx,
    source.label,
    "Tables; secrets are masked.",
    () => list.map((t) => `${t.name}  ${t.rows} rows`),
    (i) => {
      const t = list[i];
      if (t) ctx.push(rowsScreen(ctx, source, t.name));
    },
  );
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
      if (s) ctx.push(tablesScreen(ctx, s));
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
