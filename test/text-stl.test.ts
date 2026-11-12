/** STL: format, triangle count and bounds from ASCII and binary bytes; a truncated or lying file is an Err, never a throw. */
import { expect, test } from "bun:test";
import { ASCII_LIMIT, readStl, sayStl, stlSize, TOO_LARGE } from "../src/text/stl.ts";
import { asciiBox, binaryBox } from "./helpers/stl.ts";

const ascii = (s: string) => new TextEncoder().encode(s);

test("a binary box: 12 triangles, bounds from the origin to its corner", () => {
  const r = readStl(binaryBox(40, 20, 10));
  expect(r).toEqual({ ok: true, value: { format: "binary", triangles: 12, min: [0, 0, 0], max: [40, 20, 10] } });
  if (r.ok) expect(sayStl(r.value)).toBe("STL (binary) · 12 triangles · 40.0 × 20.0 × 10.0");
});

test("a binary header that begins with 'solid' is still binary when the length fits", () => {
  const r = readStl(binaryBox(1, 2, 3, "solid exported by a CAD tool"));
  expect(r.ok && r.value.format).toBe("binary");
});

test("an ASCII box: 12 triangles, the same bounds", () => {
  const r = readStl(ascii(asciiBox(40, 20, 10)));
  expect(r).toEqual({ ok: true, value: { format: "ascii", triangles: 12, min: [0, 0, 0], max: [40, 20, 10] } });
  if (r.ok) expect(sayStl(r.value)).toBe("STL (ascii) · 12 triangles · 40.0 × 20.0 × 10.0");
});

test("size is max − min per axis, and counts are grouped", () => {
  const stl = { format: "binary" as const, triangles: 12340, min: [-5, 1, 0] as const, max: [35, 21, 10] as const };
  expect(stlSize(stl)).toEqual([40, 20, 10]);
  expect(sayStl(stl)).toBe("STL (binary) · 12,340 triangles · 40.0 × 20.0 × 10.0");
  expect(sayStl({ ...stl, triangles: 1 })).toContain("· 1 triangle ·");
});

test("a truncated or lying file is an error naming why", () => {
  const full = binaryBox(1, 1, 1);
  const cut = readStl(full.subarray(0, full.length - 7));
  expect(cut.ok).toBe(false);
  if (!cut.ok) expect(cut.error).toContain("truncated");
  const lying = new Uint8Array(full);
  new DataView(lying.buffer).setUint32(80, 4_000_000_000, true);
  expect(readStl(lying).ok).toBe(false);
  expect(readStl(new Uint8Array(10))).toEqual({ ok: false, error: "too short for an STL header" });
  const text = asciiBox(1, 1, 1);
  const half = readStl(ascii(text.slice(0, text.length / 2)));
  expect(half.ok).toBe(false);
  if (!half.ok) expect(half.error).toContain("truncated");
  expect(readStl(ascii("solid x\nfacet normal 0 0 0\nouter loop\nvertex 1 2 nope\n")).ok).toBe(false);
  expect(readStl(ascii("solid empty\nendsolid empty\n"))).toEqual({ ok: false, error: "holds no triangles" });
  const nan = binaryBox(1, 1, 1);
  new DataView(nan.buffer).setFloat32(84 + 12, NaN, true);
  expect(readStl(nan).ok).toBe(false);
});

test("an ASCII body over the limit is too large to describe, and one at the limit reads fast", () => {
  const facet = "facet normal 0 0 0\nouter loop\nvertex 1 2 3\nvertex 4 5 6\nvertex 7 8 9\nendloop\nendfacet\n";
  const fill = (bytes: number) => {
    const head = "solid big\n";
    const tail = "endsolid big\n";
    const n = Math.floor((bytes - head.length - tail.length) / facet.length);
    const body = head + facet.repeat(n) + tail;
    return { n, bytes: ascii(body + " ".repeat(bytes - body.length)) };
  };
  const at = fill(ASCII_LIMIT);
  expect(at.bytes.length).toBe(ASCII_LIMIT);
  expect(readStl(at.bytes)).toEqual({ ok: true, value: { format: "ascii", triangles: at.n, min: [1, 2, 3], max: [7, 8, 9] } });
  expect(readStl(fill(ASCII_LIMIT + 1).bytes)).toEqual({ ok: false, error: TOO_LARGE });
  expect(readStl(fill(5_000_000).bytes)).toEqual({ ok: false, error: TOO_LARGE });
  // Junk tokens are no slower to refuse: the limit is checked before any scan.
  expect(readStl(ascii("solid a\n" + "x ".repeat(2_500_000)))).toEqual({ ok: false, error: TOO_LARGE });
});

test("a binary header that begins with 'solid' and a length that does not fit names the length, not ASCII", () => {
  const full = binaryBox(1, 1, 1, "solid x");
  const cut = readStl(full.subarray(0, full.length - 7));
  expect(cut).toEqual({ ok: false, error: `truncated: says 12 triangles, holds ${full.length - 7} of ${full.length} bytes` });
  const long = new Uint8Array(full.length + 3);
  long.set(full);
  expect(readStl(long)).toEqual({ ok: false, error: `says 12 triangles but holds ${full.length + 3} bytes, not ${full.length}` });
});
