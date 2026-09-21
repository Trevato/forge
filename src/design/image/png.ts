/**
 * PNG → RGBA.
 *
 * The format is small enough to read end to end (RFC 2083 / W3C PNG 3rd ed.):
 * a signature, then length-prefixed chunks. Only five matter to us — IHDR
 * (geometry), PLTE (palette), tRNS (transparency), IDAT (the zlib stream) and
 * IEND. Everything else, including the ancillary colour-management chunks, is
 * skipped: a preview that is off by a gamma curve is still a preview, and
 * carrying an ICC transform here would cost more than the whole decoder.
 *
 * The one piece we do not write is inflate. `node:zlib`'s `inflateSync` is a
 * Bun built-in, not a dependency, and it speaks the zlib *wrapper* PNG uses —
 * `Bun.inflateSync` does not (it takes a raw deflate stream), which is a trap
 * worth naming since the two names look interchangeable.
 *
 * Filtering is where PNG decoders go wrong, so all five types are here and
 * all five are tested. Note the byte-vs-pixel rule: `a` is the byte `bpp`
 * positions back, where `bpp` is bytes-per-*pixel* rounded **up** to 1 — at
 * bit depths below 8 that means the previous byte, not the previous pixel.
 */

import { deflateSync, inflateSync } from "node:zlib";
import { err, ok, type Result } from "../../kernel/result.ts";

// ---- writing ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(
    [...type].map((ch) => ch.charCodeAt(0)),
    4,
  );
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * An 8-bit RGBA image as a PNG: one IDAT, filter type 0 on every row,
 * zlib from the runtime. Enough for an icon or a chart; a photograph goes
 * through the JPEG encoder next door.
 */
export function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Uint8Array {
  if (rgba.length !== width * height * 4)
    throw new Error("encodePng: rgba is not width × height × 4");
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(
      rgba.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1,
    );
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));
  const parts = [
    new Uint8Array(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export type PngError = "corrupt" | "unsupported";

export interface PngHeader {
  readonly width: number;
  readonly height: number;
  /** Bits per sample: 1, 2, 4, 8 or 16. */
  readonly depth: number;
  /** 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA. */
  readonly colorType: number;
  /** 0 none, 1 Adam7. */
  readonly interlace: number;
}

export interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Channels carried per pixel for a colour type; 0 for an unknown one. */
function channelsOf(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 3:
      return 1;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      return 0;
  }
}

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return false;
  return true;
}

/**
 * Geometry only — 33 bytes in, no inflate. Callers use this to refuse an
 * image that is too big *before* paying to decompress it.
 */
export function pngHeader(bytes: Uint8Array): Result<PngHeader, PngError> {
  if (!isPng(bytes) || bytes.length < 33) return err("corrupt");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(12) !== 0x49484452) return err("corrupt"); // "IHDR"
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const depth = bytes[24]!;
  const colorType = bytes[25]!;
  const compression = bytes[26]!;
  const filter = bytes[27]!;
  const interlace = bytes[28]!;
  if (width === 0 || height === 0) return err("corrupt");
  if (compression !== 0 || filter !== 0) return err("unsupported");
  if (interlace > 1) return err("unsupported");
  if (![1, 2, 4, 8, 16].includes(depth)) return err("corrupt");
  const channels = channelsOf(colorType);
  if (channels === 0) return err("corrupt");
  // Depth/colour-type pairs the spec forbids. Rejecting them here means the
  // sample readers below can assume a legal combination.
  if (colorType === 3 && depth === 16) return err("corrupt");
  if (colorType !== 0 && colorType !== 3 && depth < 8) return err("corrupt");
  return ok({ width, height, depth, colorType, interlace });
}

