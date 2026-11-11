/**
 * `/fleet` in the terminal: a query line in, the rows it selects as a
 * table, sorted by one column. The same read as the web page
 * (`fleet/rows.ts` `viewFleet`), so the grammar and who sees which row are
 * `fleet/selection.ts`'s, never this screen's; the same columns and sort
 * (`fleet/columns.ts`). Keys: `/` a new query line, `s` sort by the next
 * column, `r` reverse it, `j`/`k` scroll, `esc` back. A signed-in person (not
 * an agent, as on the page) also has `v`: a verb and its value, the preview
 * of each row's change, Apply, and `u` to undo the last result. `x` (or
 * space) marks the top row in view, as a ticked box does on the page: with
 * rows marked, `v` acts on them alone, else on every row the line selects.
 * The writes are `actions/fleet.ts`'s, as the page's are.
 */

import type { Operation } from "../../core/fleet_ops.ts";
import { applyPreviewed, pickedWords, previewFleetOp, undoFleetOp, type Plan } from "../../actions/fleet.ts";
import { digestOf } from "../../fleet/digest.ts";
import { actionOf } from "../../fleet/reading.ts";

import { cellText, COLUMNS, sortRows, type Sort } from "../../fleet/columns.ts";
import { viewFleet, type FleetView } from "../../fleet/rows.ts";
import { fieldsOf, GRAMMAR, GRAMMAR_EXAMPLES, FLEET_KINDS, type FleetKind } from "../../fleet/selection.ts";
import type { FleetRow } from "../../fleet/rows.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { pad, truncate, wrap } from "../term/width.ts";
import { confirmScreen, later, promptScreen, Scroll } from "./common.ts";

/** No column is padded past this, so a long title does not push the rest away. */
const CELL_MAX = 40;

/**
 * The table as text lines: a header naming the sorted column, then one line
 * a row. With `marked`, each line leads with `*` for a marked row and `>`
 * for the row at `at` (the one `x` marks).
 */
export function fleetLines(
  kind: FleetKind,
  rows: readonly FleetRow[],
  sort: Sort | undefined,
  marked?: { ids: ReadonlySet<string>; at: number },
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
  const lead = (r: FleetRow | undefined, i: number): string =>
    marked === undefined
      ? ""
      : `${i === marked.at ? ">" : " "}${r !== undefined && marked.ids.has(String(r.id)) ? "*" : " "} `;
  return [
    lead(undefined, -1) + line(columns.map((c) => label(c.key, c.label))),
    ...sorted.map((r, i) => lead(r, i) + line(columns.map((c) => cellText(c, r) || "-"))),
  ];
}

/** The id of the row at `at` in `rows` as the table sorts them. */
export function rowAt(rows: readonly FleetRow[], sort: Sort | undefined, at: number): string | undefined {
  const row = sortRows(rows, sort)[at];
  return row === undefined ? undefined : String(row.id);
}

/**
 * The grammar as the web page shows it (`fleet/selection.ts`): the sentence
 * wrapped to `width`, one line a kind naming its fields, then the examples.
 */
export function grammarLines(width: number): string[] {
  return [
    ...wrap(GRAMMAR, width),
    "",
    ...FLEET_KINDS.map((kind) => `${pad(kind, 6)} ${fieldsOf(kind).join(", ")}`),
    "",
    ...GRAMMAR_EXAMPLES.map((e) => `e.g. ${e}`),
  ];
}

/** The next column to sort by: the one after the current, ascending; none sorted, the first. */
export function nextSort(kind: FleetKind, sort: Sort | undefined): Sort {
  const keys = COLUMNS[kind].map((c) => c.key);
  const at = sort === undefined ? -1 : keys.indexOf(sort.key);
  return { key: keys[(at + 1) % keys.length]!, descending: false };
}

/** A row's change in one line: label, before → after, and what becomes of it. */
export function planLines(plan: Plan, width: number, most = 12): string[] {
  const word = (v: unknown) => (v === null ? "nothing" : Array.isArray(v) ? v.join(", ") || "none" : String(v));
  const rows = plan.rows.slice(0, most).map((r) =>
    truncate(
      `${r.label}: ${word(r.before)} -> ${word(r.after)}  ${r.outcome === "change" ? "" : r.outcome}${r.reason === "" ? "" : ` - ${r.reason}`}`.trimEnd(),
      width,
    ),
  );
  return plan.rows.length > most ? [...rows, `and ${plan.rows.length - most} more`] : rows;
}

