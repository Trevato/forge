/**
 * The JPEG decoder.
 *
 * Fixtures are written by libjpeg (through Pillow, `uv run --with pillow`,
 * the same way `qr.test.ts` gets its vectors) from one 64×48 picture: four
 * flat colour quadrants with a black diagonal across them. Flat quadrants
 * make the assertions robust — a lossy codec agrees with itself to within a
 * point or two in the middle of a flat field — while the diagonal and the
 * quadrant edges are what force the AC coefficients that actually exercise
 * the Huffman decode and the IDCT.
 *
 * The load-bearing test in this file is `baseline and progressive decode to
 * the same picture`. Progressive JPEG's successive-approximation refinement
 * is the one part of the format with a genuinely subtle decoder, and the two
 * files here are the *same source image* encoded twice by the same library —
 * so they must decode to the same pixels. Any refinement bug shows up as a
 * difference, with no tolerance to hide behind.
 */

import { describe, expect, test } from "bun:test";
import {
  decodeJpeg,
  exifOrientation,
  jpegHeader,
  orient,
} from "../src/design/image/jpeg.ts";

const FIXTURES = `${import.meta.dir}/fixtures`;

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(`${FIXTURES}/${name}`).arrayBuffer());
}

interface Img {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function pixel(img: Img, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return [img.rgba[i]!, img.rgba[i + 1]!, img.rgba[i + 2]!];
}

function expectNear(got: number[], want: number[], tolerance = 4): void {
  expect(got.length).toBe(want.length);
  for (const [i, value] of got.entries())
    expect(Math.abs(value - want[i]!)).toBeLessThanOrEqual(tolerance);
}

/** The four quadrant centres, chosen well clear of the diagonal. */
const QUADRANTS: readonly (readonly [number, number, number[]])[] = [
  [8, 20, [255, 0, 0]],
  [48, 4, [0, 255, 0]],
  [8, 40, [0, 0, 255]],
  [40, 44, [255, 255, 255]],
];

async function decodeFixture(name: string): Promise<Img> {
  const out = decodeJpeg(await fixture(name));
  expect(out.ok).toBe(true);
  if (!out.ok) throw new Error(`${name} failed to decode: ${out.error}`);
  return out.value;
}

describe("jpegHeader", () => {
  test("reads geometry, mode and component count without decoding", async () => {
    expect(jpegHeader(await fixture("quads-baseline.jpg"))).toEqual({
      ok: true,
      value: {
        width: 64,
        height: 48,
        progressive: false,
        components: 3,
        orientation: 1,
      },
    });
    expect(jpegHeader(await fixture("quads-progressive.jpg"))).toMatchObject({
      ok: true,
      value: { progressive: true },
    });
    expect(jpegHeader(await fixture("quads-grey.jpg"))).toMatchObject({
      ok: true,
      value: { components: 1 },
    });
  });

  test("refuses arithmetic and lossless modes by name", () => {
    // A well-formed header whose SOF marker is one we do not implement. It
    // must be `unsupported`, never `corrupt`: the file is fine, we are not.
    for (const sof of [0xc3, 0xc9, 0xca, 0xcd]) {
      const bytes = new Uint8Array([
        0xff,
        0xd8,
        0xff,
        sof,
        0x00,
        0x0b,
        0x08,
        0x00,
        0x10,
        0x00,
        0x10,
        0x01,
        0x01,
        0x11,
        0x00,
        0xff,
        0xd9,
      ]);
      expect(jpegHeader(bytes)).toEqual({ ok: false, error: "unsupported" });
      expect(decodeJpeg(bytes)).toEqual({ ok: false, error: "unsupported" });
    }
  });

  test("refuses 12-bit precision and 4-component CMYK", () => {
    const twelveBit = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x0c, 0x00, 0x10, 0x00, 0x10, 0x01,
      0x01, 0x11, 0x00, 0xff, 0xd9,
    ]);
    expect(jpegHeader(twelveBit)).toEqual({ ok: false, error: "unsupported" });
    const cmyk = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x14, 0x08, 0x00, 0x10, 0x00, 0x10, 0x04,
      0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0x04, 0x11, 0x00,
      0xff, 0xd9,
    ]);
    expect(jpegHeader(cmyk)).toEqual({ ok: false, error: "unsupported" });
  });

  test("bytes that are not a JPEG are corrupt", () => {
    expect(jpegHeader(new Uint8Array([1, 2, 3, 4]))).toEqual({
      ok: false,
      error: "corrupt",
    });
    // An SOI with nothing behind it: no frame ever arrives.
    expect(jpegHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toEqual({
      ok: false,
      error: "corrupt",
    });
  });
});

