/**
 * Terminal output as escaped HTML lines. Pure: text in, one string per line
 * out. Only SGR (`ESC [ … m`) is interpreted — foreground colour, bold and
 * underline — and each becomes a fixed class (`ansi-red`, `ansi-b`,
 * `ansi-u`); the input never reaches a `style` attribute or a class name.
 * Every other escape (cursor moves, OSC titles and hyperlinks, charset
 * selects) and every other control character is removed, never acted on.
 * Background, 256-colour (above 15) and truecolour requests are dropped.
 */

import { escapeHtml } from "../html.ts";

/** Colour class by SGR number (30-37; 90-97 share them). White is the default ink. */
const HUES: readonly (string | undefined)[] = [
  "gray", // 0 black: invisible on a dark page, so it is the quiet ink
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  undefined, // 7 white: the page's own ink
];

interface Pen {
  hue: string | undefined;
  bold: boolean;
  underline: boolean;
}

const classOf = (pen: Pen): string => {
  const parts: string[] = [];
  if (pen.hue !== undefined) parts.push(`ansi-${pen.hue}`);
  if (pen.bold) parts.push("ansi-b");
  if (pen.underline) parts.push("ansi-u");
  return parts.join(" ");
};

/** The pen after one SGR parameter list. */
function sgr(pen: Pen, params: string): void {
  const codes = params === "" ? [0] : params.split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (!Number.isInteger(c)) continue;
    if (c === 0) {
      pen.hue = undefined;
      pen.bold = false;
      pen.underline = false;
    } else if (c === 1) pen.bold = true;
    else if (c === 22) pen.bold = false;
    else if (c === 4) pen.underline = true;
    else if (c === 24) pen.underline = false;
    else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) pen.hue = HUES[c % 10];
    else if (c === 39) pen.hue = undefined;
    else if (c === 38 || c === 48) {
      const mode = codes[i + 1];
      if (c === 38 && mode === 5) {
        const n = codes[i + 2];
        if (n !== undefined && Number.isInteger(n) && n >= 0 && n <= 15) pen.hue = HUES[n % 8];
      }
      i += mode === 5 ? 2 : mode === 2 ? 4 : 0;
    }
  }
}

/**
 * OSC (to BEL or ST), CSI, any other escape pair, then a lone control
 * character that is neither a tab nor a newline (a bare CR included).
 */
const TOKEN =
  // eslint-disable-next-line no-control-regex
  /\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)?|\x1b\[([0-?]*)[ -/]*([@-~])?|\x1b[ -/]*[0-~]?|[\x00-\x08\x0b-\x1f\x7f]/g;

export interface AnsiLines {
  /** Escaped markup, one entry per line; a colour never spans two entries. */
  readonly lines: string[];
  /** Lines the whole text has, whether or not all were drawn. */
  readonly total: number;
}

/** The first `limit` lines of `input` as markup, and the line count of all of it. */
export function ansiLines(input: string, limit: number): AnsiLines {
  const text = input.replace(/\n$/, "");
  let total = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) total++;

  const pen: Pen = { hue: undefined, bold: false, underline: false };
  const lines: string[] = [];
  let line = "";
  const put = (chunk: string): void => {
    if (chunk === "") return;
    const cls = classOf(pen);
    line += cls === "" ? escapeHtml(chunk) : `<span class="${cls}">${escapeHtml(chunk)}</span>`;
  };
  const feed = (chunk: string): void => {
    const parts = chunk.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        lines.push(line);
        line = "";
      }
      put(parts[i]!);
    }
  };

  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (lines.length >= limit) break;
    feed(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[0].startsWith("\x1b[") && m[2] === "m" && /^[0-9;:]*$/.test(m[1]!)) sgr(pen, m[1]!);
  }
  if (lines.length < limit) {
    feed(text.slice(at));
    lines.push(line);
  }
  return { lines: lines.slice(0, limit), total };
}
