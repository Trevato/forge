/**
 * GIF → RGBA, first frame only.
 *
 * A terminal preview is a still, so animation is deliberately out of scope:
 * we composite frame 1 onto the logical screen and stop. That keeps the whole
 * decoder to a palette, an LZW stream and an interlace table (GIF89a spec,
 * <https://www.w3.org/Graphics/GIF/spec-gif89a.txt>).
 *
 * The one subtlety worth naming is that GIF's LZW is *not* the same as TIFF's
 * or PDF's: codes are packed least-significant-bit first, the code width grows
 * when the next code would not fit, and clear/end codes sit immediately above
 * the palette. Getting the growth boundary wrong shifts every pixel after the
 * first few hundred, which is why the width bump is written as its own line.
 */

import { err, ok, type Result } from "../../kernel/result.ts";

export type GifError = "corrupt" | "unsupported";

export interface GifImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

export interface GifHeader {
  readonly width: number;
  readonly height: number;
}

export function isGif(bytes: Uint8Array): boolean {
  if (bytes.length < 6) return false;
  const tag = String.fromCharCode(...bytes.subarray(0, 6));
  return tag === "GIF87a" || tag === "GIF89a";
}

export function gifHeader(bytes: Uint8Array): Result<GifHeader, GifError> {
  if (!isGif(bytes) || bytes.length < 13) return err("corrupt");
  const width = bytes[6]! | (bytes[7]! << 8);
  const height = bytes[8]! | (bytes[9]! << 8);
  if (width === 0 || height === 0) return err("corrupt");
  return ok({ width, height });
}

export function decodeGif(bytes: Uint8Array): Result<GifImage, GifError> {
  const head = gifHeader(bytes);
  if (!head.ok) return head;
  const { width, height } = head.value;

  const packed = bytes[10]!;
  let at = 13;
  let global: Uint8Array | undefined;
  if ((packed & 0x80) !== 0) {
    const size = 3 * (1 << ((packed & 0x07) + 1));
    if (at + size > bytes.length) return err("corrupt");
    global = bytes.subarray(at, at + size);
    at += size;
  }

  // Transparency is carried by the Graphic Control Extension immediately
  // before the image, so it has to be tracked as we walk the block stream.
  let transparent = -1;
  while (at < bytes.length) {
    const block = bytes[at++]!;
    if (block === 0x3b) break; // trailer, with no image
    if (block === 0x21) {
      const label = bytes[at++]!;
      if (label === 0xf9) {
        const size = bytes[at]!;
        const flags = bytes[at + 1] ?? 0;
        transparent = (flags & 1) === 1 ? (bytes[at + 4] ?? -1) : -1;
        at += 1 + size;
      }
      at = skipSubBlocks(bytes, at);
      continue;
    }
    if (block !== 0x2c) return err("corrupt");

    if (at + 9 > bytes.length) return err("corrupt");
    const left = bytes[at]! | (bytes[at + 1]! << 8);
    const top = bytes[at + 2]! | (bytes[at + 3]! << 8);
    const fw = bytes[at + 4]! | (bytes[at + 5]! << 8);
    const fh = bytes[at + 6]! | (bytes[at + 7]! << 8);
    const local = bytes[at + 8]!;
    at += 9;

    let palette = global;
    if ((local & 0x80) !== 0) {
      const size = 3 * (1 << ((local & 0x07) + 1));
      if (at + size > bytes.length) return err("corrupt");
      palette = bytes.subarray(at, at + size);
      at += size;
    }
    if (palette === undefined) return err("corrupt");
    if (fw === 0 || fh === 0) return err("corrupt");

    const minCode = bytes[at++]!;
    if (minCode < 2 || minCode > 8) return err("corrupt");
    const data = gatherSubBlocks(bytes, at);
    const indices = lzw(data, minCode, fw * fh);
    if (!indices.ok) return indices;

    const rgba = new Uint8Array(width * height * 4);
    const rows = interlaced(local) ? interlaceRows(fh) : sequential(fh);
    for (let i = 0; i < rows.length; i++) {
      const y = top + rows[i]!;
      if (y < 0 || y >= height) continue;
      for (let x = 0; x < fw; x++) {
        const px = left + x;
        if (px < 0 || px >= width) continue;
        const index = indices.value[i * fw + x] ?? 0;
        const out = (y * width + px) * 4;
        if (index === transparent) continue; // stays 0,0,0,0
        rgba[out] = palette[index * 3] ?? 0;
        rgba[out + 1] = palette[index * 3 + 1] ?? 0;
        rgba[out + 2] = palette[index * 3 + 2] ?? 0;
        rgba[out + 3] = 255;
      }
    }
    return ok({ width, height, rgba });
  }
  return err("corrupt");
}

