/**
 * What a person's attached look accepts, at its edges (#1066): `readImage`
 * reads base64 as bytes and refuses what is not a PNG or JPEG of a size we
 * hold; `cleanNote` keeps one short line, counted in code points.
 */

import { describe, expect, test } from "bun:test";
import {
  ATTACH_MAX_BYTES,
  ATTACH_NOTE_MAX,
  cleanNote,
  readImage,
} from "../src/actions/attach_look.ts";
import { encodePng } from "../src/design/image/png.ts";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** Just enough PNG to read its header: signature and a 13-byte IHDR. */
function pngHead(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const v = new DataView(out.buffer);
  v.setUint32(8, 13);
  out.set([0x49, 0x48, 0x44, 0x52], 12);
  v.setUint32(16, width);
  v.setUint32(20, height);
  out[24] = 8;
  out[25] = 6;
  return out;
}

/** SOI, then a baseline start-of-frame of one component. */
function jpegHead(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 8,
    height >> 8, height & 0xff, width >> 8, width & 0xff,
    1, 1, 0x11, 0,
  ]);
}

describe("readImage", () => {
  test("base64 that is not a multiple of 4, or has a stray character, is bad_image", () => {
    const good = b64(encodePng(1, 1, new Uint8Array(4)));
    expect(readImage(good).ok).toBe(true);
    for (const bad of [good.replace(/=+$/, "").slice(0, -1) + "A", "abc", "QUJD*A==", "QU JD", "", "=AAA", "AAAA\n"]) {
      const r = readImage(bad);
      expect(r).toEqual({ ok: false, error: "bad_image" } as never);
    }
  });

  test("a string past the length bound is too_large before any decode", () => {
    // Not even base64: only the length check can have refused it.
    const long = "*".repeat(Math.ceil((ATTACH_MAX_BYTES * 4) / 3) + 5);
    const r = readImage(long);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("too_large");
  });

  test("a minimal PNG and a minimal JPEG come back with ext and size", () => {
    const png = readImage(b64(encodePng(3, 2, new Uint8Array(24))));
    expect(png.ok).toBe(true);
    if (png.ok) expect([png.value.ext, png.value.width, png.value.height]).toEqual(["png", 3, 2]);
    const jpg = readImage(b64(jpegHead(5, 7)));
    expect(jpg.ok).toBe(true);
    if (jpg.ok) expect([jpg.value.ext, jpg.value.width, jpg.value.height]).toEqual(["jpg", 5, 7]);
  });

  test("a GIF header is bad_image", () => {
    const gif = Uint8Array.from([...Buffer.from("GIF89a"), 1, 0, 1, 0, 0, 0, 0, 0x3b]);
    const r = readImage(b64(gif));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad_image");
  });

  test("a PNG claiming a side over the limit is bad_image; the limit itself is kept", () => {
    for (const [w, h] of [[8193, 1], [1, 8193]] as const) {
      const r = readImage(b64(pngHead(w, h)));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("bad_image");
    }
    expect(readImage(b64(pngHead(8192, 8192))).ok).toBe(true);
  });
});

describe("cleanNote", () => {
  const bad = (raw: string) => {
    const r = cleanNote(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad_note");
  };

  test("trims", () => {
    const r = cleanNote("  the phone view \t");
    expect(r.ok && r.value).toBe("the phone view");
  });

  test("a blank note, a newline and a DEL are bad_note", () => {
    bad("");
    bad("   \t ");
    bad("two\nlines");
    bad("del\u007fchar");
  });

  test("the bound counts code points, not UTF-16 units", () => {
    const ok = cleanNote("😀".repeat(ATTACH_NOTE_MAX));
    expect(ok.ok).toBe(true);
    bad("😀".repeat(ATTACH_NOTE_MAX + 1));
    bad("a".repeat(ATTACH_NOTE_MAX + 1));
  });
});
