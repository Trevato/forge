/**
 * `/data` in the terminal, as a file tree: repos → apps → environments →
 * files → tables → rows, over the same reads and the same gate
 * (`maySeeData`, `listSources`) as the web page and the MCP `data` tool.
 *
 * Keys: j/k move, l or Enter opens, h closes (or goes up), `/` filters the
 * lines shown, `:` asks the file under the cursor a read-only question (the
 * same SELECT-only caps as the tool), `y` yanks a row as JSON. Secrets stay
 * masked: rows come from the masked reads.
 */

import { query, type QueryResult } from "../../data/query.ts";
import { cellLine, rowObject, type Cell } from "../../data/shape.ts";
import { listSources, maySeeData } from "../../data/sources.ts";
import { sqlWindow } from "../../data/sql_window.ts";
import { PAGE_SIZE } from "../../data/browse.ts";
import { filtered, newReads, opens, pageCount, parentKey, visible, type Node } from "../../data/tree.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { KeyEvent } from "../term/input.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";

/** The longest SQL the prompt takes, and the longest filter. */
export const SQL_MAX = 4000;
export const FILTER_MAX = 200;

/** A one-line editor: what a prompt types into, cut at `max` characters however it arrives. */
export function typing(max: number, initial = "") {
  const cap = (t: string) => [...t].slice(0, max).join("");
  let text = cap(initial);
  return {
    get text() {
      return text;
    },
    /** True when the key was text (or an edit) and is spent. */
    key(e: KeyEvent): boolean {
      if (e.ctrl || e.alt) return false;
      if (e.key === "backspace") text = [...text].slice(0, -1).join("");
      else if (e.key === "space") text = cap(text + " ");
      else if ([...e.key].length === 1) text = cap(text + e.key);
      else return false;
      return true;
    },
    paste(t: string) {
      text = cap(text + t.replace(/\s+/g, " "));
    },
  };
}

/** The lines of a SQL answer; `y` yanks the highlighted row. */
function resultScreen(ctx: Ctx, sql: string, r: Extract<QueryResult, { ok: true }>): Screen {
  let at = 0;
  return {
    title: "Result",
    keys: [binding(["j", "k"], "move"), binding("y", "yank row as JSON"), binding("esc", "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const note = `${r.rows.length} rows${r.truncated ? " (cut)" : ""} · ${sql}`;
      s.text(area.x + 1, area.y, truncate(note, area.w - 2), style(c.mutedFg, c.bg), area.x + area.w);
      s.text(area.x + 1, area.y + 1, truncate(`  ${r.columns.join(" | ")}`, area.w - 2), style(c.mutedFg, c.bg), area.x + area.w);
      const h = Math.max(1, area.h - 3);
      const from = Math.max(0, Math.min(at - h + 1, r.rows.length - h));
      r.rows.slice(from, from + h).forEach((row, i) => {
        const on = from + i === at;
        s.text(area.x + 1, area.y + 2 + i, truncate(`${on ? "> " : "  "}${row.map(cellLine).join(" | ")}`, area.w - 2), style(on ? c.accent : c.fg, c.bg), area.x + area.w);
      });
    },
    key(e) {
      if (e.ctrl || e.alt) return false;
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "j" || e.key === "down") at = Math.min(Math.max(0, r.rows.length - 1), at + 1);
      else if (e.key === "k" || e.key === "up") at = Math.max(0, at - 1);
      else if (e.key === "y") {
        const row = r.rows[at];
        if (!row) return true;
        ctx.copy(JSON.stringify(rowObject(r.columns, row as readonly Cell[])));
        ctx.toast("Row sent to your clipboard as JSON.");
      } else return false;
      return true;
    },
  };
}

