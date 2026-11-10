/** 3MF print projects (#10892): the cube is built here, by hand, inside a zip. */

import { expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { fileKind } from "../src/web/render/kinds.ts";
import { modelFacts } from "../src/web/render/model-facts.ts";
import { bounds } from "../src/web/render/mesh.ts";
import { ENTRY_LIMIT, INFLATE_LIMIT, locateModel, parse3mf } from "../src/web/render/threemf.ts";

const enc = new TextEncoder();

/** A zip of name → content, each deflated (or stored), by the appnote's layout. */
function zip(files: Record<string, string>, method: 0 | 8 = 8): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = enc.encode(content);
    const packed = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const n = enc.encode(name);
    const local = new Uint8Array(30 + n.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, Bun.hash.crc32(raw), true);
    lv.setUint32(18, packed.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    const c = new Uint8Array(46 + n.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, Bun.hash.crc32(raw), true);
    cv.setUint32(20, packed.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    c.set(n, 46);
    central.push(c);
    parts.push(local, packed);
    offset += local.length + packed.length;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const CUBE_V = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]];
const CUBE_T = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];

function model(unit?: string, build = `<item objectid="1"/>`): string {
  const u = unit === undefined ? "" : ` unit="${unit}"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<model${u} xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<resources><object id="1" type="model"><mesh><vertices>
${CUBE_V.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join("\n")}
</vertices><triangles>
${CUBE_T.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join("\n")}
</triangles></mesh></object></resources><build>${build}</build></model>`;
}

const project = (xml: string, method: 0 | 8 = 8): Uint8Array => zip({ "[Content_Types].xml": "<Types/>", "3D/3dmodel.model": xml }, method);

test("a 20 mm cube is 12 triangles in a 20 × 20 × 20 box", async () => {
  const mesh = await parse3mf(project(model()));
  expect(mesh.triangles).toBe(12);
  expect(bounds(mesh.positions).size).toEqual([20, 20, 20]);
  expect(bounds((await parse3mf(project(model(), 0))).positions).size).toEqual([20, 20, 20]);
});

test("the unit is converted to millimetres: 20 inches is 508 mm", async () => {
  expect(bounds((await parse3mf(project(model("inch")))).positions).size).toEqual([508, 508, 508]);
  expect(bounds((await parse3mf(project(model("centimeter")))).positions).size).toEqual([200, 200, 200]);
  expect(bounds((await parse3mf(project(model("micron")))).positions).size[0]).toBeCloseTo(0.02, 6);
});

test("every build item is placed by its transform", async () => {
  const items = `<item objectid="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 50 0 0"/>`;
  const mesh = await parse3mf(project(model(undefined, items)));
  expect(mesh.triangles).toBe(24);
  expect(bounds(mesh.positions).size).toEqual([70, 20, 20]);
});

test("components of another object carry their own transform", async () => {
  const xml = model(undefined, `<item objectid="2"/>`).replace(
    "</resources>",
    `<object id="2"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 5"/></components></object></resources>`,
  );
  const b = bounds((await parse3mf(project(xml))).positions);
  expect(b.min[2]).toBe(5);
  expect(b.max[2]).toBe(25);
});

test("a zip with no model, a broken zip and a broken model are refused", async () => {
  await expect(parse3mf(zip({ "readme.txt": "hi" }))).rejects.toThrow(/no 3D model/);
  await expect(parse3mf(enc.encode("PK\x03\x04 not really a zip"))).rejects.toThrow(/zip/);
  await expect(parse3mf(project("<html/>"))).rejects.toThrow(/not a 3MF/);
  await expect(parse3mf(project(model().replace('v1="0"', 'v1="99"')))).rejects.toThrow(/vertex that is not there/);
  await expect(parse3mf(project(model("furlong")))).rejects.toThrow(/unit/);
});

test("a zip bomb is refused by entry count and by inflated size", async () => {
  const many: Record<string, string> = {};
  for (let i = 0; i <= ENTRY_LIMIT; i++) many[`f${i}`] = "";
  expect(() => locateModel(zip(many, 0))).toThrow(/more than/);
  const bytes = project(model());
  // The directory claims a size over the limit.
  const lie = bytes.slice();
  const v = new DataView(lie.buffer);
  for (let i = 0; i + 46 < lie.length; i++)
    if (v.getUint32(i, true) === 0x02014b50) v.setUint32(i + 24, 0x7fffffff, true);
  expect(() => locateModel(lie)).toThrow(/limit/);
  // Just over the cap is refused too.
  const edge = bytes.slice();
  const w = new DataView(edge.buffer);
  for (let i = 0; i + 46 < edge.length; i++)
    if (w.getUint32(i, true) === 0x02014b50) w.setUint32(i + 24, INFLATE_LIMIT + 1, true);
  expect(() => locateModel(edge)).toThrow(/limit/);
  expect(INFLATE_LIMIT).toBe(64 * 1024 * 1024);
});

test("the registry knows a .3mf by its zip signature, and the terminal measures it", () => {
  const bytes = project(model());
  expect(fileKind("part.3mf", bytes)).toBe("model3d");
  expect(fileKind("part.3mf", enc.encode("plain text"))).not.toBe("model3d");
  expect(modelFacts("part.3mf", bytes, bytes.length)).toEqual({
    title: "3D model · 3MF",
    facts: "12 triangles · 20 × 20 × 20 mm",
  });
  expect(modelFacts("part.3mf", zip({ "a.txt": "x" }), 100).facts).toBe("not a readable 3MF file");
});
