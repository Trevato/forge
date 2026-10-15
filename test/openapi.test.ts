/** The OpenAPI document names every route the manifest names. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openapi } from "../src/contract/openapi.ts";

test("every http route the manifest names is described", () => {
  const src = readFileSync("src/actions/here.ts", "utf8");
  const named = [...src.matchAll(/http: [`"]([^`"]+)[`"]/g)].flatMap((m) =>
    m[1]!.split(", then ").map((one) => {
      const [method, path] = one.replace(" {headRepo}", "").split(" ");
      return [method!.toLowerCase(), path!.replaceAll("${r}", "/api/v1/repos/{owner}/{name}")] as const;
    }),
  );
  expect(named.length).toBeGreaterThan(5);
  const doc = openapi("https://f.test", "1") as any;
  for (const [method, path] of named) {
    const p = path.replace(/\{(\w+)\}/g, "{$1}");
    expect(doc.paths[p]?.[method], `${method} ${p}`).toBeDefined();
  }
  expect(doc.openapi).toBe("3.1.0");
  expect(doc.paths["/api/v1/repos/{owner}/{name}/issues"].post.security).toBeDefined();
});
