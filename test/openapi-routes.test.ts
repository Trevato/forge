/**
 * One OpenAPI route per file (#5936): the contract every file under
 * src/contract/openapi/routes/ keeps, and the generated index kept current.
 * What a route says is tested by the test/openapi-*.test.ts beside this one.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { indexText, routeFiles } from "../scripts/openapi-routes.ts";
import { operationId, ROUTES } from "../src/contract/openapi.ts";

const files = routeFiles();
const fields = (v: unknown) => {
  expect(typeof v).toBe("object");
  for (const [k, t] of Object.entries(v as object)) {
    expect(k.length).toBeGreaterThan(0);
    // A query integer may carry its bounds: { type: "integer", min, max }.
    if (typeof t === "object" && t !== null) expect((t as { type?: unknown }).type).toBe("integer");
    else expect(typeof t).toBe("string");
    if (typeof t === "string") expect(t.trim().length).toBeGreaterThan(0);
  }
};

describe("every OpenAPI route file", () => {
  for (const name of files) {
    test(`${name}.ts exports one route whose operationId is ${name}`, async () => {
      const mod = await import(`../src/contract/openapi/routes/${name}.ts`);
      expect(Object.keys(mod)).toEqual(["route"]);
      const r = mod.route;
      expect(["get", "post", "put", "patch", "delete"]).toContain(r.method);
      expect(r.path.startsWith("/")).toBe(true);
      expect(operationId(r)).toBe(name);
      expect(typeof r.summary).toBe("string");
      expect(r.summary.trim().length).toBeGreaterThan(0);
      expect(typeof r.auth).toBe("boolean");
      if (r.status !== undefined) expect(Number.isInteger(r.status) && r.status >= 200 && r.status < 400).toBe(true);
      for (const k of ["body", "query", "reply", "refusals"] as const) if (r[k] !== undefined) fields(r[k]);
    });
  }
});

describe("the gathered routes", () => {
  test("are the files, sorted, one each", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(ROUTES.map(operationId)).toEqual(files);
    expect(new Set(ROUTES.map((r) => `${r.method} ${r.path}`)).size).toBe(ROUTES.length);
  });

  test("the index is current: run `bun scripts/openapi-routes.ts`", () => {
    const index = readFileSync(join(import.meta.dir, "..", "src/contract/openapi/routes/index.ts"), "utf8");
    expect(index).toBe(indexText(files));
  });

  test("a new file is one new line in the index, touching no other", () => {
    const before = indexText(["getA", "getC"]).split("\n");
    const after = indexText(["getA", "getB", "getC"]).split("\n");
    expect(after.filter((l) => !before.includes(l))).toEqual(['export { route as getB } from "./getB.ts";']);
    expect(before.filter((l) => !after.includes(l))).toEqual([]);
  });
});
