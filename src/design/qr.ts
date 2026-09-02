/**
 * A QR encoder, in about the space a dependency's `package.json` would take.
 *
 * It exists for one screen: a terminal on the far side of an SSH connection
 * printing a link that the phone in your hand has to open. You cannot click
 * it, you often cannot copy it, and typing a URL with a random code in it is
 * exactly the kind of thing people get wrong twice and then give up on. A QR
 * code turns that into pointing a camera.
 *
 * Scope is chosen to be the smallest thing that solves that problem and no
 * larger: **byte mode**, **error correction M** (~15%, the level every
 * generator defaults to), **versions 1–10** (up to 213 bytes — a URL, never a
 * vCard). Everything the specification requires *within* that scope is here
 * and is tested against reference matrices: Reed–Solomon over GF(256) with
 * the real block/interleave layout, all eight masks scored by the standard
 * penalty rules, format information with its BCH(15,5) code, and version
 * information (BCH(18,6)) from version 7 up.
 *
 * The output is a boolean matrix — `true` is a dark module — with the quiet
 * zone already around it, because a QR without its quiet zone is a QR that
 * does not scan and that is not a decision to leave to a caller. Two
 * renderers ship with it: half-block rows for a terminal and an SVG path for
 * the web. Both are pure string builders; neither knows about a theme, since
 * a QR must be dark-on-light whatever the surface around it is doing.
 */

import { err, ok, type Result } from "../kernel/result.ts";

export type QrRow = readonly boolean[];

export interface QrCode {
  /** 1–10. Bigger versions hold more and are physically denser. */
  readonly version: number;
  /** Which of the eight masks scored best (0–7). */
  readonly mask: number;
  /** Modules across the symbol itself: 21 + 4·(version−1). */
  readonly size: number;
  /** Quiet-zone modules included on each side of `modules`. */
  readonly quiet: number;
  /** `size + 2·quiet` square, row-major, `true` = dark. */
  readonly modules: readonly QrRow[];
}

export interface QrOptions {
  /**
   * Quiet zone width. The specification says 4, which is the default and what
   * anything printed should use; a terminal that would otherwise have to drop
   * the code entirely may trade it down.
   */
  readonly quiet?: number;
}

/** The one expected failure: more bytes than version 10 at level M holds. */
export type QrError = "too_long";

// ---- the tables ----

/**
 * Per version: error-correction codewords per block, then the block groups as
 * `[count, data codewords]`. Both groups are present from version 8 up, where
 * the data does not divide evenly and the specification splits it into blocks
 * of two adjacent sizes (ISO/IEC 18004 tables 13–22, level M).
 */
const BLOCKS: readonly {
  readonly ec: number;
  readonly groups: readonly (readonly [number, number])[];
}[] = [
  { ec: 10, groups: [[1, 16]] }, // v1  · 26 codewords
  { ec: 16, groups: [[1, 28]] }, // v2  · 44
  { ec: 26, groups: [[1, 44]] }, // v3  · 70
  { ec: 18, groups: [[2, 32]] }, // v4  · 100
  { ec: 24, groups: [[2, 43]] }, // v5  · 134
  { ec: 16, groups: [[4, 27]] }, // v6  · 172
  { ec: 18, groups: [[4, 31]] }, // v7  · 196
  {
    ec: 22,
    groups: [
      [2, 38],
      [2, 39],
    ],
  }, // v8  · 242
  {
    ec: 22,
    groups: [
      [3, 36],
      [2, 37],
    ],
  }, // v9  · 292
  {
    ec: 26,
    groups: [
      [4, 43],
      [1, 44],
    ],
  }, // v10 · 346
];

/** Alignment-pattern centre coordinates, per version (empty at version 1). */
const ALIGN: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/**
 * Bits left over after the interleaved codewords, filled with zeroes. Only
 * versions 2–6 have any in the range we cover.
 */
