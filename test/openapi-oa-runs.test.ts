/** The OpenAPI document describes the runs, usage and spend routes. */
import { expect, test } from "bun:test";
import { openapi } from "../src/contract/openapi.ts";

const R = "/api/v1/repos/{owner}/{name}";

test("runs, log, cancel, usage and spend are in the served document", () => {
  const doc = openapi("https://f.test", "1") as any;
  const want: [string, string][] = [
    ["get", `${R}/runs`],
    ["get", `${R}/runs/{id}`],
    ["get", `${R}/runs/{id}/log`],
    ["post", `${R}/runs/{id}/cancel`],
    ["get", `${R}/usage`],
    ["post", `${R}/spend`],
  ];
  for (const [method, path] of want) expect(doc.paths[path]?.[method], `${method} ${path}`).toBeDefined();
  expect(doc.paths[`${R}/runs/{id}/cancel`].post.security).toBeDefined();
  expect(doc.paths[`${R}/spend`].post.security).toBeDefined();
  expect(doc.paths[`${R}/runs`].get.security).toEqual([]);
});
