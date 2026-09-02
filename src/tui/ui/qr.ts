/**
 * A QR code in a cell grid.
 *
 * Two module rows per text row, drawn with half blocks, which is what makes
 * the result square: a terminal cell is about twice as tall as it is wide, so
 * one module per column and half a row is the aspect a camera expects.
 *
 * The colours are fixed black-on-white and take no theme. Every scanner
 * assumes dark modules on a light ground; a "dark theme" QR is not a styling
 * choice, it is an unreadable one. So the widget paints its own white field,
 * including the quiet zone, and the surrounding card keeps its theme.
 */

import { qrEncode, qrRows, type QrCode } from "../../design/qr.ts";
import type { Rect, Screen } from "../term/screen.ts";
import { style } from "../term/style.ts";

const DARK = 0x000000;
const LIGHT = 0xffffff;

/**
 * The quiet zone a terminal uses. The specification says four modules and
 * printing should; eight of the twenty-four rows an 80×24 terminal has is too
 * much to spend on margin, and the white field this widget paints already
 * separates the symbol from the card. Two is the compromise every terminal
 * QR renderer makes.
 */
const TERMINAL_QUIET = 2;

/** Encode for a terminal, or nothing if the payload will not fit a version 10. */
export function terminalQr(text: string): QrCode | undefined {
  const code = qrEncode(text, { quiet: TERMINAL_QUIET });
  return code.ok ? code.value : undefined;
}

/** Rows and columns `drawQr` will occupy — ask before deciding to show one. */
export function qrSize(code: QrCode): { cols: number; rows: number } {
  const width = code.size + code.quiet * 2;
  return { cols: width, rows: Math.ceil(width / 2) };
}

/**
 * Draw the code centred in `r`, returning the row after it. A code that does
 * not fit is not drawn at all: half a QR is not a smaller QR, it is a wrong
 * one, and the screens that call this have a short link to fall back to.
 */
export function drawQr(s: Screen, r: Rect, code: QrCode): number {
  const size = qrSize(code);
  if (size.cols > r.w || size.rows > r.h) return r.y;
  const rows = qrRows(code);
  const x = r.x + ((r.w - size.cols) >> 1);
  const paint = style(DARK, LIGHT);
  for (const [i, line] of rows.entries())
    s.text(x, r.y + i, line, paint, x + size.cols);
  return r.y + size.rows;
}
