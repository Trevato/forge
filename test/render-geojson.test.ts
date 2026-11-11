/** GeoJSON files as an outline and a properties table. */
import { describe, expect, test } from "bun:test";
import { geojson, parseGeoJson } from "../src/web/render/geojson.ts";
import { fileKind } from "../src/web/render/kinds.ts";
import { RENDERERS } from "../src/web/render/renderers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const draw = (text: string) =>
  geojson({ path: "r/a.geojson", size: text.length, body: enc(text), media: "/m", download: "/d" });
const fc = (features: unknown[]) => JSON.stringify({ type: "FeatureCollection", features });
const feat = (geometry: unknown, properties: unknown = {}) => ({ type: "Feature", geometry, properties });

const ALL = fc([
  feat({ type: "Point", coordinates: [10, 20] }, { name: "<b>bold</b>" }),
  feat({ type: "LineString", coordinates: [[10, 20], [11, 21]] }, { name: "road" }),
  feat({ type: "Polygon", coordinates: [[[10, 20], [12, 20], [12, 22], [10, 20]]] }, { name: "lot" }),
]);

describe("geojson", () => {
  test("registered", () => {
    expect(fileKind("a.geojson", enc(ALL))).toBe("geojson");
    expect(RENDERERS.geojson).toBe(geojson);
  });

  test("a point, a line and a polygon are drawn; the count is shown", () => {
    const out = String(draw(ALL).content);
    expect(out).toContain("<svg");
    expect(out).toContain("<circle");
    expect(out).toContain('class="gj-line"');
    expect(out).toContain('class="gj-area"');
    expect(out).toContain("3 features");
    expect(out).toContain("<td>Polygon</td>");
  });

  test("projection: a point at the south-west corner sits at the padding", () => {
    const out = String(draw(fc([feat({ type: "LineString", coordinates: [[0, 0], [10, 10]] })])).content);
    expect(out).toContain("M12.0 ");
    expect(out).not.toMatch(/<svg[^>]*\s(width|height)=/);
  });

  test("a property with markup arrives escaped", () => {
    const out = String(draw(ALL).content);
    expect(out).not.toContain("<b>bold");
    expect(out).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  test("the table lists only the first 100 features", () => {
    const many = fc(Array.from({ length: 150 }, (_, i) => feat({ type: "Point", coordinates: [i / 10, 0] }, { id: `n${i}` })));
    const out = String(draw(many).content);
    expect(out).toContain("<td>n99</td>");
    expect(out).not.toContain("<td>n100</td>");
  });

  test("over 5,000 features only the table and a sentence show", () => {
    const huge = fc(Array.from({ length: 5001 }, () => feat({ type: "Point", coordinates: [1, 1] }, { a: 1 })));
    const out = String(draw(huge).content);
    expect(out).not.toContain("<svg");
    expect(out).toContain("too many to draw");
    expect(out).toContain("5,001 features");
    expect(out).toContain("<table");
  });

  test("invalid GeoJSON falls back to the JSON config view", () => {
    for (const bad of ['{"type":"Feature","geometry":{"type":"Point","coordinates":[500,0]}}', '{"a":1}', "nope"]) {
      expect(parseGeoJson(bad)).toBeUndefined();
      const r = draw(bad);
      expect(r.fallback).toBeUndefined();
      expect(String(r.content)).not.toContain("<svg");
      expect(String(r.content)).toContain("not valid GeoJSON");
    }
    expect(String(draw('{"a":1}').content)).toContain("config-form");
  });

  test("a single Feature and a bare geometry are one feature each", () => {
    const one = String(draw(JSON.stringify(feat({ type: "Point", coordinates: [1, 2] }, { name: "solo" }))).content);
    expect(one).toContain("1 feature.");
    expect(one).toContain("<td>solo</td>");
    expect(one).toContain("<circle");
    const bare = String(draw('{"type":"LineString","coordinates":[[0,0],[1,1]]}').content);
    expect(bare).toContain("1 feature.");
    expect(bare).toContain("<td>LineString</td>");
    expect(bare).toContain('class="gj-line"');
  });

  test("a feature with null geometry says there is nothing to draw", () => {
    const out = String(draw(fc([feat(null, { name: "nowhere" })])).content);
    expect(out).not.toContain("<svg");
    expect(out).toContain("No feature has a geometry to draw.");
    expect(out).toContain("<td>nowhere</td>");
  });

  test("the table has at most 12 property columns", () => {
    const props = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
    const out = String(draw(fc([feat({ type: "Point", coordinates: [0, 0] }, props)])).content);
    expect(out).toContain("<th scope=\"col\">k11</th>");
    expect(out).not.toContain(">k12<");
    expect(out.match(/<th /g)?.length).toBe(14);
  });

  test("a cell is cut at 200 characters", () => {
    const out = String(draw(fc([feat({ type: "Point", coordinates: [0, 0] }, { t: "x".repeat(300) })])).content);
    expect(out).toContain(`<td>${"x".repeat(200)}…</td>`);
    expect(out).not.toContain("x".repeat(201));
  });

  test("an empty collection shows the count and no table", () => {
    const out = String(draw(fc([])).content);
    expect(out).toContain("0 features");
    expect(out).not.toContain("<table");
    expect(out).not.toContain("<svg");
  });

  test("the scrolling table is reachable by keyboard and captioned", () => {
    const out = String(draw(ALL).content);
    expect(out).toContain('class="gj-table" tabindex="0" role="region" aria-label="Feature properties"');
    expect(out).toContain("<caption");
    expect(out).toContain('<th scope="col">');
  });
});