export function dataScreen(session: Session, ctx: Ctx): Screen {
  const open = new Set<string>();
  let at = 0;
  let filter = "";
  let mode: "filter" | "sql" | undefined;
  let line = typing(FILTER_MAX);

  // Built once and rebuilt only when `open`, a page, the filter or a reload changes it.
  const pages = new Map<string, number>();
  let reads = newReads();
  let files: ReturnType<typeof listSources> | undefined;
  let built: Node[] | undefined;
  let shown: Node[] | undefined;
  const dirty = (all = false) => {
    shown = undefined;
    if (all) built = undefined;
  };
  const lines = (): Node[] => {
    if (shown) return shown;
    files ??= listSources(session.app.db, session.app.config.dataDir, session.user);
    built ??= visible(files, open, reads, pages);
    return (shown = filtered(built, filter));
  };
  const reload = () => {
    files = undefined;
    reads = newReads();
    dirty(true);
  };
  /** The table key a node belongs to, for paging. */
  const tableKey = (n: Node) => (n.kind === "table" ? n.key : n.kind === "row" ? parentKey(n.key) : undefined);
  function turn(n: Node | undefined, by: number) {
    const tk = n && tableKey(n);
    if (tk === undefined) return;
    const total = built?.find((x) => x.key === tk)?.total ?? 0;
    const next = Math.max(0, Math.min(pageCount(total) - 1, (pages.get(tk) ?? 0) + by));
    if (next === (pages.get(tk) ?? 0)) return ctx.toast(by > 0 ? "That is the last page." : "That is the first page.");
    pages.set(tk, next);
    dirty(true);
    at = Math.max(0, lines().findIndex((x) => x.key === tk));
  }
  const current = (): Node | undefined => lines()[at];
  const clamp = () => {
    at = Math.max(0, Math.min(at, lines().length - 1));
  };

  function ask(text: string) {
    const sql = text.trim();
    if (sql === "") return ctx.toast("Type one SELECT.", "danger");
    const source = current()?.source;
    if (!source) return ctx.toast("Move onto a file, table or row first: the question goes to that file.", "danger");
    const wait = session.user ? sqlWindow(session.app, session.user.id) : 1;
    if (wait !== undefined) return ctx.toast(`Too many queries; try again in ${wait} s.`, "danger");
    ctx.track(
      query(source, sql).then((r) => {
        if (r.ok) ctx.push(resultScreen(ctx, sql, r));
        else ctx.toast(r.message, "danger");
      }),
    );
  }

  return {
    title: "Data",
    get keys() {
      return mode
        ? [binding("enter", mode === "sql" ? "run" : "keep"), binding("esc", "cancel")]
        : [
            binding(["j", "k"], "move"),
            binding(["h", "l"], "close / open"),
            binding("/", "filter"),
            binding(":", "SQL"),
            binding("y", "yank row as JSON"),
            binding(["n", "p"], `page of ${PAGE_SIZE}`),
            binding("r", "reload"),
            binding("esc", "back"),
          ];
    },
    render(area, s) {
      const c = ctx.theme.c;
      const top = filter === "" ? "The SQLite files you may read; secrets are masked." : `Filter: ${filter}`;
      s.text(area.x + 1, area.y, truncate(top, area.w - 2), style(c.mutedFg, c.bg), area.x + area.w);
      const list = lines();
      if (list.length === 0) s.text(area.x + 1, area.y + 2, filter === "" ? "Nothing here yet." : "No open line matches.", style(c.mutedFg, c.bg), area.x + area.w);
      const h = Math.max(1, area.h - 3);
      const from = Math.max(0, Math.min(at - h + 1, list.length - h));
      list.slice(from, from + h).forEach((n, i) => {
        const on = from + i === at;
        const mark = opens(n) ? (open.has(n.key) ? "v " : "> ") : "  ";
        s.text(area.x + 1, area.y + 2 + i, truncate(`${"  ".repeat(n.depth)}${mark}${n.label}`, area.w - 2), style(on ? c.accent : c.fg, c.bg), area.x + area.w);
      });
      if (mode) {
        s.text(area.x + 1, area.y + area.h - 1, truncate(`${mode === "sql" ? ":" : "/"}${line.text}`, area.w - 2), style(c.fg, c.card), area.x + area.w);
      }
    },
    key(e) {
      if (mode) {
        if (e.key === "esc") {
          if (mode === "filter") (filter = ""), dirty();
          mode = undefined;
        } else if (e.key === "enter") {
          const done = mode;
          mode = undefined;
          if (done === "filter") {
            filter = line.text;
            dirty();
            at = 0;
          } else ask(line.text);
        } else if (!line.key(e)) return true;
        else if (mode === "filter") {
          filter = line.text;
          dirty();
          at = 0;
        }
        return true;
      }
      if (e.ctrl || e.alt) return false;
      const n = current();
      if (e.key === "esc" || e.key === "q") {
        if (filter !== "") (filter = ""), dirty();
        else ctx.pop();
      } else if (e.key === "j" || e.key === "down") at = Math.min(Math.max(0, lines().length - 1), at + 1);
      else if (e.key === "k" || e.key === "up") at = Math.max(0, at - 1);
      else if ((e.key === "l" || e.key === "right" || e.key === "enter") && n && opens(n)) (open.add(n.key), dirty(true));
      else if (e.key === "h" || e.key === "left") {
        if (n && open.has(n.key)) (open.delete(n.key), dirty(true));
        else if (n) {
          const up = parentKey(n.key);
          if (up !== undefined) {
            open.delete(up);
            dirty(true);
            at = Math.max(0, lines().findIndex((x) => x.key === up));
          }
        }
      } else if (e.key === "/") {
        mode = "filter";
        line = typing(FILTER_MAX, filter);
      } else if (e.key === ":") {
        mode = "sql";
        line = typing(SQL_MAX, n?.table ? `SELECT * FROM "${n.table.replaceAll('"', '""')}" LIMIT 20` : "");
      } else if (e.key === "n" || e.key === "p") turn(n, e.key === "n" ? 1 : -1);
      else if (e.key === "r") {
        reload();
        ctx.toast("Reloaded.");
      } else if (e.key === "y") {
        if (n?.json) {
          ctx.copy(JSON.stringify(n.json));
          ctx.toast("Row sent to your clipboard as JSON.");
        } else ctx.toast("Move onto a row to yank it.");
      } else return false;
      clamp();
      return true;
    },
    paste(text) {
      if (!mode) return false;
      line.paste(text);
      if (mode === "filter") (filter = line.text), dirty();
      return true;
    },
  };
}

/** Offered to an admin and to an app's writers; a reader and a guest see nothing. */
export const dataCommand = (session: Session, ctx: Ctx) =>
  maySeeData(session.app.db, session.user)
    ? [
        {
          id: "data",
          title: "Data",
          hint: "the SQLite files you may read as a tree; / filters, : asks in SQL, y yanks a row",
          run: () => ctx.push(dataScreen(session, ctx)),
        },
      ]
    : [];