const REMAINDER: readonly number[] = [0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

/** The format-information bits for level M — the level this file speaks. */
const EC_M = 0b00;

const MAX_VERSION = BLOCKS.length;

const dataCodewords = (version: number): number => {
  const spec = BLOCKS[version - 1]!;
  let total = 0;
  for (const [count, data] of spec.groups) total += count * data;
  return total;
};

/** Byte mode's character-count field: 8 bits below version 10, 16 above. */
const countBits = (version: number): number => (version < 10 ? 8 : 16);

// ---- GF(256) ----

// The field QR codes use: x⁸ + x⁴ + x³ + x² + 1, generator 2.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

const mul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;

/** The generator polynomial (x−α⁰)(x−α¹)…(x−α^{n−1}), coefficients high-first. */
function generator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      // Multiply by (x − αⁱ): the term shifts up a degree, and αⁱ times it
      // lands one place lower. Getting these two the wrong way round yields a
      // polynomial with the reciprocal roots — which still *looks* like error
      // correction and corrects nothing.
      next[j] = next[j]! ^ poly[j]!;
      next[j + 1] = next[j + 1]! ^ mul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** Polynomial division remainder — the block's error-correction codewords. */
function ecCodewords(data: Uint8Array, count: number): Uint8Array {
  const gen = generator(count);
  const rem = new Uint8Array(count);
  for (const byte of data) {
    const factor = byte ^ rem[0]!;
    rem.copyWithin(0, 1);
    rem[count - 1] = 0;
    for (let i = 0; i < count; i++) rem[i] = rem[i]! ^ mul(gen[i + 1]!, factor);
  }
  return rem;
}

// ---- the bitstream ----

function encodeBytes(bytes: Uint8Array, version: number): Uint8Array {
  const capacity = dataCodewords(version);
  const bits: number[] = [];
  const push = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, countBits(version));
  for (const byte of bytes) push(byte, 8);
  // Terminator, then whatever it takes to reach a byte boundary.
  const room = capacity * 8 - bits.length;
  push(0, Math.min(4, room));
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(capacity);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b]!;
    out[i / 8] = byte;
  }
  // The specification's pad bytes, alternating, to the end of the capacity.
  for (let i = bits.length / 8, pad = 0; i < capacity; i++, pad++)
    out[i] = pad % 2 === 0 ? 0xec : 0x11;
  return out;
}

/**
 * Split into blocks, add error correction to each, and interleave — the step
 * that makes a QR survive a thumb over one corner. A burst of damage lands
 * across many blocks, one or two codewords each, instead of destroying one
 * block entirely.
 */
function interleave(data: Uint8Array, version: number): Uint8Array {
  const spec = BLOCKS[version - 1]!;
  const blocks: { data: Uint8Array; ec: Uint8Array }[] = [];
  let at = 0;
  for (const [count, size] of spec.groups) {
    for (let i = 0; i < count; i++) {
      const chunk = data.subarray(at, at + size);
      at += size;
      blocks.push({ data: chunk, ec: ecCodewords(chunk, spec.ec) });
    }
  }
  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i++)
    for (const block of blocks)
      if (i < block.data.length) out.push(block.data[i]!);
  for (let i = 0; i < spec.ec; i++)
    for (const block of blocks) out.push(block.ec[i]!);
  return new Uint8Array(out);
}

// ---- the matrix ----

class Grid {
  readonly size: number;
  readonly dark: boolean[][];
  /** Function patterns: never masked, never carry data. */
  readonly fixed: boolean[][];

  constructor(readonly version: number) {
    this.size = 17 + 4 * version;
    this.dark = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
    this.fixed = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
  }

  set(row: number, col: number, dark: boolean): void {
    if (row < 0 || col < 0 || row >= this.size || col >= this.size) return;
    this.dark[row]![col] = dark;
    this.fixed[row]![col] = true;
  }

  patterns(): void {
    // Timing first: the alternating spine a scanner measures module size by.
    // It runs the full width, and the finder corners then paint over its ends
    // — that order is not a style choice, it is which pattern wins where they
    // overlap.
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }

