/**
 * Immutable styles, and SGR emission that only ever writes the delta.
 *
 * Colours live in the cell buffer as packed 24-bit RGB and are downsampled
 * *once, at the writer, per session* (lipgloss v2's conclusion). One style
 * tree can then serve N sessions at N colour depths — which is the only
 * correct answer to `COLORTERM` not surviving SSH.
 */

export type ColorDepth = "truecolor" | "256";

/** Packed 0xRRGGBB, or DEFAULT for "whatever the terminal's default is". */
export type Color = number;
export const DEFAULT: Color = -1;

export const BOLD = 1;
export const DIM = 2;
export const ITALIC = 4;
export const UNDERLINE = 8;
export const REVERSE = 16;
export const STRIKE = 32;

export interface Style {
  readonly fg: Color;
  readonly bg: Color;
  readonly attr: number;
}

export const PLAIN: Style = { fg: DEFAULT, bg: DEFAULT, attr: 0 };

export function style(
  fg: Color = DEFAULT,
  bg: Color = DEFAULT,
  attr = 0,
): Style {
  return { fg, bg, attr };
}

export function withFg(s: Style, fg: Color): Style {
  return s.fg === fg ? s : { fg, bg: s.bg, attr: s.attr };
}

export function withBg(s: Style, bg: Color): Style {
  return s.bg === bg ? s : { fg: s.fg, bg, attr: s.attr };
}

export function withAttr(s: Style, bits: number): Style {
  const attr = s.attr | bits;
  return attr === s.attr ? s : { fg: s.fg, bg: s.bg, attr };
}

export function withoutAttr(s: Style, bits: number): Style {
  const attr = s.attr & ~bits;
  return attr === s.attr ? s : { fg: s.fg, bg: s.bg, attr };
}

export function sameStyle(a: Style, b: Style): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.attr === b.attr;
}

/** True when the cell would still be visible over a blank glyph. */
export function visibleOnBlank(s: Style): boolean {
  return s.bg !== DEFAULT || (s.attr & (UNDERLINE | REVERSE | STRIKE)) !== 0;
}

export function rgb(hex: string): Color {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length === 3) {
    const r = h[0]!;
    const g = h[1]!;
    const b = h[2]!;
    return parseInt(r + r + g + g + b + b, 16);
  }
  return parseInt(h.slice(0, 6), 16);
}

/** Blend `a` toward `b` by `t` ∈ [0,1] — used for tints and dimmed backdrops. */
export function mix(a: Color, b: Color, t: number): Color {
  if (a === DEFAULT) return b;
  if (b === DEFAULT) return a;
  const lerp = (shift: number): number => {
    const x = (a >> shift) & 0xff;
    const y = (b >> shift) & 0xff;
    return Math.round(x + (y - x) * t) & 0xff;
  };
  return (lerp(16) << 16) | (lerp(8) << 8) | lerp(0);
}