describe("baseline", () => {
  test("4:2:0 decodes to the picture that was encoded", async () => {
    const img = await decodeFixture("quads-baseline.jpg");
    expect(img.width).toBe(64);
    expect(img.height).toBe(48);
    expect(img.rgba.length).toBe(64 * 48 * 4);
    for (const [x, y, rgb] of QUADRANTS) expectNear(pixel(img, x, y), [...rgb]);
    // Alpha is synthesised opaque; JPEG has no transparency.
    expect(img.rgba[3]).toBe(255);
  });

  test("4:4:4 agrees with 4:2:0 away from the edges", async () => {
    const full = await decodeFixture("quads-444.jpg");
    for (const [x, y, rgb] of QUADRANTS)
      expectNear(pixel(full, x, y), [...rgb]);
  });

  test("chroma subsampling is upsampled, not dropped", async () => {
    // A 4:2:0 file carries one chroma sample per 2×2 luma block. If the
    // upsampling were skipped the right half of the image would be grey; if
    // the *luma* plane were misindexed the colours would tile. Sampling four
    // points inside one quadrant checks the whole field is the same colour.
    const img = await decodeFixture("quads-baseline.jpg");
    for (const [x, y] of [
      [2, 10],
      [4, 18],
      [10, 20],
      [16, 21],
    ] as const)
      expectNear(pixel(img, x, y), [255, 0, 0], 8);
  });

  test("a single-component file is greyscale, at Rec.601 luma", async () => {
    const grey = await decodeFixture("quads-grey.jpg");
    expect(grey.width).toBe(64);
    // 0.299·255 = 76 for red, 0.587·255 = 150 for green, 0.114·255 = 29 blue.
    expectNear(pixel(grey, 8, 20), [76, 76, 76]);
    expectNear(pixel(grey, 48, 4), [150, 150, 150]);
    expectNear(pixel(grey, 8, 40), [29, 29, 29]);
    // R, G and B must be identical, not merely close.
    const [r, g, b] = pixel(grey, 8, 20);
    expect(r).toBe(g!);
    expect(g).toBe(b!);
  });

  test("restart markers are consumed, not decoded as picture", async () => {
    // With DRI set, the entropy stream is interrupted by RSTn markers and the
    // DC predictors reset. A decoder that ignored them produces a picture
    // that drifts into garbage after the first interval — so the quadrants
    // being right at the *bottom* of the image is the real assertion here.
    const img = await decodeFixture("quads-restart.jpg");
    for (const [x, y, rgb] of QUADRANTS)
      expectNear(pixel(img, x, y), [...rgb], 6);
  });
});

describe("progressive", () => {
  test("decodes the picture, not an early scan of it", async () => {
    const img = await decodeFixture("quads-progressive.jpg");
    expect(img.width).toBe(64);
    expect(img.height).toBe(48);
    for (const [x, y, rgb] of QUADRANTS) expectNear(pixel(img, x, y), [...rgb]);
  });

  test("baseline and progressive decode to the same picture", async () => {
    // Same source, same library, same quality — only the scan structure
    // differs. Successive-approximation refinement is the subtlest code in
    // the decoder and this is what proves it: no tolerance, every pixel.
    const baseline = await decodeFixture("quads-baseline.jpg");
    const progressive = await decodeFixture("quads-progressive.jpg");
    expect(progressive.width).toBe(baseline.width);
    expect(progressive.height).toBe(baseline.height);
    let worst = 0;
    for (let i = 0; i < baseline.rgba.length; i++)
      worst = Math.max(
        worst,
        Math.abs(baseline.rgba[i]! - progressive.rgba[i]!),
      );
    expect(worst).toBe(0);
  });

  test("a truncated progressive file still renders what arrived", async () => {
    // Progressive files are made to be shown half-received. Cutting one in
    // half must produce a picture, not an error and certainly not a throw.
    const whole = await fixture("quads-progressive.jpg");
    const half = whole.subarray(0, Math.floor(whole.length * 0.6));
    const out = decodeJpeg(half);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.width).toBe(64);
    // The DC scans arrive first, so the quadrants are already roughly right.
    expectNear(pixel(out.value, 8, 20), [255, 0, 0], 40);
  });
});