/** A person (not a guest, not an agent) may act, as on the page. */
export const mayAct = (user: Session["user"]): boolean => user !== undefined && user.kind !== "agent";

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
  let note = "";
  let last: Operation | undefined;
  /** Marked row ids; cleared with each new query line. */
  const marked = new Set<string>();
  const screen: Screen = {
    title: "Fleet",
    keys: [
      binding(["/"], "query"),
      ...(mayAct(session.user)
        ? [binding(["x"], "mark"), binding(["v"], "verb"), binding(["u"], "undo")]
        : []),
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
            ? `${query}  ${view.rows.length} ${view.rows.length === 1 ? "row" : "rows"}${marked.size === 0 ? "" : `, ${marked.size} marked`}`
            : `${query}  ${view.error}`;
      const shown = note === "" ? head : `${head}  ${note}`;
      s.text(area.x + 1, area.y, truncate(shown, area.w - 2), style(view?.ok === false ? c.danger : c.mutedFg, c.bg), area.x + area.w);
      if (view?.ok !== true) {
        // No rows to show: the grammar fills the space, as it sits under the web form.
        grammarLines(Math.max(20, area.w - 2)).forEach((text, i) => {
          if (2 + i < area.h)
            s.text(area.x + 1, area.y + 2 + i, truncate(text, area.w - 2), style(c.mutedFg, c.bg), area.x + area.w);
        });
      }
      lines = view?.ok
        ? fleetLines(view.kind, view.rows, sort, mayAct(session.user) ? { ids: marked, at: scroll.top } : undefined)
        : [];
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
      else if ((e.key === "x" || e.key === " ") && view?.ok && mayAct(session.user)) mark(view.rows);
      else if (e.key === "v" && view?.ok && mayAct(session.user)) verb();
      else if (e.key === "u" && last !== undefined && mayAct(session.user)) undo();
      else if (e.key === "s" && view?.ok) sort = nextSort(view.kind, sort);
      else if (e.key === "r" && view?.ok && sort !== undefined) sort = { ...sort, descending: !sort.descending };
      else return scroll.key(e, Math.max(0, lines.length - 1));
      return true;
    },
  };
  const mark = (rows: readonly FleetRow[]) => {
    const id = rowAt(rows, sort, scroll.top);
    if (id === undefined) return;
    if (marked.has(id)) marked.delete(id);
    else marked.add(id);
  };
  const refresh = () => {
    if (query !== "") view = viewFleet(session.db, session.user, query);
  };
  const undo = () => {
    const op = last;
    if (op === undefined) return;
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Undo",
        body: [`Put back what ${op.verb} changed.`],
        actions: [{ label: "Undo" }, { label: "Cancel", variant: "outline" }],
        onChoose: (i) => {
          if (i !== 0) return;
          void undoFleetOp(session.app, session.user, op.id).then((r) => {
            note = r.ok ? "Undone." : r.error.message;
            if (r.ok) last = undefined;
            refresh();
          });
        },
      }),
    );
  };
  const verb = () =>
    ctx.push(
      promptScreen(ctx, screen, {
        title: "Verb",
        label: "a verb, then its value (some take none)",
        placeholder: "label urgent",
        hint: "Nothing is written until you apply.",
        onSubmit: (text) => {
          const [name = "", ...rest] = text.trim().split(/\s+/);
          const value = rest.join(" ");
          if (name === "") return "name a verb";
          const action = actionOf(session.app, name, value);
          const picked = [...marked];
          const plan = previewFleetOp(session.app, session.user, query, action, picked);
          if (!plan.ok) return plan.error.message;
          const p = plan.value;
          const n = p.counts.change;
          const total = view?.ok ? view.rows.length : p.rows.length;
          return later(ctx, () =>
            confirmScreen(ctx, screen, {
              title: `Preview: ${p.verb}`,
              body: [
                ...planLines(p, 70),
                "",
                `${pickedWords(total, picked.length === 0 ? 0 : p.rows.length)}. ${n === 0 ? "Nothing to apply." : "Nothing is written until you apply."}`,
              ],
              actions: n === 0 ? [{ label: "Close" }] : [{ label: `Apply to ${n} ${n === 1 ? "row" : "rows"}` }, { label: "Cancel", variant: "outline" }],
              width: 76,
              onChoose: (i) => {
                if (i !== 0 || n === 0) return;
                void applyPreviewed(session.app, session.user, query, action, digestOf(p.rows), picked).then((r) => {
                  note = r.ok ? "Applied. u undoes." : r.error.message;
                  if (r.ok) last = r.value;
                  refresh();
                });
              },
            }),
          );
        },
      }),
    );
  const ask = () =>
    ctx.push(
      promptScreen(ctx, screen, {
        title: "Fleet query",
        label: "kind, then field:value terms",
        hint: `e.g. ${GRAMMAR_EXAMPLES[0]}`,
        placeholder: "repo autonomy:autonomous",
        value: query,
        onSubmit: (text) => {
          if (text === "") return "a query starts with what it selects: repo, run or issue";
          const next = viewFleet(session.db, session.user, text);
          if (!next.ok) return next.error;
          query = text;
          view = next;
          marked.clear();
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
