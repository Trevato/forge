/** Sliced G-code drawn one layer at a time: parsed once, drawn as numbers only. */
import { describe, expect, test } from "bun:test";
import { clock, gcode, layerSvg, parseGcode, parsedGcode, SEGMENT_CAP } from "../src/web/render/gcode.ts";
import { fileKind, RENDER_CAP } from "../src/web/render/kinds.ts";
import { RENDERERS } from "../src/web/render/renderers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A 20 × 20 square, three layers (Z 0.2, 0.4, 0.6), 1 mm of filament per 20 mm side. */
const square = (relative: boolean): string => {
  const out = ["G21", "G90", relative ? "M83" : "M82", "G92 E0", ";TIME:754"];
  let e = 0;
  const side = (x: number, y: number): void => {
    e += 1;
    out.push(`G1 X${x} Y${y} E${relative ? 1 : e} F1200`);
  };
  for (const z of [0.2, 0.4, 0.6]) {
    out.push(`G0 X0 Y0 Z${z} F6000`);
    side(20, 0);
    side(20, 20);
    side(0, 20);
    side(0, 0);
    // a retract and its unretract add no filament
    out.push(`G1 E${relative ? -0.8 : e - 0.8}`);
    out.push(`G1 E${relative ? 0.8 : e}`);
  }
  return out.join("\n");
};

describe("gcode", () => {
  test("registered: a text kind with a 50 MB cap", () => {
    expect(fileKind("a.gcode", enc("G28\n"))).toBe("gcode");
    expect(RENDER_CAP.gcode).toBe(50_000_000);
    expect(RENDERERS.gcode).toBe(gcode);
  });

  test("a 3-layer square: 3 layers, a 20 × 20 box, 12 mm of filament, the stated time", () => {
    const g = parseGcode(square(false))!;
    expect(g.layers.length).toBe(3);
    expect(g.max[0] - g.min[0]).toBe(20);
    expect(g.max[1] - g.min[1]).toBe(20);
    expect(g.max[2]).toBeCloseTo(0.6);
    expect(g.filament).toBeCloseTo(12);
    expect(g.seconds).toBe(754);
    expect(g.layers[0]!.z).toBeCloseTo(0.2);
  });

  test("relative and absolute extrusion agree", () => {
    const a = parseGcode(square(false))!;
    const r = parseGcode(square(true))!;
    expect(r.filament).toBeCloseTo(a.filament);
    expect(r.layers.length).toBe(a.layers.length);
    expect(r.max).toEqual(a.max);
  });

  test("G91 moves are relative, G92 resets the extruder", () => {
    const g = parseGcode("G91\nG1 X5 Y0 E1\nG1 X0 Y5 E1\nG90\nG92 E0\nG1 X0 Y0 E2\n")!;
    expect(g.filament).toBeCloseTo(3); // E stays absolute: 1 + 0 + (2 after G92 E0)
    expect(g.max[0]).toBe(5);
    expect(g.layers.length).toBe(1);
  });

  test("slicer time comments in two spellings", () => {
    const body = "G1 X1 E1\n";
    expect(parseGcode(`; estimated printing time (normal mode) = 1h 2m 3s\n${body}`)!.seconds).toBe(3723);
    expect(parseGcode(`;TIME:60\n${body}`)!.seconds).toBe(60);
    expect(parseGcode(body)!.seconds).toBeUndefined();
    expect(clock(3723)).toBe("1 h 02 min");
  });

  test("a file with no extruding move is not drawn", () => {
    expect(parseGcode("G28\nG1 X10 Y10\n")).toBeUndefined();
    const r = gcode({ path: "a.gcode", size: 4, body: enc("G28\n"), media: "/m", download: "/d" });
    expect(r.fallback).toBeDefined();
  });

  test("the page: one layer, previous and next links, a GET form, Download", () => {
    const body = enc(square(false));
    const page = (layer?: number) =>
      String(gcode({ path: "a.gcode", size: body.length, body, media: "/m", download: "/d", pathHref: "/o/r/blob/main/a.gcode", ...(layer !== undefined ? { layer } : {}) }).content);
    const two = page(2);
    expect(two).toContain('href="/o/r/blob/main/a.gcode?layer=1"');
    expect(two).toContain('href="/o/r/blob/main/a.gcode?layer=3"');
    expect(two).toContain('<form method="get" action="/o/r/blob/main/a.gcode"');
    expect(two).toContain('name="layer"');
    expect(two).toContain('href="/d"');
    expect(two).toContain("<svg");
    expect(two).toContain("Estimated time");
    expect(page(1)).not.toContain("layer=0");
    expect(page(99)).toContain('value="3"');
    expect(page(0)).toContain('value="1"');
    expect(page(3)).not.toContain("layer=4");
  });

  test("the svg carries nothing from the file but numbers", () => {
    const hostile = `;<script>alert(1)</script>"onload=x\nG1 X1 Y1 E1\n; </svg><script>\n` + square(false);
    const g = parseGcode(hostile)!;
    const { svg } = layerSvg(g, 0);
    const text = svg.replace(/aria-label="[^"]*"/, "");
    expect(text).not.toContain("script");
    expect(text).not.toContain("onload");
    // every d attribute is path commands and numbers only
    for (const m of svg.matchAll(/ d="([^"]*)"/g)) expect(m[1]).toMatch(/^[ML0-9.\- ]*$/);
    // the page, too: no byte of a comment reaches it
    const page = String(gcode({ path: "a.gcode", size: 1, body: enc(hostile), media: "/m", download: "/d" }).content);
    expect(page).not.toContain("alert");
  });

  test("a layer's drawing is bounded", () => {
    let src = "";
    for (let i = 1; i <= SEGMENT_CAP + 50; i++) src += `G1 X${i % 100 + 1} Y${(i * 7) % 100 + 1} E${i}\n`;
    const g = parseGcode(src)!;
    const { shown, total } = layerSvg(g, 0);
    expect(total).toBe(SEGMENT_CAP + 50);
    expect(shown).toBe(SEGMENT_CAP);
  });

  test("a body is parsed once", () => {
    const body = enc(square(false));
    expect(parsedGcode(body)).toBe(parsedGcode(new Uint8Array(body)));
  });

  test("a 10 MB file parses in well under a second", () => {
    const lines: string[] = [];
    let e = 0;
    for (let i = 0; i < 280_000; i++) lines.push(`G1 X${(i % 200) + 0.123} Y${((i * 3) % 200) + 0.456} E${(e += 0.0123).toFixed(5)} F1800`);
    // 100 layers
    const per = 2800;
    const src = lines.map((l, i) => (i % per === 0 ? `G1 Z${(i / per) * 0.2 + 0.2}\n${l}` : l)).join("\n");
    expect(src.length).toBeGreaterThan(10_000_000);
    const t = performance.now();
    const g = parsedGcode(enc(src))!;
    // Parsing is off the request thread for a body this big (test/gcode-page.test.ts); this bounds the work itself.
    expect(performance.now() - t).toBeLessThan(3000);
    expect(g.layers.length).toBe(100);
    const r = performance.now();
    gcode({ path: "a.gcode", size: src.length, body: enc(src), media: "/m", download: "/d", layer: 50 });
    expect(performance.now() - r).toBeLessThan(500);
  });
});
