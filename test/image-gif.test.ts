/**
 * The GIF decoder — first frame only, which is the product decision, so the
 * tests check that it is the *first* frame and not a composite of several.
 *
 * The synthetic half builds GIFs with the "uncompressed LZW" trick: emit a
 * clear code often enough that the dictionary never grows and every code
 * stays nine bits wide. That gives exact control over palettes, interlacing
 * and transparency without an encoder. It deliberately does *not* exercise
 * dictionary growth — which is where LZW decoders actually break — so the
 * fixture written by giflib (through Pillow) carries that half of the work.
 */

import { describe, expect, test } from "bun:test";
import { decodeGif, gifHeader, isGif } from "../src/design/image/gif.ts";

const FIXTURES = `${import.meta.dir}/fixtures`;

interface Img {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function pixel(img: Img, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return [img.rgba[i]!, img.rgba[i + 1]!, img.rgba[i + 2]!, img.rgba[i + 3]!];
}

// ---------------------------------------------------------------------------
// A GIF writer that never grows its dictionary
// ---------------------------------------------------------------------------

interface GifOpts {
  readonly width: number;
  readonly height: number;
  readonly global?: number[][];
  readonly local?: number[][];
  readonly indices: readonly number[];
  readonly interlace?: boolean;
  readonly transparent?: number;
  /** Draw the frame at an offset inside a larger logical screen. */
  readonly frame?: { x: number; y: number; w: number; h: number };
}

function paletteBytes(colors: number[][], size: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < size; i++) {
    const c = colors[i] ?? [0, 0, 0];
    out.push(c[0]!, c[1]!, c[2]!);
  }
  return out;
}

/**
 * Nine-bit codes, least-significant-bit first, with a clear code every 250
 * literals so the width never has to grow. This is the shape libraries use to
 * write "store, don't compress" GIFs.
 */
