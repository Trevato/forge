/**
 * OpenAPI documents as their operations: 3.x JSON and YAML, 2.0, escaping, the cap, the fallbacks, the registry.
 * The terminal screen is in tui-workspace.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { OPERATION_CAP, openapi, parseOpenApi } from "../src/web/render/openapi.ts";
import { fileKind, kindByName } from "../src/web/render/kinds.ts";
import { RENDERERS } from "../src/web/render/renderers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const draw = (text: string, path = "openapi.json") => openapi({ path, size: text.length, body: enc(text), media: "/m", download: "/d" });

const JSON3 = JSON.stringify({
  openapi: "3.0.3",
  tags: [{ name: "pets" }, { name: "store" }],
  paths: {
    "/pets": { get: { tags: ["pets"], summary: "List pets" }, post: { tags: ["pets"], summary: "Add a pet" } },
    "/pets/{id}": { delete: { tags: ["pets"], summary: "Remove", deprecated: true } },
    "/health": { get: { summary: "Alive" } },
    "/orders": { get: { tags: ["store"], summary: "Orders" } },
  },
});

describe("openapi", () => {
  test("the registry names the files and a renderer draws them", () => {
    for (const p of ["openapi.json", "api/openapi.yaml", "x/openapi.yml", "pets.openapi.json", "pets.OPENAPI.yaml"]) {
      expect(fileKind(p, enc("{}"))).toBe("openapi");
      expect(kindByName(p)).toBe("openapi");
    }
    expect(fileKind("package.json", enc("{}"))).toBe("config");
    expect(fileKind("myopenapi.json", enc("{}"))).toBe("config");
    expect(RENDERERS.openapi).toBe(openapi);
  });

  test("3.x JSON: a table per tag in declared order, untagged last, deprecated marked", () => {
    const r = draw(JSON3);
    expect(r.fallback).toBeUndefined();
    const h = String(r.content);
    expect(h.indexOf("<h3>pets</h3>")).toBeLessThan(h.indexOf("<h3>store</h3>"));
    expect(h.indexOf("<h3>store</h3>")).toBeLessThan(h.indexOf("<h3>Untagged</h3>"));
    expect(h).toContain(`<td><code>DELETE</code></td><td><code>/pets/{id}</code></td><td>Remove <span class="muted">deprecated</span></td>`);
    expect(h).toContain("<td><code>GET</code></td><td><code>/health</code></td><td>Alive</td></tr>");
    expect(r.summary).toContain("5 operations");
  });

  test("3.x YAML", () => {
    const r = draw("openapi: 3.1.0\npaths:\n  /a:\n    get:\n      summary: Fetch a\n      tags: [x]\n", "pets.openapi.yaml");
    expect(r.fallback).toBeUndefined();
    expect(String(r.content)).toContain("<h3>x</h3>");
    expect(String(r.content)).toContain("Fetch a");
  });

  test("Swagger 2.0", () => {
    const p = parseOpenApi('{"swagger":"2.0","paths":{"/x":{"get":{"summary":"s"}}}}', "openapi.json");
    expect(p).toEqual({ groups: [{ tag: "", ops: [{ method: "GET", path: "/x", summary: "s", deprecated: false }] }], shown: 1, more: 0 });
    expect(parseOpenApi('{"swagger":"1.2","paths":{}}', "openapi.json")).toBe("not");
  });

  test("summary, path and tag are escaped", () => {
    const evil = '<img src=x onerror=alert(1)>';
    const r = draw(JSON.stringify({ openapi: "3.0.0", paths: { [`/${evil}`]: { get: { summary: evil, tags: [evil] } } } }));
    const h = String(r.content);
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("past the cap, 500 are drawn and one line counts the rest", () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < OPERATION_CAP + 7; i++) paths[`/p${i}`] = { get: { summary: "s" } };
    const r = draw(JSON.stringify({ openapi: "3.0.0", paths }));
    const h = String(r.content);
    expect(h.match(/<tr><td><code>GET/g)?.length).toBe(OPERATION_CAP);
    expect(h).toContain("7 more operations not shown");
    expect(h).not.toContain("/p500<");
  });

  test("a spec with no paths or operations falls back to source with the reason", () => {
    expect(draw('{"openapi":"3.0.0"}').fallback).toContain("no paths");
    expect(draw('{"openapi":"3.0.0","paths":{"/a":{"parameters":[]}}}').fallback).toContain("no operations");
  });

  test("a file that says it is OpenAPI but does not parse falls back to the source with the reason", () => {
    for (const [text, path] of [['{"openapi": "3.0.0", "paths": {', "openapi.json"], ["openapi: 3.0.0\npaths: [unclosed\n", "api.openapi.yaml"]] as const) {
      const r = draw(text, path);
      expect(r.fallback).toContain("does not parse");
      expect(String(r.content)).not.toContain("openapi-view");
    }
  });

  test("a summary is cut at 300 characters", () => {
    const p = parseOpenApi(JSON.stringify({ openapi: "3.0.0", paths: { "/a": { get: { summary: "x".repeat(400) } } } }), "openapi.json");
    if (p === "not" || "error" in p) throw new Error("not drawn");
    expect(p.groups[0]!.ops[0]!.summary).toBe("x".repeat(300));
  });

  test("Swagger 2.0 YAML", () => {
    const r = draw("swagger: '2.0'\npaths:\n  /y:\n    get:\n      summary: Why\n", "swagger.openapi.yml");
    expect(r.fallback).toBeUndefined();
    expect(String(r.content)).toContain("Why");
  });

  test("a file that is not OpenAPI, or is not an API description, is left to the config view", () => {
    expect(parseOpenApi('{"openapi":"2.5"}', "openapi.json")).toBe("not");
    expect(parseOpenApi("{broken", "openapi.json")).toBe("not");
    expect(parseOpenApi("[1, 2]", "openapi.json")).toBe("not");
    const r = draw('{"name":"x"}');
    expect(String(r.content)).not.toContain("openapi-view");
  });
});
