/**
 * `/fleet` in the terminal: a query line in, the rows it selects as a
 * table, sorted by one column. The same read as the web page
 * (`fleet/rows.ts` `viewFleet`), so the grammar and who sees which row are
 * `fleet/selection.ts`'s, never this screen's; the same columns and sort
 * (`fleet/columns.ts`). Keys: `/` a new query line, `s` sort by the next
 * column, `r` reverse it, `j`/`k` scroll, `esc` back.
 */

import { cellText, COLUMNS, sortRows, type Sort } from "../../fleet/columns.ts";
import { viewFleet, type FleetView } from "../../fleet/rows.ts";
import type { FleetKind } from "../../fleet/selection.ts";
import type { FleetRow } from "../../fleet/rows.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { pad, truncate } from "../term/width.ts";
import { promptScreen, Scroll } from "./common.ts";

/** No column is padded past this, so a long title does not push the rest away. */
const CELL_MAX = 40;

/** The table as text lines: a header naming the sorted column, then one line a row. */
export function fleetLines(
  kind: FleetKind,
  rows: readonly FleetRow[],
  sort: Sort | undefined,
): string[] {
  const columns = COLUMNS[kind];
  const sorted = sortRows(rows, sort);
  const label = (key: string, text: string) =>
    sort?.key === key ? `${text} ${sort.descending ? "v" : "^"}` : text;
  const widths = columns.map((c) =>
    Math.min(
      CELL_MAX,
      Math.max(label(c.key, c.label).length, ...sorted.map((r) => cellText(c, r).length)),
    ),
  );
  const line = (cells: string[]) =>
    cells.map((t, i) => pad(truncate(t, widths[i]!), widths[i]!)).join("  ").trimEnd();
  return [
    line(columns.map((c) => label(c.key, c.label))),
    ...sorted.map((r) => line(columns.map((c) => cellText(c, r) || "-"))),
  ];
}

/** The next column to sort by: the one after the current, ascending; none sorted, the first. */
export function nextSort(kind: FleetKind, sort: Sort | undefined): Sort {
  const keys = COLUMNS[kind].map((c) => c.key);
  const at = sort === undefined ? -1 : keys.indexOf(sort.key);
  return { key: keys[(at + 1) % keys.length]!, descending: false };
}

/** The screen, and the prompt that writes its query line. */
export function fleetScreen(
  session: Session,
  ctx: Ctx,
  line = "",
): { screen: Screen; ask: () => void } {
  const scroll = new Scroll();
  let query = line;
  let view: FleetView | undefined = line === "" ? undefined : viewFleet(session.db, session.user, line);
  let sort: Sort | undefined;
  let lines: string[] = [];
  const screen: Screen = {
    title: "Fleet",
    keys: [
      binding(["/"], "query"),
      binding(["s"], "sort"),
      binding(["r"], "reverse"),
      binding(["j", "k"], "scroll"),
      binding(["esc"], "back"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const head =
        view === undefined
          ? "/ to write a query line: repo autonomy:autonomous"
          : view.ok
            ? `${query}  ${view.rows.length} ${view.rows.length === 1 ? "row" : "rows"}`
            : `${query}  ${view.error}`;
      s.text(area.x + 1, area.y, truncate(head, area.w - 2), style(view?.ok === false ? c.danger : c.mutedFg, c.bg), area.x + area.w);
      lines = view?.ok ? fleetLines(view.kind, view.rows, sort) : [];
      const [header, ...body] = lines;
      if (header !== undefined && area.h > 2)
        s.text(area.x + 1, area.y + 2, truncate(header, area.w - 2), style(c.mutedFg, c.bg), area.x + area.w);
      const room = Math.max(0, area.h - 3);
      const from = scroll.window(room, body.length);
      for (let i = 0; i < room; i++) {
        const text = body[from + i];
        if (text !== undefined)
          s.text(area.x + 1, area.y + 3 + i, truncate(text, area.w - 2), style(c.fg, c.bg), area.x + area.w);
      }
    },
    key(e) {
      if (e.ctrl || e.alt) return scroll.key(e, Math.max(0, lines.length - 1));
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "/") ask();
      else if (e.key === "s" && view?.ok) sort = nextSort(view.kind, sort);
      else if (e.key === "r" && view?.ok && sort !== undefined) sort = { ...sort, descending: !sort.descending };
      else return scroll.key(e, Math.max(0, lines.length - 1));
      return true;
    },
  };
  const ask = () =>
    ctx.push(
      promptScreen(ctx, screen, {
        title: "Fleet query",
        label: "kind, then field:value terms",
        placeholder: "repo autonomy:autonomous",
        value: query,
        onSubmit: (text) => {
          if (text === "") return "a query starts with what it selects: repo, run or issue";
          const next = viewFleet(session.db, session.user, text);
          if (!next.ok) return next.error;
          query = text;
          view = next;
          sort = undefined;
          scroll.to(0, 0);
          return undefined;
        },
      }),
    );
  return { screen, ask };
}

export const fleetCommand = (session: Session, ctx: Ctx) => ({
  id: "fleet",
  title: "Fleet rows",
  hint: "the rows a fleet query line selects",
  run: () => {
    const { screen, ask } = fleetScreen(session, ctx);
    ctx.push(screen);
    ask();
  },
});