function lzwLiteral(indices: readonly number[]): number[] {
  const out: number[] = [];
  let bitBuf = 0;
  let bitCount = 0;
  const push = (code: number): void => {
    bitBuf |= code << bitCount;
    bitCount += 9;
    while (bitCount >= 8) {
      out.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };
  push(256); // clear
  let since = 0;
  for (const index of indices) {
    push(index);
    if (++since >= 250) {
      push(256);
      since = 0;
    }
  }
  push(257); // end of information
  if (bitCount > 0) out.push(bitBuf & 0xff);
  return out;
}

function subBlocks(data: readonly number[]): number[] {
  const out: number[] = [];
  for (let at = 0; at < data.length; at += 255) {
    const part = data.slice(at, at + 255);
    out.push(part.length, ...part);
  }
  out.push(0);
  return out;
}

function writeGif(o: GifOpts): Uint8Array {
  const bytes: number[] = [];
  for (const ch of "GIF89a") bytes.push(ch.charCodeAt(0));
  bytes.push(o.width & 0xff, o.width >> 8, o.height & 0xff, o.height >> 8);
  // A 256-entry global colour table when one was given; size bits are
  // log2(entries) - 1, so 7 means 256.
  bytes.push(o.global ? 0x80 | 0x07 : 0x00, 0x00, 0x00);
  if (o.global) bytes.push(...paletteBytes(o.global, 256));

  if (o.transparent !== undefined)
    bytes.push(0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, o.transparent, 0x00);

  const f = o.frame ?? { x: 0, y: 0, w: o.width, h: o.height };
  bytes.push(0x2c);
  bytes.push(f.x & 0xff, f.x >> 8, f.y & 0xff, f.y >> 8);
  bytes.push(f.w & 0xff, f.w >> 8, f.h & 0xff, f.h >> 8);
  bytes.push(
    (o.local ? 0x80 | 0x07 : 0x00) | (o.interlace === true ? 0x40 : 0x00),
  );
  if (o.local) bytes.push(...paletteBytes(o.local, 256));
  bytes.push(8); // LZW minimum code size
  bytes.push(...subBlocks(lzwLiteral(o.indices)));
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}

const RGB: number[][] = [
  [0, 0, 0],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
];

// ---------------------------------------------------------------------------

describe("sniffing and geometry", () => {
  test("both signatures, and nothing else", () => {
    expect(isGif(new TextEncoder().encode("GIF89a______"))).toBe(true);
    expect(isGif(new TextEncoder().encode("GIF87a______"))).toBe(true);
    expect(isGif(new TextEncoder().encode("GIF88a______"))).toBe(false);
    expect(isGif(new Uint8Array(3))).toBe(false);
  });

  test("geometry comes from the logical screen, not the frame", () => {
    const bytes = writeGif({
      width: 8,
      height: 4,
      global: RGB,
      indices: new Array(4).fill(1),
      frame: { x: 2, y: 1, w: 2, h: 2 },
    });
    expect(gifHeader(bytes)).toEqual({
      ok: true,
      value: { width: 8, height: 4 },
    });
    const out = decodeGif(bytes);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect([out.value.width, out.value.height]).toEqual([8, 4]);
    // Inside the frame: red. Outside: never written, so fully transparent.
    expect(pixel(out.value, 2, 1)).toEqual([255, 0, 0, 255]);
    expect(pixel(out.value, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(out.value, 7, 3)).toEqual([0, 0, 0, 0]);
  });

  test("a zero dimension is corrupt", () => {
    const bytes = writeGif({
      width: 0,
      height: 4,
      global: RGB,
      indices: [],
    });
    expect(gifHeader(bytes)).toEqual({ ok: false, error: "corrupt" });
  });
});

describe("palettes", () => {
  test("indices resolve through the global colour table", () => {
    const out = decodeGif(
      writeGif({ width: 4, height: 1, global: RGB, indices: [0, 1, 2, 3] }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(pixel(out.value, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(out.value, 1, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(out.value, 2, 0)).toEqual([0, 255, 0, 255]);
    expect(pixel(out.value, 3, 0)).toEqual([0, 0, 255, 255]);
  });

  test("a local table overrides the global one", () => {
    const out = decodeGif(
      writeGif({
        width: 2,
        height: 1,
        global: RGB,
        local: [
          [1, 2, 3],
          [9, 9, 9],
        ],
        indices: [0, 1],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(pixel(out.value, 0, 0)).toEqual([1, 2, 3, 255]);
    expect(pixel(out.value, 1, 0)).toEqual([9, 9, 9, 255]);
  });

  test("no colour table at all is corrupt", () => {
    const bytes = writeGif({ width: 2, height: 1, indices: [0, 1] });
    expect(decodeGif(bytes)).toEqual({ ok: false, error: "corrupt" });
  });
});

describe("transparency", () => {
  test("the graphic control extension's index becomes alpha 0", () => {
    const out = decodeGif(
      writeGif({
        width: 3,
        height: 1,
        global: RGB,
        transparent: 2,
        indices: [1, 2, 3],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(pixel(out.value, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(out.value, 1, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(out.value, 2, 0)).toEqual([0, 0, 255, 255]);
  });
});

describe("interlacing", () => {
  test("the four passes land on the right rows", () => {
    // Eight rows, each filled with its own palette index, written in GIF's
    // interlaced order: rows 0, 4 (pass 3 gives 2, 6), then 1, 3, 5, 7.
    // Encoding stores them in pass order; decoding must put them back.
    const order = [0, 4, 2, 6, 1, 3, 5, 7];
    const indices: number[] = [];
    for (const row of order) indices.push(row, row);
    const palette = Array.from({ length: 8 }, (_, i) => [i * 10, 0, 0]);
    const out = decodeGif(
      writeGif({
        width: 2,
        height: 8,
        global: palette,
        interlace: true,
        indices,
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    for (let y = 0; y < 8; y++) expect(pixel(out.value, 0, y)[0]).toBe(y * 10);
  });
});

describe("a fixture written by giflib", () => {
  test("real LZW, with a dictionary that grows past nine bits", async () => {
    const bytes = new Uint8Array(
      await Bun.file(`${FIXTURES}/quads.gif`).arrayBuffer(),
    );
    const out = decodeGif(bytes);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect([out.value.width, out.value.height]).toEqual([64, 48]);
    // The same quadrants the PNG and JPEG fixtures carry. A code-width bug
    // shifts every pixel after the first few hundred, so the *bottom* two
    // are the ones that matter.
    expect(pixel(out.value, 8, 20).slice(0, 3)).toEqual([255, 0, 0]);
    expect(pixel(out.value, 48, 4).slice(0, 3)).toEqual([0, 255, 0]);
    expect(pixel(out.value, 8, 40).slice(0, 3)).toEqual([0, 0, 255]);
    expect(pixel(out.value, 40, 44).slice(0, 3)).toEqual([255, 255, 255]);
    // The left eight columns were written with the transparent index.
    expect(pixel(out.value, 0, 0)[3]).toBe(0);
    expect(pixel(out.value, 7, 30)[3]).toBe(0);
    expect(pixel(out.value, 9, 30)[3]).toBe(255);
  });

  test("truncation is corrupt or partial, never a throw", async () => {
    const whole = new Uint8Array(
      await Bun.file(`${FIXTURES}/quads.gif`).arrayBuffer(),
    );
    for (const cut of [0.2, 0.5, 0.9]) {
      const out = decodeGif(whole.subarray(0, Math.floor(whole.length * cut)));
      if (out.ok) expect(out.value.rgba.length).toBe(64 * 48 * 4);
      else expect(out.error).toBe("corrupt");
    }
  });
});
