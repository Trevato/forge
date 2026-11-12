/**
 * STL and OBJ, read into one plain triangle soup: nine floats a triangle, no
 * index, no library. The 3D viewer (`model3d-client.ts`) runs these in the
 * browser, so a model is parsed on the reader's machine and never on the
 * request path; the server only ever streams the bytes.
 *
 * Plain data in, plain data out, and no DOM: the tests read the same
 * fixtures the browser would.
 */

export interface Mesh {
  /** x, y, z for each corner, three corners a triangle. */
  readonly positions: Float32Array;
  readonly triangles: number;
}

export interface Bounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** max − min on each axis. */
  readonly size: readonly [number, number, number];
}

/** A file that is not the format it claims to be. */
export class MeshError extends Error {
  override readonly name = "MeshError";
}

const HEADER = 80;
const FACET = 50;

/**
 * Binary STL is an 80-byte header, a count, then 50 bytes a facet. Its
 * length says so exactly, which is how a binary file whose header happens
 * to open with `solid` is still read as binary.
 */
export function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER + 4) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return HEADER + 4 + view.getUint32(HEADER, true) * FACET === bytes.length;
}

/** An STL in either form. */
export function parseStl(bytes: Uint8Array): Mesh {
  return isBinaryStl(bytes) ? parseBinaryStl(bytes) : parseAsciiStl(new TextDecoder().decode(bytes));
}

function parseBinaryStl(bytes: Uint8Array): Mesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = view.getUint32(HEADER, true);
  const positions = new Float32Array(triangles * 9);
  for (let t = 0; t < triangles; t++) {
    // Skip the stored normal (12 bytes); the viewer computes its own.
    const at = HEADER + 4 + t * FACET + 12;
    for (let i = 0; i < 9; i++) positions[t * 9 + i] = view.getFloat32(at + i * 4, true);
  }
  return { positions, triangles };
}

const NUMBER = String.raw`([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)`;
const VERTEX = new RegExp(String.raw`\bvertex\s+${NUMBER}\s+${NUMBER}\s+${NUMBER}`, "g");

function parseAsciiStl(text: string): Mesh {
  if (!/^\s*solid\b/.test(text)) throw new MeshError("not an STL file");
  const out: number[] = [];
  for (const m of text.matchAll(VERTEX)) out.push(Number(m[1]), Number(m[2]), Number(m[3]));
  if (out.length % 9 !== 0) throw new MeshError("a facet without three vertices");
  return { positions: Float32Array.from(out), triangles: out.length / 9 };
}

/**
 * Wavefront OBJ: `v` lines and `f` lines; a face of more than three corners
 * is a fan. Indices are 1-based, and a negative one counts back from the last
 * vertex read. Normals, texture coordinates, groups and materials are skipped.
 */
export function parseObj(text: string): Mesh {
  const vertices: number[] = [];
  const out: number[] = [];
  const corner = (token: string): number => {
    const n = Number.parseInt(token, 10);
    const count = vertices.length / 3;
    const index = n < 0 ? count + n : n - 1;
    if (!Number.isInteger(n) || n === 0 || index < 0 || index >= count)
      throw new MeshError(`a face names vertex ${token}, which is not there`);
    return index;
  };
  const push = (index: number): void => {
    out.push(vertices[index * 3]!, vertices[index * 3 + 1]!, vertices[index * 3 + 2]!);
  };
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === "v") {
      const [x, y, z] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
      if (![x, y, z].every(Number.isFinite)) throw new MeshError("a vertex that is not three numbers");
      vertices.push(x, y, z);
    } else if (parts[0] === "f") {
      const corners = parts.slice(1).map((p) => corner(p.split("/")[0] ?? ""));
      if (corners.length < 3) throw new MeshError("a face with fewer than three corners");
      for (let i = 1; i + 1 < corners.length; i++) {
        push(corners[0]!);
        push(corners[i]!);
        push(corners[i + 1]!);
      }
    }
  }
  return { positions: Float32Array.from(out), triangles: out.length / 9 };
}

/** The axis-aligned box around every corner; all zeros for an empty mesh. */
export function bounds(positions: Float32Array): Bounds {
  if (positions.length < 3) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  const [x0, y0, z0] = min as [number, number, number];
  const [x1, y1, z1] = max as [number, number, number];
  return { min: [x0, y0, z0], max: [x1, y1, z1], size: [x1 - x0, y1 - y0, z1 - z0] };
}

/** `20 × 20 × 20 mm`: a box's size, rounded to what a printer can hold. */
export function sizeText(size: readonly [number, number, number], unit = "mm"): string {
  const round = (v: number): string => String(Math.round(v * 100) / 100);
  return `${size.map(round).join(" × ")} ${unit}`;
}