export function decodePng(bytes: Uint8Array): Result<PngImage, PngError> {
  const head = pngHeader(bytes);
  if (!head.ok) return head;
  const ihdr = head.value;

  let palette: Uint8Array | undefined;
  let alphas: Uint8Array | undefined;
  /** tRNS for grey/RGB: the single sample value that means transparent. */
  let colorKey: number[] | undefined;
  const idat: Uint8Array[] = [];

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let sawEnd = false;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    // A length that runs past the buffer is the classic malformed-PNG probe.
    if (length > 0x7fffffff || at + 12 + length > bytes.length)
      return err("corrupt");
    const type = String.fromCharCode(
      bytes[at + 4]!,
      bytes[at + 5]!,
      bytes[at + 6]!,
      bytes[at + 7]!,
    );
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "PLTE") palette = body.slice();
    else if (type === "tRNS") {
      if (ihdr.colorType === 3) alphas = body.slice();
      else if (ihdr.colorType === 0 && length >= 2)
        colorKey = [view.getUint16(at + 8)];
      else if (ihdr.colorType === 2 && length >= 6)
        colorKey = [
          view.getUint16(at + 8),
          view.getUint16(at + 10),
          view.getUint16(at + 12),
        ];
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") {
      sawEnd = true;
      break;
    }
    at += 12 + length; // length + type + data + CRC
  }
  if (!sawEnd && idat.length === 0) return err("corrupt");
  if (ihdr.colorType === 3 && palette === undefined) return err("corrupt");

  let raw: Uint8Array;
  try {
    raw = new Uint8Array(inflateSync(concat(idat)));
  } catch {
    return err("corrupt");
  }

  const rgba = new Uint8Array(ihdr.width * ihdr.height * 4);
  const ctx: Ctx = {
    ihdr,
    rgba,
    ...(palette !== undefined ? { palette } : {}),
    ...(alphas !== undefined ? { alphas } : {}),
    ...(colorKey !== undefined ? { colorKey } : {}),
  };
  const laid = ihdr.interlace === 1 ? adam7(ctx, raw) : progressive(ctx, raw);
  if (!laid.ok) return laid;
  return ok({ width: ihdr.width, height: ihdr.height, rgba });
}

interface Ctx {
  readonly ihdr: PngHeader;
  readonly rgba: Uint8Array;
  readonly palette?: Uint8Array;
  readonly alphas?: Uint8Array;
  readonly colorKey?: number[];
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The non-interlaced layout: one image, top to bottom. */
function progressive(ctx: Ctx, raw: Uint8Array): Result<void, PngError> {
  return pass(ctx, raw, 0, ctx.ihdr.width, ctx.ihdr.height, 0, 0, 1, 1);
}

/**
 * Adam7: seven passes over a repeating 8×8 grid. Refusing interlace would be
 * the honest cheap answer, but the passes are a table and a stride — the
 * unfiltering below is identical either way, so we decode it.
 */
const ADAM7: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function adam7(ctx: Ctx, raw: Uint8Array): Result<void, PngError> {
  const { width, height } = ctx.ihdr;
  let at = 0;
  for (const [x0, y0, dx, dy] of ADAM7) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const done = pass(ctx, raw, at, pw, ph, x0, y0, dx, dy);
    if (!done.ok) return done;
    at += ph * (1 + scanlineBytes(ctx.ihdr, pw));
  }
  return ok();
}

function scanlineBytes(ihdr: PngHeader, width: number): number {
  const bits = width * channelsOf(ihdr.colorType) * ihdr.depth;
  return (bits + 7) >> 3;
}

/**
 * Unfilter one pass and write its pixels into the RGBA plane.
 *
 * `raw` holds `height` rows, each a filter byte followed by `stride` data
 * bytes. Unfiltering is done into a rolling pair of buffers rather than in
 * place, because Adam7 hands us overlapping regions of the same array.
 */
function pass(
  ctx: Ctx,
  raw: Uint8Array,
  from: number,
  width: number,
  height: number,
  x0: number,
  y0: number,
  dx: number,
  dy: number,
): Result<void, PngError> {
  const { ihdr } = ctx;
  const channels = channelsOf(ihdr.colorType);
  const stride = scanlineBytes(ihdr, width);
  const bpp = Math.max(1, (channels * ihdr.depth) >> 3);
  if (from + height * (stride + 1) > raw.length) return err("corrupt");

  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  let at = from;
  for (let row = 0; row < height; row++) {
    const filter = raw[at++]!;
    cur.set(raw.subarray(at, at + stride));
    at += stride;
    if (!unfilter(filter, cur, prev, bpp)) return err("corrupt");
    writeRow(ctx, cur, width, x0, y0 + row * dy, dx);
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return ok();
}

function unfilter(
  filter: number,
  cur: Uint8Array,
  prev: Uint8Array,
  bpp: number,
): boolean {
  const n = cur.length;
  switch (filter) {
    case 0:
      return true;
    case 1:
      for (let i = bpp; i < n; i++) cur[i] = (cur[i]! + cur[i - bpp]!) & 0xff;
      return true;
    case 2:
      for (let i = 0; i < n; i++) cur[i] = (cur[i]! + prev[i]!) & 0xff;
      return true;
    case 3:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? cur[i - bpp]! : 0;
        cur[i] = (cur[i]! + ((a + prev[i]!) >> 1)) & 0xff;
      }
      return true;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? cur[i - bpp]! : 0;
        const b = prev[i]!;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        cur[i] = (cur[i]! + paeth(a, b, c)) & 0xff;
      }
      return true;
    default:
      return false;
  }
}

