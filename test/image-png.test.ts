/**
 * The PNG decoder, against images this file encodes and against images a real
 * encoder produced.
 *
 * Both halves are needed and they catch different things. The synthetic half
 * has a tiny encoder below it — 80 lines, `node:zlib` for the deflate — which
 * lets a test say "this exact 4×4 image, filtered with Paeth, at 4 bits per
 * sample" and know the answer pixel for pixel. That is the only way to cover
 * all five filter types and all five colour types deliberately; no natural
 * corpus contains 2-bit greyscale.
 *
 * The fixture half is `test/fixtures/quads*.png`, written by Pillow
 * (libpng) — an encoder that owes us nothing. It is what proves the decoder
 * reads *PNG*, not "the subset our own encoder happens to emit".
 */

import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { decodePng, pngHeader } from "../src/design/image/png.ts";

// ---------------------------------------------------------------------------
// A minimal PNG encoder, for the synthetic half
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

interface EncodeOpts {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly colorType: number;
  /** One entry per row: the already-packed sample bytes. */
  readonly rows: readonly Uint8Array[];
  /** One filter type per row (0–4). Defaults to 0 everywhere. */
  readonly filters?: readonly number[];
  readonly palette?: Uint8Array;
  readonly trns?: Uint8Array;
}

function encodePng(o: EncodeOpts): Uint8Array {
  const channels = [1, 0, 3, 1, 2, 0, 4][o.colorType] ?? 1;
  const bpp = Math.max(1, (channels * o.depth) >> 3);
  const stride = o.rows[0]?.length ?? 0;
  const raw = new Uint8Array(o.rows.length * (stride + 1));
  let at = 0;
  let prev: Uint8Array<ArrayBufferLike> = new Uint8Array(stride);
  for (const [i, row] of o.rows.entries()) {
    const filter = o.filters?.[i] ?? 0;
    raw[at++] = filter;
    for (let k = 0; k < stride; k++) {
      const x = row[k]!;
      const a = k >= bpp ? row[k - bpp]! : 0;
      const b = prev[k]!;
      const c = k >= bpp ? prev[k - bpp]! : 0;
      const predicted =
        filter === 1
          ? a
          : filter === 2
            ? b
            : filter === 3
              ? (a + b) >> 1
              : filter === 4
                ? paeth(a, b, c)
                : 0;
      raw[at++] = (x - predicted) & 0xff;
    }
    prev = row;
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, o.width);
  view.setUint32(4, o.height);
  ihdr[8] = o.depth;
  ihdr[9] = o.colorType;
  const parts: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
  ];
  if (o.palette) parts.push(chunk("PLTE", o.palette));
  if (o.trns) parts.push(chunk("tRNS", o.trns));
  parts.push(chunk("IDAT", new Uint8Array(deflateSync(raw))));
  parts.push(chunk("IEND", new Uint8Array(0)));

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let put = 0;
  for (const p of parts) {
    out.set(p, put);
    put += p.length;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pixel(
  img: { width: number; rgba: Uint8Array },
  x: number,
  y: number,
): number[] {
  const i = (y * img.width + x) * 4;
  return [img.rgba[i]!, img.rgba[i + 1]!, img.rgba[i + 2]!, img.rgba[i + 3]!];
}

const FIXTURES = `${import.meta.dir}/fixtures`;

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(`${FIXTURES}/${name}`).arrayBuffer());
}

// ---------------------------------------------------------------------------