/** Perceptual-ish luminance, for picking a readable foreground over a colour. */
export function luminance(c: Color): number {
  if (c === DEFAULT) return 0.5;
  const r = ((c >> 16) & 0xff) / 255;
  const g = ((c >> 8) & 0xff) / 255;
  const b = (c & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ---- 256-colour quantization ----
//
// Apple Terminal was 256-colour-only for its entire history before Tahoe, and
// tmux caps at 256 without `RGB`. Quantization is not a degraded path, it is
// the floor the design has to look intentional on.

// The xterm cube's level set is non-linear: the first step jumps 95, the rest
// are +40. termenv's channel→index thresholds reproduce it exactly.
const LEVELS = [0, 95, 135, 175, 215, 255];

function cubeIndex(v: number): number {
  if (v < 48) return 0;
  if (v < 115) return 1;
  // Integer division, as termenv does it — rounding here pushes values a
  // whole cube step too far and visibly shifts saturated reds.
  return Math.min(5, Math.floor((v - 35) / 40));
}

// Weighted-Euclidean RGB rather than a perceptual space: HSLuv would need a
// colour-space library (zero deps) and at 256 granularity the delta is small.
function dist(
  r: number,
  g: number,
  b: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const dr = r - r2;
  const dg = g - g2;
  const db = b - b2;
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}

const quantCache = new Map<number, number>();

/**
 * Nearest xterm-256 index for a packed RGB. Both a cube candidate *and* a
 * grey-ramp candidate are computed and the nearer wins — chalk's shortcut of
 * entering the ramp only on exact channel equality sends rgb(254,255,254)
 * through the cube and misses a much closer grey.
 */
export function quantize256(c: Color): number {
  const cached = quantCache.get(c);
  if (cached !== undefined) return cached;
  const r = (c >> 16) & 0xff;
  const g = (c >> 8) & 0xff;
  const b = c & 0xff;

  const ri = cubeIndex(r);
  const gi = cubeIndex(g);
  const bi = cubeIndex(b);
  const cubeD = dist(r, g, b, LEVELS[ri]!, LEVELS[gi]!, LEVELS[bi]!);

  // Ramp: value = 8 + 10*i, i ∈ 0..23, index 232 + i.
  const avg = (r + g + b) / 3;
  const i = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const gv = 8 + 10 * i;
  const rampD = dist(r, g, b, gv, gv, gv);

  const out = rampD < cubeD ? 232 + i : 16 + 36 * ri + 6 * gi + bi;
  if (quantCache.size > 4096) quantCache.clear();
  quantCache.set(c, out);
  return out;
}

function fgCode(c: Color, depth: ColorDepth): string {
  if (c === DEFAULT) return "39";
  if (depth === "truecolor")
    // Semicolon form, not the T.416 colon form: older VTE, tmux and Apple
    // Terminal have all historically mishandled `38:2::r:g:b`.
    return `38;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`;
  return `38;5;${quantize256(c)}`;
}

function bgCode(c: Color, depth: ColorDepth): string {
  if (c === DEFAULT) return "49";
  if (depth === "truecolor")
    return `48;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`;
  return `48;5;${quantize256(c)}`;
}

const ON: [number, string][] = [
  [BOLD, "1"],
  [DIM, "2"],
  [ITALIC, "3"],
  [UNDERLINE, "4"],
  [REVERSE, "7"],
  [STRIKE, "9"],
];
const OFF: [number, string][] = [
  [ITALIC, "23"],
  [UNDERLINE, "24"],
  [REVERSE, "27"],
  [STRIKE, "29"],
];

/**
 * The SGR needed to move the terminal from `prev` to `next`, or "" when the
 * two are identical. Emitting only deltas is most of the byte saving in a
 * frame; the sticky registers live in the renderer.
 */
export function sgrDelta(prev: Style, next: Style, depth: ColorDepth): string {
  const parts: string[] = [];
  if (prev.fg !== next.fg) parts.push(fgCode(next.fg, depth));
  if (prev.bg !== next.bg) parts.push(bgCode(next.bg, depth));

  const gone = prev.attr & ~next.attr;
  const added = next.attr & ~prev.attr;
  // SGR 22 kills BOLD *and* DIM together, so clearing one has to re-apply
  // the survivor. This is the classic "my dim text went bold" bug.
  if (gone & (BOLD | DIM)) {
    parts.push("22");
    if (next.attr & BOLD) parts.push("1");
    if (next.attr & DIM) parts.push("2");
  }
  for (const [bit, code] of OFF) if (gone & bit) parts.push(code);
  for (const [bit, code] of ON) {
    if (bit === BOLD || bit === DIM) continue; // handled above
    if (added & bit) parts.push(code);
  }
  if (added & BOLD && !(gone & (BOLD | DIM))) parts.push("1");
  if (added & DIM && !(gone & (BOLD | DIM))) parts.push("2");

  return parts.length === 0 ? "" : `\x1b[${parts.join(";")}m`;
}