/** The predictor from the spec, verbatim in shape: nearest of a, b, a+b−c. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function writeRow(
  ctx: Ctx,
  row: Uint8Array,
  width: number,
  x0: number,
  y: number,
  dx: number,
): void {
  const { ihdr, rgba } = ctx;
  if (y >= ihdr.height) return;
  const channels = channelsOf(ihdr.colorType);
  const max = (1 << ihdr.depth) - 1;
  const samples = new Array<number>(channels);
  for (let px = 0; px < width; px++) {
    const x = x0 + px * dx;
    if (x >= ihdr.width) break;
    for (let c = 0; c < channels; c++)
      samples[c] = sample(row, ihdr.depth, px * channels + c);
    const out = (y * ihdr.width + x) * 4;
    emit(ctx, samples, max, rgba, out);
  }
}

/** One sample at index `i`, at the image's bit depth. 16-bit takes the MSB. */
function sample(row: Uint8Array, depth: number, i: number): number {
  if (depth === 8) return row[i] ?? 0;
  if (depth === 16) return row[i * 2] ?? 0; // downsample: keep the high byte
  const per = 8 / depth; // 8, 4 or 2 samples per byte
  const byte = row[Math.floor(i / per)] ?? 0;
  const shift = 8 - depth * ((i % per) + 1);
  return (byte >> shift) & ((1 << depth) - 1);
}

function emit(
  ctx: Ctx,
  s: number[],
  max: number,
  rgba: Uint8Array,
  out: number,
): void {
  const { colorType, depth } = ctx.ihdr;
  // 16-bit samples arrived already reduced to their high byte, so they scale
  // like 8-bit ones; sub-byte depths are stretched to fill 0..255.
  const up = (v: number): number =>
    depth >= 8 ? v : Math.round((v * 255) / max);
  switch (colorType) {
    case 0: {
      const g = up(s[0]!);
      rgba[out] = g;
      rgba[out + 1] = g;
      rgba[out + 2] = g;
      rgba[out + 3] = keyed(ctx, [s[0]!], depth) ? 0 : 255;
      return;
    }
    case 2: {
      rgba[out] = up(s[0]!);
      rgba[out + 1] = up(s[1]!);
      rgba[out + 2] = up(s[2]!);
      rgba[out + 3] = keyed(ctx, [s[0]!, s[1]!, s[2]!], depth) ? 0 : 255;
      return;
    }
    case 3: {
      const i = s[0]!;
      const p = ctx.palette;
      rgba[out] = p?.[i * 3] ?? 0;
      rgba[out + 1] = p?.[i * 3 + 1] ?? 0;
      rgba[out + 2] = p?.[i * 3 + 2] ?? 0;
      rgba[out + 3] = ctx.alphas?.[i] ?? 255;
      return;
    }
    case 4: {
      const g = up(s[0]!);
      rgba[out] = g;
      rgba[out + 1] = g;
      rgba[out + 2] = g;
      rgba[out + 3] = up(s[1]!);
      return;
    }
    default: {
      rgba[out] = up(s[0]!);
      rgba[out + 1] = up(s[1]!);
      rgba[out + 2] = up(s[2]!);
      rgba[out + 3] = up(s[3]!);
      return;
    }
  }
}

/**
 * tRNS on a non-palette image names one exact colour as transparent. The
 * chunk stores 16-bit samples whatever the depth, so compare on the raw
 * sample scale — at depth 16 ours is the high byte, and the key's low byte
 * is dropped to match. That loses a distinction no preview can show.
 */
function keyed(ctx: Ctx, s: number[], depth: number): boolean {
  const key = ctx.colorKey;
  if (key === undefined) return false;
  for (let i = 0; i < s.length; i++) {
    const want = depth === 16 ? (key[i]! >> 8) & 0xff : key[i]!;
    if (s[i] !== want) return false;
  }
  return true;
}
