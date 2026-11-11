/** GPX files as a route outline: distance, a malformed file, entity expansion. */
import { describe, expect, test } from "bun:test";
import { gpx, gpxStats, parseGpx, outline } from "../src/web/render/gpx.ts";
import { fileKind } from "../src/web/render/kinds.ts";
import { RENDERERS } from "../src/web/render/renderers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const draw = (text: string) => gpx({ path: "r/a.gpx", size: text.length, body: enc(text), media: "/m", download: "/d" });

// One degree of latitude is about 111.195 km.
const TWO = `<?xml version="1.0"?><gpx version="1.1"><trk><name>Up &amp; <b>down</b></name><trkseg>
<trkpt lat="10" lon="20"><ele>100</ele></trkpt><trkpt lat="11" lon="20"><ele>150.5</ele></trkpt></trkseg></trk></gpx>`;

describe("gpx", () => {
  test("registered", () => {
    expect(fileKind("a.gpx", enc(TWO))).toBe("gpx");
    expect(RENDERERS.gpx).toBe(gpx);
  });

  test("distance of a known two-point track within 1%, climb and count", () => {
    const g = parseGpx(TWO)!;
    const s = gpxStats(g);
    expect(Math.abs(s.distance - 111_195) / 111_195).toBeLessThan(0.01);
    expect(s.gain).toBeCloseTo(50.5);
    const out = String(draw(TWO).content);
    expect(out).toContain("<svg");
    expect(out).toContain("111.2 km");
    expect(out).toContain("<dd>2</dd>");
  });

  test("the svg has no fixed size, so it scales on a phone; facts are status rows", () => {
    const out = String(draw(TWO).content);
    expect(out).toContain("viewBox=");
    expect(out).not.toMatch(/<svg[^>]*\s(width|height)=/);
    expect(out).toContain('<div class="status-row"><dt>Distance</dt><dd>111.2 km</dd></div>');
    expect(out).not.toContain("<figcaption");
  });

  test("names are escaped", () => {
    const out = String(draw(TWO.replace("Up &amp;", "&lt;script&gt;")).content);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt; down");
  });

  test("a malformed file falls back to text", () => {
    for (const bad of ["", "hello", "<gpx><trk></gpx>", "<gpx></gpx>", "<html><trkpt lat='1' lon='1'/></html>"]) {
      expect(draw(bad).fallback).toBeDefined();
    }
  });

  test("an entity-expansion attempt is not expanded", () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY a "AAAAAAAAAA"><!ENTITY b "&a;&a;&a;&a;">]>
<gpx><trk><name>&b;</name><trkseg><trkpt lat="1" lon="1"/><trkpt lat="1.1" lon="1.1"/></trkseg></trk></gpx>`;
    const g = parseGpx(evil)!;
    expect(g.count).toBe(2);
    expect(g.lines[0]!.name).toBe("&b;");
    expect(String(draw(evil).content)).not.toContain("AAAA");
  });

  test("more than 20,000 points are thinned evenly, ends kept", () => {
    let pts = "";
    for (let i = 0; i < 30_000; i++) pts += `<trkpt lat="${(i / 30_000).toFixed(6)}" lon="0"/>`;
    const g = parseGpx(`<gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`)!;
    expect(g.count).toBe(30_000);
    const path = outline(g).paths[0]!;
    expect(path.split("L").length).toBeLessThanOrEqual(20_000);
    expect(path.split("L").length).toBeGreaterThan(19_000);
    expect(path.startsWith("M")).toBe(true);
    // The last point is drawn: the top-left of the path is the northmost end.
    expect(path.endsWith("12.0")).toBe(true);
  });

  test("routes and a single point do not break the outline", () => {
    const g = parseGpx(`<gpx><rte><name>r</name><rtept lat="1" lon="1"/></rte></gpx>`)!;
    expect(outline(g).paths.length).toBe(1);
  });
});
