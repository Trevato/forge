/**
 * STL, read for its shape: whether it is ASCII or binary, how many triangles
 * it holds, and the axis-aligned box around every vertex — in the file's own
 * model units, which STL never names. Only the bounds are kept, never the
 * mesh. A truncated or lying file is an Err naming why; nothing here throws.
 *
 * Binary (after the 3D Systems "StereoLithography Interface Specification",
 * 1989): an 80-byte header, a little-endian uint32 triangle count at offset
 * 80, then 50 bytes per triangle — a normal and three vertices as
 * little-endian float32 (12 × 4 bytes) and a uint16 attribute count. So a
 * file of n triangles is exactly 84 + 50·n bytes.
 *
 * ASCII: `solid name`, then per triangle `facet normal i j k` / `outer loop` /
 * three `vertex x y z` / `endloop` / `endfacet`, closed by `endsolid`.
 */
import { err, ok, type Result } from "../kernel/result.ts";

export type Vec3 = readonly [number, number, number];

export type Stl = {
  readonly format: "ascii" | "binary";
  readonly triangles: number;
  readonly min: Vec3;
  readonly max: Vec3;
};

const HEADER = 80;
const RECORD = 50;

/** Read an STL's format, triangle count and bounds from its bytes. */
export function readStl(bytes: Uint8Array): Result<Stl, string> {
  const binary = bytes.length >= HEADER + 4 ? expectedBinaryLength(bytes) : undefined;
  // A binary header may itself begin with "solid", so a length that matches
  // the binary layout exactly wins over the ASCII keyword.
  if (binary !== undefined && binary === bytes.length) return readBinary(bytes);
  if (startsWithSolid(bytes)) {
    const read = readAscii(bytes);
    // Not ASCII after all: a binary header that begins with "solid" and a
    // length that does not fit says more as the binary mismatch.
    if (read.ok || binary === undefined || looksAscii(bytes)) return read;
  }
  if (binary === undefined) return err("too short for an STL header");
  const n = (binary - HEADER - 4) / RECORD;
  return bytes.length < binary
    ? err(`truncated: says ${n} triangles, holds ${bytes.length} of ${binary} bytes`)
    : err(`says ${n} triangles but holds ${bytes.length} bytes, not ${binary}`);
}

/** One line: "STL (binary) · 12,340 triangles · 40.0 × 20.0 × 10.0". */
export function sayStl(stl: Stl): string {
  const count = `${stl.triangles.toLocaleString("en-US")} triangle${stl.triangles === 1 ? "" : "s"}`;
  const size = stlSize(stl).map((d) => d.toFixed(1)).join(" × ");
  return `STL (${stl.format}) · ${count} · ${size}`;
}

/** The box's extent on each axis, max − min, in model units. */
export function stlSize(stl: Stl): Vec3 {
  return [stl.max[0] - stl.min[0], stl.max[1] - stl.min[1], stl.max[2] - stl.min[2]];
}

function expectedBinaryLength(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return HEADER + 4 + view.getUint32(HEADER, true) * RECORD;
}

function startsWithSolid(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  const word = Buffer.from(bytes.subarray(i, i + 5)).toString("latin1");
  return word.toLowerCase() === "solid";
}

/**
 * Whether the four bytes where a binary count would sit are all text. A real
 * count that is all text claims at least 0x09090909 (151 million) triangles,
 * gigabytes no file here holds, so text there means the file is ASCII.
 */
function looksAscii(bytes: Uint8Array): boolean {
  for (let i = HEADER; i < HEADER + 4; i++) if (bytes[i]! < 0x09 || (bytes[i]! > 0x0d && bytes[i]! < 0x20)) return false;
  return true;
}

