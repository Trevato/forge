/**
 * A 3MF print project as one triangle soup, in millimetres, with no library.
 * 3MF (3D Manufacturing Format Core Specification 1.3) is a zip, Open
 * Packaging Conventions style, whose `3D/3dmodel.model` is XML: `<object>`s
 * holding a `<mesh>` of `<vertex>` and `<triangle>`, or `<components>` of
 * other objects; a `<build>` of `<item>`s says which objects are printed and
 * where. The `unit` attribute of `<model>` (§3.4: micron, millimeter,
 * centimeter, inch, foot, meter; millimeter when absent) is applied here, so
 * the numbers that leave are millimetres.
 *
 * The viewer (`model3d-client.ts`) and the terminal's facts (`model-facts.ts`)
 * both read through this. It has no DOM and no node: `locateModel` finds the
 * model's bytes in the zip, the caller inflates them (a stream in the browser,
 * zlib on the server) and `parseModelXml` reads the XML. Inflating is bounded
 * by entry count and inflated size, so a zip bomb is refused.
 */

import { MeshError, type Mesh } from "./mesh.ts";

/** More entries than any slicer writes; a zip with more is refused. */
export const ENTRY_LIMIT = 10_000;
/** The most the model XML may inflate to. */
export const INFLATE_LIMIT = 64 * 1024 * 1024;
/** Triangles beyond which a part is refused rather than drawn. */
export const TRIANGLE_LIMIT = 5_000_000;
const DEPTH_LIMIT = 16;

/** Millimetres in one unit of each `unit` value (3MF Core §3.4). */
const UNIT_MM: Readonly<Record<string, number>> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

/** The model's entry in the zip, still packed. */
export interface ModelEntry {
  readonly data: Uint8Array;
  /** 0 stored, 8 deflate. */
  readonly method: 0 | 8;
  /** Inflated size the zip declares. */
  readonly size: number;
}

const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD = 0x06054b50;

/** Finds `3D/3dmodel.model` (or the first `3D/*.model`) in a zip's bytes. */
export function locateModel(bytes: Uint8Array): ModelEntry {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--)
    if (v.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new MeshError("not a readable zip");
  const total = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  if (total === 0xffff || p === 0xffffffff) throw new MeshError("a zip64 project is too large to read");
  if (total > ENTRY_LIMIT) throw new MeshError(`the zip holds more than ${ENTRY_LIMIT} entries`);
  let found: { at: number; method: number; size: number; packed: number; flags: number } | undefined;
  for (let n = 0; n < total; n++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== CENTRAL) throw new MeshError("a broken zip directory");
    const nameLen = v.getUint16(p + 28, true);
    const next = p + 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    if (next > bytes.length) throw new MeshError("a broken zip directory");
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const lower = name.toLowerCase();
    const main = lower === "3d/3dmodel.model";
    if (main || (found === undefined && lower.startsWith("3d/") && lower.endsWith(".model"))) {
      found = {
        at: v.getUint32(p + 42, true),
        method: v.getUint16(p + 10, true),
        size: v.getUint32(p + 24, true),
        packed: v.getUint32(p + 20, true),
        flags: v.getUint16(p + 8, true),
      };
      if (main) break;
    }
    p = next;
  }
  if (found === undefined) throw new MeshError("the zip has no 3D model (3D/3dmodel.model)");
  if (found.flags & 1) throw new MeshError("the model is encrypted");
  if (found.method !== 0 && found.method !== 8) throw new MeshError("the model uses a compression this does not read");
  if (found.size > INFLATE_LIMIT) throw new MeshError("the model inflates to more than the limit");
  if (found.at + 30 > bytes.length || v.getUint32(found.at, true) !== LOCAL) throw new MeshError("a broken zip entry");
  const start = found.at + 30 + v.getUint16(found.at + 26, true) + v.getUint16(found.at + 28, true);
  if (start + found.packed > bytes.length) throw new MeshError("a zip entry past the end of the file");
  return { data: bytes.subarray(start, start + found.packed), method: found.method, size: found.size };
}

/** Inflates the entry in a stream, giving up the moment it passes the limit. */
export async function inflateModel(entry: ModelEntry): Promise<Uint8Array> {
  if (entry.method === 0) return entry.data;
  const reader = new Blob([entry.data as unknown as ArrayBuffer])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > INFLATE_LIMIT) {
      await reader.cancel();
      throw new MeshError("the model inflates to more than the limit");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** A 3MF file's mesh in millimetres. */
export async function parse3mf(bytes: Uint8Array): Promise<Mesh> {
  const xml = new TextDecoder().decode(await inflateModel(locateModel(bytes)));
  return parseModelXml(xml);
}

type Matrix = readonly number[];
const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** `a` then `b`, for the row-vector form 3MF uses (§3.3). */
function then(a: Matrix, b: Matrix): Matrix {
  const out: number[] = [];
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 3; c++) {
      const row = r < 3 ? a.slice(r * 3, r * 3 + 3) : a.slice(9, 12);
      out.push(row[0]! * b[c]! + row[1]! * b[3 + c]! + row[2]! * b[6 + c]! + (r === 3 ? b[9 + c]! : 0));
    }
  return out;
}