describe("pngHeader", () => {
  test("reads geometry without inflating", () => {
    const bytes = encodePng({
      width: 3,
      height: 2,
      depth: 8,
      colorType: 2,
      rows: [new Uint8Array(9), new Uint8Array(9)],
    });
    const head = pngHeader(bytes);
    expect(head.ok).toBe(true);
    if (!head.ok) return;
    expect(head.value).toEqual({
      width: 3,
      height: 2,
      depth: 8,
      colorType: 2,
      interlace: 0,
    });
  });

  test("rejects a wrong signature, a zero dimension and an illegal depth", () => {
    expect(pngHeader(new Uint8Array(64)).ok).toBe(false);
    const zero = encodePng({
      width: 0,
      height: 1,
      depth: 8,
      colorType: 2,
      rows: [new Uint8Array(0)],
    });
    expect(pngHeader(zero)).toEqual({ ok: false, error: "corrupt" });
    // Colour type 2 (RGB) at 4 bits is a combination the spec forbids.
    const bad = encodePng({
      width: 1,
      height: 1,
      depth: 4,
      colorType: 2,
      rows: [new Uint8Array(2)],
    });
    expect(pngHeader(bad)).toEqual({ ok: false, error: "corrupt" });
  });

  test("a truncated stream is corrupt, not a throw", () => {
    const bytes = encodePng({
      width: 2,
      height: 2,
      depth: 8,
      colorType: 6,
      rows: [new Uint8Array(8), new Uint8Array(8)],
    });
    expect(decodePng(bytes.subarray(0, bytes.length - 20)).ok).toBe(false);
    // A plausible header over garbage IDAT: inflate fails, we say corrupt.
    const mangled = bytes.slice();
    mangled[bytes.length - 20] = 0xff;
    mangled[bytes.length - 19] = 0xff;
    expect(decodePng(mangled).ok).toBe(false);
  });
});