class Box {
  min = [Infinity, Infinity, Infinity];
  max = [-Infinity, -Infinity, -Infinity];
  add(x: number, y: number, z: number): void {
    const p = [x, y, z];
    for (let a = 0; a < 3; a++) {
      if (p[a]! < this.min[a]!) this.min[a] = p[a]!;
      if (p[a]! > this.max[a]!) this.max[a] = p[a]!;
    }
  }
  done(format: Stl["format"], triangles: number): Result<Stl, string> {
    if (triangles === 0) return err("holds no triangles");
    return ok({
      format,
      triangles,
      min: [this.min[0]!, this.min[1]!, this.min[2]!],
      max: [this.max[0]!, this.max[1]!, this.max[2]!],
    });
  }
}

function readBinary(bytes: Uint8Array): Result<Stl, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint32(HEADER, true);
  const box = new Box();
  for (let t = 0; t < n; t++) {
    // Skip the 12-byte normal; the three vertices follow.
    const at = HEADER + 4 + t * RECORD + 12;
    for (let v = 0; v < 3; v++) {
      const o = at + v * 12;
      const x = view.getFloat32(o, true);
      const y = view.getFloat32(o + 4, true);
      const z = view.getFloat32(o + 8, true);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
        return err(`triangle ${t + 1} has a vertex that is not a finite number`);
      box.add(x, y, z);
    }
  }
  return box.done("binary", n);
}

/** ASCII is described only up to this many bytes: one pass over 1 MB stays well under 50 ms on the one server thread. */
export const ASCII_LIMIT = 1_000_000;
export const TOO_LARGE = "too large to describe here";

const FLOAT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function isSpace(c: number): boolean {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d);
}

/** Whether text[s, e) is `word` (lower case), ignoring case, without slicing. */
function isWord(text: string, s: number, e: number, word: string): boolean {
  if (e - s !== word.length) return false;
  for (let k = 0; k < word.length; k++) if ((text.charCodeAt(s + k) | 0x20) !== word.charCodeAt(k)) return false;
  return true;
}

// One pass over the text by index: keywords are compared in place and only the
// three numbers of each vertex become strings, so the work is linear in bytes.
function readAscii(bytes: Uint8Array): Result<Stl, string> {
  if (bytes.length > ASCII_LIMIT) return err(TOO_LARGE);
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  // The solid's name runs to the end of its line and may hold any word.
  const firstBreak = text.search(/[\r\n]/);
  if (firstBreak === -1) return err("truncated: an ASCII STL with no facets");
  let at = firstBreak;
  let s = 0;
  /** Advance to the next token; false at the end. Sets s and at to its bounds. */
  const next = (): boolean => {
    while (at < text.length && isSpace(text.charCodeAt(at))) at++;
    s = at;
    while (at < text.length && !isSpace(text.charCodeAt(at))) at++;
    return at > s;
  };
  const box = new Box();
  let triangles = 0;
  let inFacet = false;
  let vertices = 0;
  while (next()) {
    if (isWord(text, s, at, "facet")) {
      if (inFacet) return err(`facet ${triangles + 1} opens before the last one ends`);
      inFacet = true;
      vertices = 0;
      triangles++;
    } else if (isWord(text, s, at, "vertex")) {
      if (!inFacet) return err("a vertex outside any facet");
      const xyz: number[] = [];
      for (let a = 0; a < 3; a++) {
        if (!next()) return err(`truncated: facet ${triangles} ends mid-vertex`);
        const word = text.slice(s, at);
        if (!FLOAT.test(word)) return err(`facet ${triangles} has a vertex that is not three numbers`);
        xyz.push(Number(word));
      }
      const [x, y, z] = xyz as [number, number, number];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
        return err(`facet ${triangles} has a vertex that is not a finite number`);
      box.add(x, y, z);
      vertices++;
    } else if (isWord(text, s, at, "endfacet")) {
      if (!inFacet) return err("endfacet without a facet");
      if (vertices !== 3) return err(`facet ${triangles} has ${vertices} vertices, not 3`);
      inFacet = false;
    } else if (isWord(text, s, at, "endsolid")) {
      if (inFacet) return err(`truncated: facet ${triangles} is never closed`);
      return box.done("ascii", triangles);
    }
  }
  return err(inFacet ? `truncated: facet ${triangles} is never closed` : "truncated: no endsolid");
}
