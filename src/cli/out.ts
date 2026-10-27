/**
 * What the CLI prints. Columns are measured with the same `displayWidth` the
 * TUI's cell buffer uses and coloured from the same theme tokens, so a repo
 * name with a CJK character or an emoji lines up in `forge status` exactly
 * as it does in the terminal UI — one width function, one palette.
 *
 * Colour is off unless stdout is a terminal and `NO_COLOR` is unset. Every
 * line is meant to survive being piped into `grep`.
 */

import { THEME_NAMES, type ThemeName } from "../design/themes.ts";
import { sgrDelta, style, PLAIN, type Color } from "../tui/term/style.ts";
import { theme, type Tokens } from "../tui/ui/theme.ts";
import { displayWidth, pad, truncate, type Align } from "../tui/term/width.ts";

export interface Out {
  readonly c: Tokens;
  readonly color: boolean;
  /** Terminal width, or 80 when there is no terminal. */
  readonly width: number;
  paint(text: string, fg: Color, attr?: number): string;
  line(text?: string): void;
  err(text: string): void;
  table(columns: readonly Col[], rows: readonly (readonly Cell[])[]): void;
}

export interface Col {
  readonly header: string;
  readonly align?: Align;
  /** Hard cap; the column is otherwise as wide as its widest cell. */
  readonly max?: number;
}

export interface Cell {
  readonly text: string;
  readonly fg?: Color;
  readonly attr?: number;
}

export function cell(text: string, fg?: Color, attr?: number): Cell {
  return {
    text,
    ...(fg === undefined ? {} : { fg }),
    ...(attr === undefined ? {} : { attr }),
  };
}

/** A cell is data, not instructions: control characters become U+FFFD. */
export function inert(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, "\ufffd");
}

function chosenTheme(): ThemeName {
  const name = process.env["FORGE_THEME"];
  return name !== undefined && (THEME_NAMES as readonly string[]).includes(name)
    ? (name as ThemeName)
    : "dark";
}

export function createOut(
  write: (text: string) => void = (text) => process.stdout.write(text),
  writeErr: (text: string) => void = (text) => process.stderr.write(text),
): Out {
  const c = theme(chosenTheme()).c;
  const color =
    process.env["NO_COLOR"] === undefined &&
    process.env["FORGE_COLOR"] !== "0" &&
    process.stdout.isTTY === true;
  const width = process.stdout.columns ?? 80;

  const paint = (text: string, fg: Color, attr = 0): string => {
    if (!color || text === "") return text;
    // Foreground only: the CLI writes into the user's own scrollback and has
    // no business repainting their background.
    return `${sgrDelta(PLAIN, style(fg, -1, attr), "truecolor")}${text}\x1b[0m`;
  };

  return {
    c,
    color,
    width,
    paint,
    line: (text = "") => write(`${text}\n`),
    err: (text) => writeErr(`${text}\n`),
    table(columns, rows_) {
      if (rows_.length === 0) return;
      const rows = rows_.map((row) =>
        row.map((x) => ({ ...x, text: inert(x.text) })),
      );
      // Size from the content, then cap: a table that reflows on every run
      // because one branch name grew is a table you cannot scan.
      const widths = columns.map((col, i) => {
        let w = displayWidth(inert(col.header));
        for (const row of rows)
          w = Math.max(w, displayWidth(row[i]?.text ?? ""));
        return Math.min(w, col.max ?? w);
      });
      const render = (cells: readonly Cell[], head: boolean): string => {
        const parts = columns.map((col, i) => {
          const raw = cells[i]?.text ?? "";
          const text = pad(truncate(raw, widths[i]!), widths[i]!, col.align);
          const fg = head ? c.mutedFg : cells[i]?.fg;
          return fg === undefined ? text : paint(text, fg, cells[i]?.attr ?? 0);
        });
        return parts.join("  ").replace(/\s+$/, "");
      };
      write(
        `${render(
          columns.map((col) => cell(inert(col.header))),
          true,
        )}\n`,
      );
      for (const row of rows) write(`${render(row, false)}\n`);
    },
  };
}
