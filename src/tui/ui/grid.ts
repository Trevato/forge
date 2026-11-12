/**
 * A parsed table as text: every column padded to its widest cell, capped,
 * with an ellipsis where a cell was cut. Plain strings out, so the pane can
 * scroll, search and shift them the way it does code.
 */

import type { Table } from "../../text/csv.ts";
import { displayWidth, pad, truncate } from "../term/width.ts";

/** The widest a column may grow, in display columns. */
export const CELL_MAX = 32;
const GAP = " │ ";

export interface Grid {
  readonly header: string;
  readonly rows: string[];
}

/** One line, no control characters: a cell must never reach the terminal as a command. */
const flat = (cell: string): string =>
  cell
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function layoutTable(table: Table, cap = CELL_MAX): Grid {
  const columns = Math.max(
    table.header.length,
    ...table.rows.map((r) => r.length),
  );
  const cells = (r: readonly string[]): string[] =>
    Array.from({ length: columns }, (_, i) => flat(r[i] ?? ""));
  const all = [cells(table.header), ...table.rows.map(cells)];
  const widths = Array.from({ length: columns }, (_, i) =>
    Math.min(cap, Math.max(1, ...all.map((r) => displayWidth(r[i]!)))),
  );
  const line = (r: readonly string[]): string =>
    r.map((cell, i) => pad(truncate(cell, widths[i]!), widths[i]!)).join(GAP);
  return { header: line(all[0]!), rows: all.slice(1).map(line) };
}