describe("EXIF orientation", () => {
  test("orientation 6 rotates the picture and swaps the geometry", async () => {
    const bytes = await fixture("strip-exif6.jpg");
    expect(jpegHeader(bytes)).toMatchObject({
      ok: true,
      // The *stored* frame is 32×16 landscape; orientation 6 is "rotate 90°
      // clockwise to display", so what the user should see is 16×32.
      value: { width: 32, height: 16, orientation: 6 },
    });
    const img = await decodeFixture("strip-exif6.jpg");
    expect(img.width).toBe(16);
    expect(img.height).toBe(32);
    // The source's left half is red, its right half blue. Rotated clockwise,
    // left becomes top.
    expectNear(pixel(img, 8, 4), [255, 0, 0], 6);
    expectNear(pixel(img, 8, 28), [0, 0, 255], 6);
  });

  test("the tag is read from either byte order, and only when present", () => {
    const little = new Uint8Array([
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00, 0x08, 0x00,
      0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
      0x03, 0x00, 0x00, 0x00,
    ]);
    expect(exifOrientation(little)).toBe(3);
    const big = new Uint8Array([
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00,
      0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01,
      0x00, 0x08, 0x00, 0x00,
    ]);
    expect(exifOrientation(big)).toBe(8);
    expect(exifOrientation(new Uint8Array(4))).toBeUndefined();
    // A JFIF APP0 payload is not EXIF and must not be mined for a tag.
    expect(
      exifOrientation(new Uint8Array([0x4a, 0x46, 0x49, 0x46, 0, 1, 1])),
    ).toBeUndefined();
  });

  test("all eight orientations move the corner they should", () => {
    // A 2×1 image: left pixel red (1), right pixel blue (2).
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]);
    const corner = (o: number): number[] => {
      const out = orient(2, 1, rgba, o);
      return [out.width, out.height, out.rgba[0]!, out.rgba[1]!, out.rgba[2]!];
    };
    expect(corner(1)).toEqual([2, 1, 255, 0, 0]); // untouched
    expect(corner(2)).toEqual([2, 1, 0, 0, 255]); // mirrored: blue leads
    expect(corner(3)).toEqual([2, 1, 0, 0, 255]); // 180°
    expect(corner(4)).toEqual([2, 1, 255, 0, 0]); // flipped vertically
    // 5–8 transpose, so the result is 1 wide and 2 tall.
    for (const o of [5, 6, 7, 8]) {
      const out = orient(2, 1, rgba, o);
      expect([out.width, out.height]).toEqual([1, 2]);
    }
    // 6 is "rotate clockwise": the left (red) pixel ends up on top.
    expect(corner(6).slice(2)).toEqual([255, 0, 0]);
    // 8 is "rotate anticlockwise": the right (blue) pixel ends up on top.
    expect(corner(8).slice(2)).toEqual([0, 0, 255]);
  });
});

describe("hostile input", () => {
  test("garbage in the entropy stream is corrupt, never a throw", async () => {
    const bytes = (await fixture("quads-baseline.jpg")).slice();
    // Overwrite deep in the scan data, past all the headers.
    for (let i = bytes.length - 200; i < bytes.length - 4; i++)
      bytes[i] = (i * 37) & 0xff;
    const out = decodeJpeg(bytes);
    // Either it recovers a picture or it says corrupt; it must not throw and
    // must not return a buffer of the wrong length.
    if (out.ok) expect(out.value.rgba.length).toBe(64 * 48 * 4);
    else expect(out.error).toBe("corrupt");
  });

  test("a scan referencing a Huffman table that was never defined", () => {
    const bytes = new Uint8Array([
      0xff,
      0xd8, //  SOI
      0xff,
      0xc0,
      0x00,
      0x0b,
      0x08,
      0x00,
      0x08,
      0x00,
      0x08,
      0x01,
      0x01,
      0x11,
      0x00, //        SOF0, 8×8, one component
      0xff,
      0xda,
      0x00,
      0x08,
      0x01,
      0x01,
      0x00,
      0x00,
      0x3f,
      0x00, // SOS
      0x00,
      0x00,
      0x00,
      0x00, //  entropy bytes, decoded against nothing
      0xff,
      0xd9,
    ]);
    expect(decodeJpeg(bytes)).toEqual({ ok: false, error: "corrupt" });
  });

  test("a frame with no scan at all", () => {
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x08, 0x00, 0x08, 0x01,
      0x01, 0x11, 0x00, 0xff, 0xd9,
    ]);
    // The frame parses but no quantisation table was ever defined for it.
    expect(decodeJpeg(bytes)).toEqual({ ok: false, error: "corrupt" });
  });
});
