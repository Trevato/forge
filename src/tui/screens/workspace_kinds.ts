/**
 * Notebooks, JSON Lines and logs in the terminal workspace, read the way the
 * web reads them: the same parsers, drawn as text.
 *
 * `kindView(path, text, c)` is the one call the workspace makes. It answers a
 * table (`.jsonl`), styled lines (`.ipynb`, `.log`), or null, and null means
 * "not this kind, or malformed": the workspace then shows the source, as it
 * always did. `s` toggles between this view and the source.
 */

import { parseNotebook } from "../../web/render/notebook.ts";
import { parseJsonl } from "../../web/render/jsonl-parse.ts";
import { logLevel } from "../../web/render/log.ts";
import { ansiLines } from "../../web/render/ansi.ts";
import type { Table } from "../../text/csv.ts";
import type { Span } from "../term/screen.ts";
import { BOLD, DIM, UNDERLINE, style, type Color } from "../term/style.ts";
import { expandTabs } from "../term/width.ts";
import type { Tokens } from "../ui/theme.ts";

/** Rows of a JSON Lines file drawn; the rest are counted ("N more rows not shown"). */
export const ROW_CAP = 500;
/** Lines of a log or notebook drawn. */
export const LINE_CAP = 10_000;

export interface KindLines {
  readonly plain: string[];
  readonly lines: Span[][];
}

export type KindView =
  | { readonly table: Table; readonly lines?: undefined }
  | ({ readonly table?: undefined } & KindLines);

export const isNotebookPath = (path: string): boolean => /\.ipynb$/i.test(path);
export const isJsonlPath = (path: string): boolean => /\.(jsonl|ndjson)$/i.test(path);
export const isLogPath = (path: string): boolean => /\.(log|ansi)$/i.test(path);

/** The view for this file, or null when its kind has none or the file is malformed. */
export function kindView(path: string, text: string, c: Tokens): KindView | null {
  if (isNotebookPath(path)) return wrap(notebookLines(text, c));
  if (isJsonlPath(path)) {
    const table = jsonlTable(text);
    return table === null ? null : { table };
  }
  if (isLogPath(path)) return wrap(logLines(text, c));
  return null;
}

const wrap = (l: KindLines | null): KindView | null => (l === null ? null : l);

// ---- .jsonl ----

/** The rows as a table; null when no line is a JSON object. */
export function jsonlTable(text: string): Table | null {
  const parsed = parseJsonl(text, ROW_CAP + 1);
  if ("error" in parsed) return null;
  const [header = [], ...rows] = parsed.rows;
  // Only unparseable lines: there are no columns, so the source says more.
  if (header.length === 1 && header[0] === "line") return null;
  const shown = rows.slice(0, ROW_CAP);
  return {
    header,
    rows: shown,
    more: Math.max(0, parsed.records - 1 - shown.length),
    delimiter: ",",
    columns: parsed.columns,
  };
}

// ---- .ipynb ----

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
const unescape = (s: string): string => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, k: string) => ENTITIES[k]!);

const clean = (s: string): string => expandTabs(s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""));

interface Row {
  text: string;
  color: Color;
  attr: number;
}

/** The text of `rows`, capped at LINE_CAP with the rest counted, as styled lines. */
function finish(rows: Row[], c: Tokens): KindLines {
  const cut = rows.length - LINE_CAP;
  const shown = rows.slice(0, LINE_CAP).map((r) => ({ ...r, text: clean(r.text) }));
  if (cut > 0) shown.push({ text: `${plural(cut, "more line")} not shown`, color: c.faint, attr: DIM });
  return {
    plain: shown.map((l) => l.text),
    lines: shown.map((l) => [{ text: l.text, style: style(l.color, c.bg, l.attr) }]),
  };
}

const plural = (n: number, noun: string): string => `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;

/** Cells in order: markdown as its source, code dimmed, outputs as text, errors in the danger colour. */
export function notebookLines(text: string, c: Tokens): KindLines | null {
  const parsed = parseNotebook(text);
  if ("error" in parsed) return null;
  const rows: Row[] = [];
  const push = (block: string, color: Color, attr: number): void => {
    for (const line of block.replace(/\n$/, "").split("\n")) rows.push({ text: line, color, attr });
  };
  const gap = (): void => void rows.push({ text: "", color: c.fg, attr: 0 });
  for (const cell of parsed.cells) {
    if (cell.kind === "markdown") {
      for (const line of cell.source.replace(/\n$/, "").split("\n"))
        rows.push({ text: line, color: c.fg, attr: /^#{1,6}\s/.test(line) ? BOLD : 0 });
    } else if (cell.kind === "code") {
      push(`In [${cell.count}]: ${cell.source}`, c.faint, DIM);
      for (const o of cell.outputs) {
        if (o.kind === "image") push("[image output not shown]", c.faint, DIM);
        else if (o.kind === "caption") push(o.text, c.faint, DIM);
        else push(o.text, o.kind === "error" ? c.danger : c.fg, 0);
      }
    } else push(cell.source, c.fg, 0);
    gap();
  }
  if (parsed.total > parsed.cells.length)
    push(`${plural(parsed.total - parsed.cells.length, "more cell")} not shown`, c.faint, DIM);
  return finish(rows, c);
}

// ---- .log ----

const HUES = (c: Tokens): Readonly<Record<string, Color>> => ({
  red: c.danger,
  green: c.success,
  yellow: c.attn,
  blue: c.primary,
  magenta: c.merged,
  cyan: c.accent,
  gray: c.faint,
});

/**
 * Colours the log carries (SGR, read by the web's `ansiLines`) win; a line
 * with none is coloured by the level it states.
 */
export function logLines(text: string, c: Tokens): KindLines {
  const hues = HUES(c);
  const levelColor = { error: c.danger, warn: c.attn, debug: c.faint } as const;
  const { lines: marked, total } = ansiLines(text, LINE_CAP);
  const plain: string[] = [];
  const lines: Span[][] = [];
  for (const m of marked) {
    const spans: Span[] = [];
    let flat = "";
    for (const part of m.matchAll(/<span class="([^"]*)">([^<]*)<\/span>|([^<]+)/g)) {
      const t = expandTabs(unescape(part[2] ?? part[3] ?? ""));
      flat += t;
      const classes = (part[1] ?? "").split(" ");
      const hue = classes.map((k) => hues[k.slice(5)]).find((x) => x !== undefined);
      const attr = (classes.includes("ansi-b") ? BOLD : 0) | (classes.includes("ansi-u") ? UNDERLINE : 0);
      spans.push({ text: t, style: style(hue ?? c.fg, c.bg, attr) });
    }
    const level = spans.every((s) => s.style.fg === c.fg) ? logLevel(flat) : undefined;
    plain.push(flat);
    lines.push(level === undefined ? spans : [{ text: flat, style: style(levelColor[level], c.bg) }]);
  }
  if (total > marked.length) {
    const note = `${plural(total - marked.length, "more line")} not shown`;
    plain.push(note);
    lines.push([{ text: note, style: style(c.faint, c.bg, DIM) }]);
  }
  return { plain, lines };
}