describe("colour types", () => {
  test("8-bit RGBA is passed through unchanged", () => {
    const row = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 9, 8, 7, 6,
    ]);
    const out = decodePng(
      encodePng({ width: 4, height: 1, depth: 8, colorType: 6, rows: [row] }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect([...out.value.rgba]).toEqual([...row]);
  });

  test("8-bit RGB gets a full alpha channel", () => {
    const row = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const out = decodePng(
      encodePng({ width: 2, height: 1, depth: 8, colorType: 2, rows: [row] }),
    );
    expect(out.ok && [...out.value.rgba]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  test("8-bit greyscale replicates across R, G and B", () => {
    const out = decodePng(
      encodePng({
        width: 2,
        height: 1,
        depth: 8,
        colorType: 0,
        rows: [new Uint8Array([0x40, 0xc0])],
      }),
    );
    expect(out.ok && [...out.value.rgba]).toEqual([
      0x40, 0x40, 0x40, 255, 0xc0, 0xc0, 0xc0, 255,
    ]);
  });

  test("greyscale + alpha keeps the alpha", () => {
    const out = decodePng(
      encodePng({
        width: 2,
        height: 1,
        depth: 8,
        colorType: 4,
        rows: [new Uint8Array([0x10, 0x20, 0x30, 0x40])],
      }),
    );
    expect(out.ok && [...out.value.rgba]).toEqual([
      0x10, 0x10, 0x10, 0x20, 0x30, 0x30, 0x30, 0x40,
    ]);
  });

  test("a palette image resolves through PLTE", () => {
    const out = decodePng(
      encodePng({
        width: 3,
        height: 1,
        depth: 8,
        colorType: 3,
        palette: new Uint8Array([9, 9, 9, 200, 100, 50, 0, 0, 0]),
        rows: [new Uint8Array([1, 0, 2])],
      }),
    );
    expect(out.ok && [...out.value.rgba]).toEqual([
      200, 100, 50, 255, 9, 9, 9, 255, 0, 0, 0, 255,
    ]);
  });

  test("a palette with no PLTE is corrupt", () => {
    const bytes = encodePng({
      width: 1,
      height: 1,
      depth: 8,
      colorType: 3,
      rows: [new Uint8Array([0])],
    });
    expect(decodePng(bytes)).toEqual({ ok: false, error: "corrupt" });
  });

  test("16-bit samples are downsampled to their high byte", () => {
    // 0x1234 → 0x12, 0xfedc → 0xfe.
    const row = new Uint8Array([
      0x12, 0x34, 0x00, 0x00, 0xfe, 0xdc, 0xff, 0xff,
    ]);
    const out = decodePng(
      encodePng({ width: 2, height: 1, depth: 16, colorType: 4, rows: [row] }),
    );
    expect(out.ok && [...out.value.rgba]).toEqual([
      0x12, 0x12, 0x12, 0x00, 0xfe, 0xfe, 0xfe, 0xff,
    ]);
  });
});

describe("sub-byte bit depths", () => {
  test("1-bit greyscale stretches to the full range", () => {
    // 0b10110000: pixels 1,0,1,1,0,0,0,0 across 8 columns.
    const out = decodePng(
      encodePng({
        width: 8,
        height: 1,
        depth: 1,
        colorType: 0,
        rows: [new Uint8Array([0b10110000])],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const greys = [];
    for (let x = 0; x < 8; x++) greys.push(pixel(out.value, x, 0)[0]);
    expect(greys).toEqual([255, 0, 255, 255, 0, 0, 0, 0]);
  });

  test("2-bit greyscale maps 0..3 onto 0, 85, 170, 255", () => {
    const out = decodePng(
      encodePng({
        width: 4,
        height: 1,
        depth: 2,
        colorType: 0,
        rows: [new Uint8Array([0b00011011])],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const greys = [];
    for (let x = 0; x < 4; x++) greys.push(pixel(out.value, x, 0)[0]);
    expect(greys).toEqual([0, 85, 170, 255]);
  });

  test("4-bit palette indexes two pixels per byte", () => {
    const palette = new Uint8Array(48);
    palette[3] = 111; // index 1 → (111,0,0)
    palette[6] = 0;
    palette[7] = 222; // index 2 → (0,222,0)
    const out = decodePng(
      encodePng({
        width: 2,
        height: 1,
        depth: 4,
        colorType: 3,
        palette,
        rows: [new Uint8Array([0x12])],
      }),
    );
    expect(out.ok && [...out.value.rgba]).toEqual([
      111, 0, 0, 255, 0, 222, 0, 255,
    ]);
  });
});

describe("filters", () => {
  // One picture, five encodings. Every filter type must reconstruct it
  // exactly: an unfilter bug shows as a smear that only appears past column
  // one, which is why the image has a gradient in both directions.
  const width = 6;
  const height = 5;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(width * 3);
    for (let x = 0; x < width; x++) {
      row[x * 3] = (x * 37 + y * 11) & 0xff;
      row[x * 3 + 1] = (x * 5 + y * 61) & 0xff;
      row[x * 3 + 2] = (x * 200 + y * 3) & 0xff;
    }
    rows.push(row);
  }
  const expected = decodePng(
    encodePng({ width, height, depth: 8, colorType: 2, rows }),
  );

  for (const filter of [0, 1, 2, 3, 4]) {
    test(`filter type ${filter} reconstructs the same pixels`, () => {
      const out = decodePng(
        encodePng({
          width,
          height,
          depth: 8,
          colorType: 2,
          rows,
          filters: new Array(height).fill(filter),
        }),
      );
      expect(out.ok).toBe(true);
      expect(expected.ok).toBe(true);
      if (!out.ok || !expected.ok) return;
      expect([...out.value.rgba]).toEqual([...expected.value.rgba]);
    });
  }

  test("filters may differ per row, as real encoders emit them", () => {
    const out = decodePng(
      encodePng({
        width,
        height,
        depth: 8,
        colorType: 2,
        rows,
        filters: [0, 4, 2, 1, 3],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok || !expected.ok) return;
    expect([...out.value.rgba]).toEqual([...expected.value.rgba]);
  });

  test("an unknown filter type is corrupt, not a guess", () => {
    const bytes = encodePng({
      width: 2,
      height: 1,
      depth: 8,
      colorType: 2,
      rows: [new Uint8Array(6)],
      filters: [9],
    });
    expect(decodePng(bytes)).toEqual({ ok: false, error: "corrupt" });
  });
});

describe("transparency", () => {
  test("tRNS on a palette gives per-index alpha", () => {
    const out = decodePng(
      encodePng({
        width: 3,
        height: 1,
        depth: 8,
        colorType: 3,
        palette: new Uint8Array([1, 1, 1, 2, 2, 2, 3, 3, 3]),
        trns: new Uint8Array([0, 128]),
        rows: [new Uint8Array([0, 1, 2])],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(pixel(out.value, 0, 0)[3]).toBe(0);
    expect(pixel(out.value, 1, 0)[3]).toBe(128);
    // An index past the end of tRNS is opaque.
    expect(pixel(out.value, 2, 0)[3]).toBe(255);
  });

  test("tRNS on RGB is a colour key", () => {
    const out = decodePng(
      encodePng({
        width: 2,
        height: 1,
        depth: 8,
        colorType: 2,
        // The 16-bit key 0x00ff/0x0000/0x0000 selects pure red.
        trns: new Uint8Array([0, 255, 0, 0, 0, 0]),
        rows: [new Uint8Array([255, 0, 0, 0, 0, 255])],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(pixel(out.value, 0, 0)).toEqual([255, 0, 0, 0]);
    expect(pixel(out.value, 1, 0)).toEqual([0, 0, 255, 255]);
  });
});

describe("fixtures written by libpng", () => {
  test("RGBA: quadrants, a diagonal, and a transparent left column", async () => {
    const out = decodePng(await fixture("quads.png"));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.width).toBe(64);
    expect(out.value.height).toBe(48);
    expect(pixel(out.value, 8, 20)).toEqual([255, 0, 0, 255]);
    expect(pixel(out.value, 48, 4)).toEqual([0, 255, 0, 255]);
    expect(pixel(out.value, 8, 40)).toEqual([0, 0, 255, 255]);
    expect(pixel(out.value, 40, 44)).toEqual([255, 255, 255, 255]);
    // The first eight columns were written with alpha 0.
    expect(pixel(out.value, 0, 0)[3]).toBe(0);
    expect(pixel(out.value, 7, 30)[3]).toBe(0);
    expect(pixel(out.value, 9, 30)[3]).toBe(255);
    // The diagonal is black where it crosses.
    expect(pixel(out.value, 32, 24)[0]).toBeLessThan(64);
  });

  test("palette and interlaced encodings of the same picture agree", async () => {
    const palette = decodePng(await fixture("quads-palette.png"));
    const interlaced = decodePng(await fixture("quads-interlaced.png"));
    expect(palette.ok).toBe(true);
    expect(interlaced.ok).toBe(true);
    if (!palette.ok || !interlaced.ok) return;
    expect(interlaced.value.width).toBe(64);
    expect(interlaced.value.height).toBe(48);
    for (const [x, y, rgb] of [
      [8, 20, [255, 0, 0]],
      [48, 4, [0, 255, 0]],
      [8, 40, [0, 0, 255]],
      [40, 44, [255, 255, 255]],
    ] as const) {
      expect(pixel(palette.value, x, y).slice(0, 3)).toEqual([...rgb]);
      expect(pixel(interlaced.value, x, y).slice(0, 3)).toEqual([...rgb]);
    }
  });

  test("Adam7 places every pass, not just the first", async () => {
    // The seven passes interleave on an 8×8 grid; a decoder that dropped one
    // leaves a regular lattice of unwritten pixels. Comparing against the
    // non-interlaced encoding of the same picture catches exactly that.
    const interlaced = decodePng(await fixture("quads-interlaced.png"));
    const plain = decodePng(await fixture("quads-palette.png"));
    expect(interlaced.ok && plain.ok).toBe(true);
    if (!interlaced.ok || !plain.ok) return;
    let differing = 0;
    for (let i = 0; i < interlaced.value.rgba.length; i += 4)
      if (interlaced.value.rgba[i] !== plain.value.rgba[i]) differing++;
    // The palette copy is quantised to 16 colours, so a few pixels along the
    // antialiased diagonal legitimately differ; a dropped pass would be
    // thousands.
    expect(differing).toBeLessThan(200);
  });
});