    // Finders, with their separators: the 8×8 corner is decided by distance.
    for (const [row, col] of [
      [3, 3],
      [3, this.size - 4],
      [this.size - 4, 3],
    ] as const)
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(row + dy, col + dx, d !== 2 && d !== 4);
        }

    // Alignment patterns, at every centre pair that misses a finder.
    const centres = ALIGN[this.version - 1]!;
    for (const row of centres)
      for (const col of centres) {
        const corner =
          (row === 6 && col === 6) ||
          (row === 6 && col === this.size - 7) ||
          (row === this.size - 7 && col === 6);
        if (corner) continue;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            this.set(
              row + dy,
              col + dx,
              Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
            );
      }

    // The format areas hold no data, so reserve them before the zigzag runs.
    // Index 6 is skipped in both: that cell belongs to the timing pattern,
    // which the format information runs around rather than through.
    for (let i = 0; i < 9; i++) {
      if (i === 6) continue;
      this.set(8, i, false);
      this.set(i, 8, false);
    }
    for (let i = 0; i < 8; i++) {
      this.set(8, this.size - 1 - i, false);
      this.set(this.size - 1 - i, 8, false);
    }
    if (this.version >= 7)
      for (let i = 0; i < 18; i++) {
        const a = this.size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(b, a, false);
        this.set(a, b, false);
      }
  }

  /** The zigzag: two columns at a time, upward then downward, skipping the
   * vertical timing column — the one place the pattern is not a pure snake. */
  place(codewords: Uint8Array): void {
    let bit = 0;
    const total = codewords.length * 8;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < this.size; v++)
        for (let j = 0; j < 2; j++) {
          const col = right - j;
          const upward = ((right + 1) & 2) === 0;
          const row = upward ? this.size - 1 - v : v;
          if (this.fixed[row]![col]) continue;
          if (bit < total)
            this.dark[row]![col] =
              ((codewords[bit >> 3]! >> (7 - (bit & 7))) & 1) === 1;
          bit++;
        }
    }
  }

  applyMask(mask: number): void {
    for (let row = 0; row < this.size; row++)
      for (let col = 0; col < this.size; col++)
        if (!this.fixed[row]![col] && maskAt(mask, row, col))
          this.dark[row]![col] = !this.dark[row]![col];
  }

  /** Format information, both copies, plus the module that is always dark. */
  format(mask: number): void {
    const data = (EC_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const at = (i: number): boolean => ((bits >> i) & 1) === 1;

    for (let i = 0; i <= 5; i++) this.set(i, 8, at(i));
    this.set(7, 8, at(6));
    this.set(8, 8, at(7));
    this.set(8, 7, at(8));
    for (let i = 9; i < 15; i++) this.set(8, 14 - i, at(i));

    for (let i = 0; i < 8; i++) this.set(8, this.size - 1 - i, at(i));
    for (let i = 8; i < 15; i++) this.set(this.size - 15 + i, 8, at(i));
    this.set(this.size - 8, 8, true);
  }

  /** Version information, from version 7 up: the reader's size cross-check. */
  versionInfo(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const on = ((bits >> i) & 1) === 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(b, a, on);
      this.set(a, b, on);
    }
  }
}

function maskAt(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

/**
 * The four penalty rules from the specification's table 11: runs of five or
 * more in a line (N1 = 3, +1 per extra module), solid 2×2 blocks (N2 = 3),
 * the finder-lookalike 1:1:3:1:1 with a light area four times its unit beside
 * it (N3 = 40), and drift away from half dark (N4 = 10 per 5%). Lowest total
 * wins, which is what keeps a symbol from growing large blank fields or a
 * second thing that looks like a finder.
 *
 * N3 is the rule everyone implements differently. Two details decide it, and
 * both are in the specification: the ratio is a *ratio*, so a pattern drawn
 * at two or three modules per unit counts as much as one at a single module;
 * and the quiet zone is light, so a lookalike flush against the symbol's edge
 * has its light area whether or not the modules exist. Both fall out of
 * scoring runs rather than fixed-width bit patterns, which is why this walks
 * a history of the last seven runs instead of matching a string.
 */
function penalty(grid: Grid): number {
  const n = grid.size;
  const dark = grid.dark;
  let score = 0;

  /** The last seven run lengths, newest first — five for the pattern, one
   * light run on each side of it. */
  const remember = (history: number[], run: number): void => {
    // The run that opens a line is preceded by the quiet zone, so it counts
    // as that much longer.
    if (history[0] === 0) run += n;
    history.pop();
    history.unshift(run);
  };

  const finders = (history: number[]): number => {
    const unit = history[1]!;
    const core =
      unit > 0 &&
      history[2] === unit &&
      history[3] === unit * 3 &&
      history[4] === unit &&
      history[5] === unit;
    if (!core) return 0;
    return (
      (history[0]! >= unit * 4 && history[6]! >= unit ? 1 : 0) +
      (history[6]! >= unit * 4 && history[0]! >= unit ? 1 : 0)
    );
  };

  const line = (get: (i: number) => boolean): void => {
    const history = [0, 0, 0, 0, 0, 0, 0];
    let colour = false;
    let run = 0;
    for (let i = 0; i < n; i++) {
      if (get(i) === colour) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else {
        remember(history, run);
        if (!colour) score += finders(history) * 40;
        colour = get(i);
        run = 1;
      }
    }
    // Terminate against the quiet zone on the far side.
    if (colour) {
      remember(history, run);
      run = 0;
    }
    remember(history, run + n);
    score += finders(history) * 40;
  };
  for (let row = 0; row < n; row++) line((i) => dark[row]![i]!);
  for (let col = 0; col < n; col++) line((i) => dark[i]![col]!);

  for (let row = 0; row < n - 1; row++)
    for (let col = 0; col < n - 1; col++) {
      const a = dark[row]![col]!;
      if (
        a === dark[row]![col + 1] &&
        a === dark[row + 1]![col] &&
        a === dark[row + 1]![col + 1]
      )
        score += 3;
    }

  let on = 0;
  for (const row of dark) for (const cell of row) if (cell) on++;
  const total = n * n;
  // How many whole 5% steps the dark proportion sits away from half, with the
  // boundary belonging to the lower band.
  const steps = Math.ceil(Math.abs(on * 20 - total * 10) / total) - 1;
  score += Math.max(0, steps) * 10;
  return score;
}

// ---- the encoder ----

/**
 * Encode `text` as a QR symbol. UTF-8 bytes in byte mode, which is what every
 * scanner on a phone assumes and what a URL needs.
 */
export function qrEncode(
  text: string,
  options: QrOptions = {},
): Result<QrCode, QrError> {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (4 + countBits(v) + 8 * bytes.length <= 8 * dataCodewords(v)) {
      version = v;
      break;
    }
  }
  if (version === 0) return err("too_long");

  const codewords = interleave(encodeBytes(bytes, version), version);
  const padded = new Uint8Array(
    codewords.length + Math.ceil(REMAINDER[version - 1]! / 8),
  );
  padded.set(codewords);

  let best: Grid | null = null;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const grid = new Grid(version);
    grid.patterns();
    grid.versionInfo();
    grid.place(padded);
    grid.applyMask(mask);
    grid.format(mask);
    const score = penalty(grid);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      best = grid;
    }
  }
  const grid = best!;

  const quiet = Math.max(0, Math.trunc(options.quiet ?? 4));
  const width = grid.size + quiet * 2;
  const modules: boolean[][] = [];
  for (let row = 0; row < width; row++) {
    const line = new Array<boolean>(width).fill(false);
    if (row >= quiet && row < quiet + grid.size)
      for (let col = 0; col < grid.size; col++)
        line[quiet + col] = grid.dark[row - quiet]![col]!;
    modules.push(line);
  }
  return ok({ version, mask: bestMask, size: grid.size, quiet, modules });
}

