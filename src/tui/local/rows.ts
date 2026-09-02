/**
 * A list whose columns line up.
 *
 * The forge's own `row()` puts a title, a secondary and a right-hand meta on
 * a line and lets them fall where they may; that reads well for prose rows
 * (an issue, a pull request) and badly for a table of facts, where the whole
 * value is that the third field is under the third field above it. Every
 * local screen is a table of facts about a repo, so they get this instead:
 * measure every cell, fit the columns to the pane, and give up the droppable
 * ones before letting anything overflow.
 */

import { G, type Rect, type Screen as Surface } from "../term/screen.ts";
import { BOLD, DIM, style, type Color } from "../term/style.ts";
import { displayWidth, truncate, type Align } from "../term/width.ts";
import type { ListState } from "../screens/common.ts";
import type { Tokens } from "../ui/theme.ts";
import { scrollbar, spinner } from "../ui/widgets.ts";

/**
 * One cell. `spans` is for the rare row that needs more than one colour in a
 * single column — the log's graph lane — and `text` still carries the plain
 * string the column is measured by, so the two can never disagree on width.
 */
export interface Cell {
  readonly text: string;
  readonly fg?: Color;
  readonly attr?: number;
  readonly spans?: readonly { readonly text: string; readonly fg: Color }[];
}

export function cell(text: string, fg?: Color, attr?: number): Cell {
  return {
    text,
    ...(fg === undefined ? {} : { fg }),
    ...(attr === undefined ? {} : { attr }),
  };
}

export interface Column {
  readonly align?: Align;
  /** Takes whatever width is left over, and ellipsizes before anyone else. */
  readonly grow?: boolean;
  /**
   * Given up when the pane is too narrow, lowest rank first. A column you
   * can lose entirely is lost before a column you can only mangle.
   */
  readonly drop?: number;
  /** Never shrink below this many columns. */
  readonly min?: number;
  /** Spaces before this column. Two, unless it is the leftmost one. */
  readonly gap?: number;
  /** Bold on the selected row — the column the eye should land on. */
  readonly emphasis?: boolean;
}

const GAP = 2;

/** Draw the rows of `list` into `r`, in columns measured from `rows`. */
export function drawRows(
  s: Surface,
  r: Rect,
  c: Tokens,
  list: ListState,
  columns: readonly Column[],
  rows: readonly (readonly Cell[])[],
  focused = true,
): void {
  if (r.w <= 0 || r.h <= 0) return;
  const width = Math.max(0, r.w - 1); // the scrollbar's column
  const from = list.window(r.h, rows.length);
  const widths = fitColumns(columns, rows, Math.max(0, width - 2));

  for (let i = 0; i < r.h; i++) {
    const row = rows[from + i];
    if (row === undefined) break;
    const y = r.y + i;
    const selected = focused && from + i === list.index;
    const bg = selected ? c.muted : c.bg;
    s.fill({ x: r.x, y, w: width, h: 1 }, " ", style(c.fg, bg));
    let x = s.text(
      r.x,
      y,
      selected ? `${G.caretRight} ` : "  ",
      style(c.accent, bg),
      r.x + width,
    );
    let first = true;
    columns.forEach((col, j) => {
      const w = widths[j];
      if (w === undefined || w === null) return;
      if (!first) x += col.gap ?? GAP;
      first = false;
      const cell = row[j];
      const right = r.x + width;
      const attr =
        (cell?.attr ?? 0) | (selected && col.emphasis === true ? BOLD : 0);
      const fg = cell?.fg ?? c.fg;
      const text = truncate(cell?.text ?? "", w);
      const slack = w - displayWidth(text);
      const lead =
        col.align === "right" ? slack : col.align === "center" ? slack >> 1 : 0;
      if (cell?.spans !== undefined && displayWidth(cell.text) <= w)
        s.spans(
          x + lead,
          y,
          cell.spans.map((span) => ({
            text: span.text,
            style: style(span.fg, bg, attr),
          })),
          right,
        );
      else s.text(x + lead, y, text, style(fg, bg, attr), right);
      x += w;
    });
  }
  scrollbar(s, { x: r.x + r.w - 1, y: r.y, w: 1, h: r.h }, c, {
    total: rows.length,
    offset: from,
  });
}

/**
 * Column widths for a pane. Natural width first — the widest cell in the
 * column — then, while it does not fit: give up the droppable columns in
 * their declared order, then shrink whichever column has slack left, and
 * only then let the draw truncate. An empty column takes no width and no
 * gutter at all, so a list where nothing is stashed carries no stash column.
 */
function fitColumns(
  columns: readonly Column[],
  rows: readonly (readonly Cell[])[],
  available: number,
): (number | null)[] {
  const widths = columns.map((_, j) => {
    let w = 0;
    for (const row of rows) w = Math.max(w, displayWidth(row[j]?.text ?? ""));
    return w;
  });
  const mins = columns.map((col, j) =>
    Math.min(widths[j]!, col.min ?? (col.grow === true ? 8 : widths[j]!)),
  );
  const live = widths.map((w) => w > 0);
  const total = (): number => {
    let sum = 0;
    let first = true;
    columns.forEach((col, j) => {
      if (!live[j]) return;
      if (!first) sum += col.gap ?? GAP;
      first = false;
      sum += widths[j]!;
    });
    return sum;
  };

  for (let guard = 0; total() > available && guard < 4096; guard++) {
    let rank = Infinity;
    let drop = -1;
    columns.forEach((col, j) => {
      if (live[j] && col.drop !== undefined && col.drop < rank) {
        rank = col.drop;
        drop = j;
      }
    });
    if (drop >= 0) {
      live[drop] = false;
      continue;
    }
    let slack = 0;
    let give = -1;
    columns.forEach((_, j) => {
      if (!live[j]) return;
      const room = widths[j]! - mins[j]!;
      if (room > slack) {
        slack = room;
        give = j;
      }
    });
    if (give < 0) break;
    widths[give]!--;
  }

  // Leftover space belongs to the growing column, which pushes the trailing
  // columns to the pane's right edge — the alignment that makes a time or a
  // count scannable down the page rather than ragged behind the text.
  const grow = columns.findIndex((col, j) => col.grow === true && live[j]);
  if (grow >= 0) widths[grow]! += Math.max(0, available - total());
  return widths.map((w, j) => (live[j] ? w : null));
}

/**
 * A section header — the host above a repo list — in the same dim treatment
 * the work screen gives `CHANGED` and `NEW`, because they are the same thing:
 * a label for the rows under it, not a row of its own.
 */
export function drawHeader(s: Surface, r: Rect, c: Tokens, text: string): void {
  if (r.w <= 0 || r.h <= 0) return;
  s.text(
    r.x + 1,
    r.y,
    truncate(text, Math.max(0, r.w - 2)),
    style(c.mutedFg, c.bg, DIM),
    r.x + r.w,
  );
}

/**
 * The strip a screen shows while git is running: a spinner and the task's own
 * progress line. Every local screen can start something slow, so every local
 * screen needs somewhere to say so — the alternative is a list that ignores a
 * keypress for four seconds with no explanation.
 */
export function drawBusy(
  s: Surface,
  r: Rect,
  c: Tokens,
  note: string,
  tick: number,
): void {
  if (r.w <= 0 || r.h <= 0) return;
  s.fill(r, " ", style(c.mutedFg, c.muted));
  const x = spinner(s, r.x + 1, r.y, c, tick);
  s.text(
    x + 1,
    r.y,
    truncate(note, Math.max(0, r.w - 4)),
    style(c.accent, c.muted),
    r.x + r.w,
  );
}
