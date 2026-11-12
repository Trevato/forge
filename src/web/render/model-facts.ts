/**
 * A 3D model's facts, for a door with no WebGL: the terminal's file view
 * says `3D model · STL` over `12 triangles · 20 × 20 × 20 mm` where the page draws
 * the part. Plain data in, plain data out.
 *
 * A 3MF is read by `threemf.ts` (its XML, in millimetres). STL and OBJ go
 * through the same parsers the browser runs (`mesh.ts`). A glTF is not parsed
 * into geometry: its JSON already says each primitive's vertex count and each
 * position accessor's bounds, so those are read, in metres by the spec, before
 * any node transform.
 */

import { inflateRawSync } from "node:zlib";
import { kindByName } from "./kinds.ts";
import { bounds, parseObj, parseStl, sizeText } from "./mesh.ts";
import { INFLATE_LIMIT, locateModel, parseModelXml } from "./threemf.ts";

/** Over this a model is named and sized, not read. */
export const FACTS_CAP = 2_000_000;

interface Facts {
  readonly triangles: number;
  readonly size: readonly [number, number, number];
}

const extension = (path: string): string => path.slice(path.lastIndexOf(".") + 1).toLowerCase();

/** Whether the registry reads this name as a 3D model. */
export const isModelPath = (path: string): boolean => kindByName(path) === "model3d";

/** What a model is: `3D model · STL`, then what its bytes say. */
export interface ModelFacts {
  readonly title: string;
  /** `12 triangles · 20 × 20 × 20 mm`, its size over the cap, or why not. */
  readonly facts: string;
}

/**
 * A model file's facts, from its bytes when it has them under the cap;
 * `size` is the whole file's. A file that is not its format says so.
 */
export function modelFacts(path: string, bytes: Uint8Array | null, size: number): ModelFacts {
  const format = extension(path).toUpperCase();
  const title = `3D model · ${format}`;
  if (bytes === null || size > FACTS_CAP) return { title, facts: megabytes(size) };
  let facts: Facts;
  try {
    facts = read(extension(path), bytes);
  } catch {
    return { title, facts: `not a readable ${format} file` };
  }
  const count = `${facts.triangles.toLocaleString("en")} triangle${facts.triangles === 1 ? "" : "s"}`;
  return { title, facts: `${count} · ${sizeText(facts.size)}` };
}

function read(ext: string, bytes: Uint8Array): Facts {
  if (ext === "3mf") {
    // The zip's model XML, inflated under the same cap the viewer holds.
    const entry = locateModel(bytes);
    const xml = entry.method === 0 ? entry.data : inflateRawSync(entry.data, { maxOutputLength: INFLATE_LIMIT });
    const mesh = parseModelXml(new TextDecoder().decode(xml));
    return { triangles: mesh.triangles, size: bounds(mesh.positions).size };
  }
  if (ext === "stl" || ext === "obj") {
    const mesh = ext === "stl" ? parseStl(bytes) : parseObj(new TextDecoder().decode(bytes));
    return { triangles: mesh.triangles, size: bounds(mesh.positions).size };
  }
  return gltfFacts(ext === "glb" ? glbJson(bytes) : new TextDecoder().decode(bytes));
}

/** A GLB's first chunk, which the spec says is its JSON. */
function glbJson(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + length > bytes.length) throw new Error("no JSON chunk");
  return new TextDecoder().decode(bytes.subarray(20, 20 + length));
}

interface Accessor {
  readonly count?: unknown;
  readonly min?: unknown;
  readonly max?: unknown;
}
interface Primitive {
  readonly mode?: unknown;
  readonly indices?: unknown;
  readonly attributes?: { readonly POSITION?: unknown };
}

const TRIANGLES = 4;
const STRIP = 5;
const FAN = 6;

function gltfFacts(json: string): Facts {
  const doc = JSON.parse(json) as { accessors?: Accessor[]; meshes?: { primitives?: Primitive[] }[] };
  const accessors = Array.isArray(doc.accessors) ? doc.accessors : [];
  const count = (index: unknown): number => {
    const n = typeof index === "number" ? accessors[index]?.count : undefined;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new Error("a primitive names no accessor");
    return n;
  };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  for (const mesh of Array.isArray(doc.meshes) ? doc.meshes : [])
    for (const p of Array.isArray(mesh.primitives) ? mesh.primitives : []) {
      const mode = p.mode ?? TRIANGLES;
      if (mode !== TRIANGLES && mode !== STRIP && mode !== FAN) continue;
      const corners = count(p.indices ?? p.attributes?.POSITION);
      triangles += mode === TRIANGLES ? Math.floor(corners / 3) : Math.max(0, corners - 2);
      const position = typeof p.attributes?.POSITION === "number" ? accessors[p.attributes.POSITION] : undefined;
      if (Array.isArray(position?.min) && Array.isArray(position?.max))
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a]!, Number(position.min[a]));
          max[a] = Math.max(max[a]!, Number(position.max[a]));
        }
    }
  const size = [0, 1, 2].map((a) => (max[a]! >= min[a]! ? (max[a]! - min[a]!) * 1000 : 0));
  if (size.some((v) => !Number.isFinite(v))) throw new Error("bounds that are not numbers");
  return { triangles, size: size as [number, number, number] };
}

const megabytes = (bytes: number): string =>
  bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