function matrix(text: string | undefined): Matrix {
  if (text === undefined) return IDENTITY;
  const m = text.trim().split(/\s+/).map(Number);
  if (m.length !== 12 || !m.every(Number.isFinite)) throw new MeshError("a transform that is not twelve numbers");
  return m;
}

interface Obj {
  vertices: number[];
  triangles: number[];
  components: { id: string; transform: Matrix }[];
}

const TAG = /<(\/?)([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * The XML of a model part, read into millimetres: every `<item>` of the
 * `<build>` placed by its transform, or, with no build, every object.
 */
export function parseModelXml(xml: string): Mesh {
  const objects = new Map<string, Obj>();
  const items: { id: string; transform: Matrix }[] = [];
  let unit = 1;
  let current: Obj | undefined;
  let sawModel = false;
  const text = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  for (const m of text.matchAll(TAG)) {
    const [, closing, , name, attrText] = m;
    const attrs: Record<string, string> = {};
    for (const a of (attrText ?? "").matchAll(ATTR)) attrs[a[1]!] = a[2] ?? a[3] ?? "";
    if (closing === "/") {
      if (name === "object") current = undefined;
      continue;
    }
    switch (name) {
      case "model": {
        sawModel = true;
        const u = attrs.unit ?? "millimeter";
        if (!(u in UNIT_MM)) throw new MeshError(`the model's unit "${u}" is not one 3MF names`);
        unit = UNIT_MM[u]!;
        break;
      }
      case "object":
        if (attrs.id === undefined) throw new MeshError("an object with no id");
        current = { vertices: [], triangles: [], components: [] };
        objects.set(attrs.id, current);
        break;
      case "vertex": {
        const xyz = [Number(attrs.x), Number(attrs.y), Number(attrs.z)];
        if (current === undefined || !xyz.every(Number.isFinite)) throw new MeshError("a vertex that is not three numbers");
        current.vertices.push(...xyz);
        break;
      }
      case "triangle": {
        const ijk = [attrs.v1, attrs.v2, attrs.v3].map((s) => Number(s));
        if (current === undefined || !ijk.every((n) => Number.isInteger(n) && n >= 0 && n < current!.vertices.length / 3))
          throw new MeshError("a triangle names a vertex that is not there");
        current.triangles.push(...ijk);
        break;
      }
      case "component":
        if (current === undefined || attrs.objectid === undefined) throw new MeshError("a component that names no object");
        current.components.push({ id: attrs.objectid, transform: matrix(attrs.transform) });
        break;
      case "item":
        if (attrs.objectid === undefined) throw new MeshError("a build item that names no object");
        items.push({ id: attrs.objectid, transform: matrix(attrs.transform) });
        break;
    }
  }
  if (!sawModel) throw new MeshError("not a 3MF model");
  const placed = items.length > 0 ? items : [...objects.keys()].map((id) => ({ id, transform: IDENTITY }));

  const count = (id: string, depth: number): number => {
    const o = objects.get(id);
    if (o === undefined) throw new MeshError(`an item names object ${id}, which is not there`);
    if (depth > DEPTH_LIMIT) throw new MeshError("components nested too deep");
    return o.triangles.length / 3 + o.components.reduce((n, c) => n + count(c.id, depth + 1), 0);
  };
  const triangles = placed.reduce((n, i) => n + count(i.id, 0), 0);
  if (triangles > TRIANGLE_LIMIT) throw new MeshError(`more than ${TRIANGLE_LIMIT.toLocaleString("en")} triangles`);

  const positions = new Float32Array(triangles * 9);
  let at = 0;
  const emit = (id: string, to: Matrix): void => {
    const o = objects.get(id)!;
    for (let i = 0; i < o.triangles.length; i++) {
      const v = o.triangles[i]! * 3;
      const [x, y, z] = [o.vertices[v]!, o.vertices[v + 1]!, o.vertices[v + 2]!];
      positions[at++] = (to[0]! * x + to[3]! * y + to[6]! * z + to[9]!) * unit;
      positions[at++] = (to[1]! * x + to[4]! * y + to[7]! * z + to[10]!) * unit;
      positions[at++] = (to[2]! * x + to[5]! * y + to[8]! * z + to[11]!) * unit;
    }
    for (const c of o.components) emit(c.id, then(c.transform, to));
  };
  for (const i of placed) emit(i.id, i.transform);
  return { positions, triangles };
}
