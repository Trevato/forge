/** A box from the origin to (x, y, z) as STL: 12 triangles, two per face. */
type V = [number, number, number];

function boxTriangles(x: number, y: number, z: number): V[][] {
  const p = (i: number): V => [i & 1 ? x : 0, i & 2 ? y : 0, i & 4 ? z : 0];
  const faces = [
    [0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3],
  ];
  return faces.flatMap(([a, b, c, d]) => [
    [p(a!), p(b!), p(c!)],
    [p(a!), p(c!), p(d!)],
  ]);
}

export function binaryBox(x: number, y: number, z: number, header = "box"): Uint8Array {
  const tris = boxTriangles(x, y, z);
  const out = new Uint8Array(84 + 50 * tris.length);
  out.set(new TextEncoder().encode(header.slice(0, 80)));
  const view = new DataView(out.buffer);
  view.setUint32(80, tris.length, true);
  tris.forEach((tri, t) => {
    tri.forEach((v, i) => v.forEach((c, a) => view.setFloat32(84 + t * 50 + 12 + i * 12 + a * 4, c, true)));
  });
  return out;
}

export function asciiBox(x: number, y: number, z: number): string {
  const facets = boxTriangles(x, y, z).map(
    (tri) =>
      `  facet normal 0 0 0\n    outer loop\n${tri.map((v) => `      vertex ${v.join(" ")}\n`).join("")}    endloop\n  endfacet\n`,
  );
  return `solid box\n${facets.join("")}endsolid box\n`;
}