/** The largest string this encoder can carry (version 10, level M, UTF-8). */
export const QR_MAX_BYTES = dataCodewords(MAX_VERSION) - 3;

// ---- renderers ----

/**
 * Half-block rows for a terminal: two module rows per text row, so a module
 * is one column wide and half a row tall — square in every terminal whose
 * cells are about twice as tall as they are wide, which is all of them.
 *
 * The glyphs are foreground-on-background, so the caller paints these with a
 * dark foreground on a light background and gets a scannable code whatever
 * the theme is doing. Colour inversion is the one thing scanners refuse.
 */
export function qrRows(code: QrCode): string[] {
  const rows: string[] = [];
  const width = code.modules.length;
  const blank: QrRow = new Array<boolean>(width).fill(false);
  for (let y = 0; y < width; y += 2) {
    const top = code.modules[y] ?? blank;
    const bottom = code.modules[y + 1] ?? blank;
    let line = "";
    for (let x = 0; x < width; x++)
      line += top[x] ? (bottom[x] ? "█" : "▀") : bottom[x] ? "▄" : " ";
    rows.push(line);
  }
  return rows;
}

export interface QrSvgOptions {
  /** Pixels per module. The SVG scales anyway; this sets the intrinsic size. */
  readonly scale?: number;
  readonly title?: string;
  readonly className?: string;
}

/**
 * An inline SVG: one white rectangle and one black path of every dark module,
 * with `crispEdges` so a browser never antialiases a module into grey. No
 * external request, no data URI, and it prints and scales without a raster.
 */
export function qrSvg(code: QrCode, options: QrSvgOptions = {}): string {
  const n = code.modules.length;
  const scale = Math.max(1, Math.trunc(options.scale ?? 4));
  const parts: string[] = [];
  for (let row = 0; row < n; row++) {
    let col = 0;
    while (col < n) {
      if (!code.modules[row]![col]) {
        col++;
        continue;
      }
      let run = 0;
      while (col + run < n && code.modules[row]![col + run]) run++;
      parts.push(`M${col} ${row}h${run}v1h-${run}z`);
      col += run;
    }
  }
  const title = options.title ?? "QR code";
  const cls =
    options.className === undefined ? "" : ` class="${options.className}"`;
  return (
    `<svg${cls} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" ` +
    `width="${n * scale}" height="${n * scale}" shape-rendering="crispEdges" ` +
    `role="img" aria-label="${escapeAttr(title)}">` +
    `<rect width="${n}" height="${n}" fill="#ffffff"/>` +
    `<path fill="#000000" d="${parts.join("")}"/>` +
    `</svg>`
  );
}

function escapeAttr(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
