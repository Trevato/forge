/** DXF drawings as inline SVG. */
import { describe, expect, test } from "bun:test";
import { dxf, ENTITY_CAP, parseDxf } from "../src/web/render/dxf.ts";
import { fileKind, RENDER_CAP } from "../src/web/render/kinds.ts";
import { RENDERERS } from "../src/web/render/renderers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const pairs = (...p: (string | number)[]): string => p.join("\n") + "\n";
const file = (entities: string, eof = true): string =>
  pairs(0, "SECTION", 2, "HEADER", 0, "ENDSEC", 0, "SECTION", 2, "ENTITIES") + entities + pairs(0, "ENDSEC") + (eof ? pairs(0, "EOF") : "");
const draw = (text: string) => dxf({ path: "r/a.dxf", size: text.length, body: enc(text), media: "/m", download: "/d" });

const ALL = file(
  pairs(0, "LINE", 8, "Walls", 10, 0, 20, 0, 11, 100, 21, 0) +
    pairs(0, "CIRCLE", 8, "Holes", 10, 50, 20, 50, 40, 10) +
    pairs(0, "ARC", 8, "Walls", 10, 0, 20, 0, 40, 20, 50, 0, 51, 90) +
    pairs(0, "LWPOLYLINE", 8, "Outline", 70, 1, 10, 0, 20, 0, 10, 10, 20, 0, 10, 10, 20, 10) +
    pairs(0, "TEXT", 8, "Notes", 10, 1, 20, 1, 1, "hello"),
);

describe("dxf", () => {
  test("registered, by name and by head", () => {
    expect(fileKind("a.dxf", enc(ALL))).toBe("dxf");
    expect(fileKind("drawing.txt", enc(ALL))).toBe("dxf");
    expect(fileKind("notes.txt", enc("hello\n"))).toBe("text");
    expect(RENDERERS.dxf).toBe(dxf);
    expect(RENDER_CAP.dxf).toBeGreaterThan(0);
  });

  test("one of each entity gives its elements and facts", () => {
    const out = String(draw(ALL).content);
    expect(out.match(/<svg/g)?.length).toBe(1);
    expect(out.match(/<circle/g)?.length).toBe(1);
    expect(out.match(/<path/g)?.length).toBe(1);
    // line + arc + polyline subpaths: three M commands
    expect(out.match(/M/g)?.length).toBe(3);
    expect(out).toContain("A"); // the arc command
    expect(out).toContain("Z"); // closed polyline
    expect(out).toContain("5 (1 ARC, 1 CIRCLE, 1 LINE, 1 LWPOLYLINE, 1 TEXT)");
    expect(out).toContain("Holes, Notes, Outline, Walls");
    expect(out).not.toMatch(/<svg[^>]*\s(width|height)=/);
  });

  test("the drawing is scaled to its bounding box, y flipped", () => {
    const out = String(draw(file(pairs(0, "LINE", 10, 0, 20, 0, 11, 100, 21, 50))).content);
    expect(out).toContain("M12.00 "); // west edge at the padding
    expect(out).toContain('viewBox="0 0 640 ');
    // (0,0) is the bottom: its y is larger than the top end's y (50)
    const m = /M12\.00 ([\d.]+)L[\d.]+ ([\d.]+)/.exec(out)!;
    expect(Number(m[1])).toBeGreaterThan(Number(m[2]));
  });

  test("empty, truncated and header-only files fall back plainly", () => {
    for (const text of ["", "0\nSECTION\n", file("", true), file(pairs(0, "LINE", 10, 0, 20, 0, 11, 1, 21, 1), false), "hello world\nnot dxf\nat all\nreally\n"]) {
      const r = draw(text);
      expect(r.fallback).toBeString();
      expect(r.fallback!.length).toBeGreaterThan(10);
    }
  });

  test("a 10 MB file is refused, not parsed", () => {
    const body = new Uint8Array(10_000_000).fill(0x30);
    const r = dxf({ path: "a.dxf", size: body.length, body, media: "/m", download: "/d" });
    expect(r.fallback).toContain("too large");
  });

  test("NaN, Infinity and absurd numbers never reach the SVG", () => {
    const bad = file(
      pairs(0, "LINE", 10, "NaN", 20, 0, 11, 1, 21, 1) +
        pairs(0, "LINE", 10, "Infinity", 20, 0, 11, 1, 21, 1) +
        pairs(0, "CIRCLE", 10, 0, 20, 0, 40, 1e300) +
        pairs(0, "LINE", 10, 0, 20, 0, 11, 4, 21, 3),
    );
    const parsed = parseDxf(bad);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.shapes.length).toBe(1);
    const out = String(draw(bad).content);
    expect(out).not.toMatch(/NaN|Infinity|e\+/);
  });

  test("layer names and entity types are escaped", () => {
    const out = String(draw(file(pairs(0, "LINE", 8, "<img src=x onerror=alert(1)>", 10, 0, 20, 0, 11, 1, 21, 1) + pairs(0, "<script>", 8, "a"))).content);
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;img");
  });

  test("an unknown entity is counted, not an error", () => {
    const r = draw(file(pairs(0, "LINE", 10, 0, 20, 0, 11, 1, 21, 1) + pairs(0, "SPLINE", 8, "0")));
    expect(r.fallback).toBeUndefined();
    expect(String(r.content)).toContain("1 SPLINE");
  });
});

describe("entity cap note", () => {
  const mk = (extra: string, n: number): string => {
    let body = "";
    for (let i = 0; i < n; i++) body += "0\nLINE\n8\n0\n10\n0\n20\n0\n11\n1\n21\n1\n";
    return `0\nSECTION\n2\nENTITIES\n${body}${extra}0\nENDSEC\n0\nEOF\n`;
  };
  const run = (t: string): string => String(dxf({ body: new TextEncoder().encode(t), size: t.length, path: "a.dxf" } as never).content);
  test("undrawn TEXT past the cap does not claim lines were dropped", () => {
    expect(run(mk("0\nTEXT\n8\n0\n", 3))).not.toContain("are not drawn.");
  });
  test("drawable shapes past the cap are counted", () => {
    const out = run(mk("", ENTITY_CAP + 2));
    expect(out).toContain("2 more past the first 50,000 are not drawn.");
  });
});