function interlaced(flags: number): boolean {
  return (flags & 0x40) !== 0;
}

function sequential(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/** GIF's four-pass interlace: every 8th from 0, then 4, then 4th from 2, … */
function interlaceRows(n: number): number[] {
  const out: number[] = [];
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ] as const)
    for (let y = start; y < n; y += step) out.push(y);
  return out;
}

function skipSubBlocks(bytes: Uint8Array, from: number): number {
  let at = from;
  while (at < bytes.length) {
    const size = bytes[at++]!;
    if (size === 0) break;
    at += size;
  }
  return at;
}

function gatherSubBlocks(bytes: Uint8Array, from: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let at = from;
  let total = 0;
  while (at < bytes.length) {
    const size = bytes[at++]!;
    if (size === 0) break;
    const part = bytes.subarray(at, Math.min(at + size, bytes.length));
    parts.push(part);
    total += part.length;
    at += size;
  }
  const out = new Uint8Array(total);
  let put = 0;
  for (const p of parts) {
    out.set(p, put);
    put += p.length;
  }
  return out;
}

/**
 * GIF variable-width LZW. The dictionary is held as (prefix, suffix) pairs
 * rather than materialised strings, which is both faster and how the encoder
 * thinks; a decoded entry is emitted by walking prefixes backwards into a
 * scratch stack.
 */
function lzw(
  data: Uint8Array,
  minCode: number,
  expected: number,
): Result<Uint8Array, GifError> {
  const clear = 1 << minCode;
  const end = clear + 1;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4096);
  const out = new Uint8Array(expected);
  let put = 0;

  let width = minCode + 1;
  let next = end + 1;
  let previous = -1;
  /** First byte of the previous entry — what the KwKwK case appends. */
  let previousFirst = 0;
  let bitBuf = 0;
  let bitCount = 0;
  let at = 0;

  while (put < expected) {
    while (bitCount < width) {
      if (at >= data.length) return put === 0 ? err("corrupt") : ok(out);
      // Least-significant-bit-first packing: each new byte goes on top.
      bitBuf |= data[at++]! << bitCount;
      bitCount += 8;
    }
    const code = bitBuf & ((1 << width) - 1);
    bitBuf >>>= width;
    bitCount -= width;

    if (code === clear) {
      width = minCode + 1;
      next = end + 1;
      previous = -1;
      previousFirst = 0;
      continue;
    }
    if (code === end) break;

    let top = 0;
    let current = code;
    if (code >= next) {
      // The KwKwK case: a code for the entry we are about to create, which
      // is always the previous entry followed by its own first byte. That
      // byte is emitted last, so it goes on the (reversed) stack first.
      if (previous < 0) return err("corrupt");
      stack[top++] = previousFirst;
      current = previous;
    }
    let guard = 0;
    while (current >= clear) {
      if (++guard > 4096) return err("corrupt");
      stack[top++] = suffix[current]!;
      current = prefix[current]!;
    }
    stack[top++] = current & 0xff;
    // `stack` holds the entry reversed; the first byte out is also the suffix
    // of the new dictionary entry.
    const firstByte = stack[top - 1]!;
    while (top > 0 && put < expected) out[put++] = stack[--top]!;

    if (previous >= 0 && next < 4096) {
      prefix[next] = previous;
      suffix[next] = firstByte;
      next++;
      // Grow *before* the next read, on the boundary — one off here and
      // everything downstream shifts.
      if (next === 1 << width && width < 12) width++;
    }
    previous = code;
    previousFirst = firstByte;
  }
  return ok(out);
}
