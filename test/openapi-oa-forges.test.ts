/** The OpenAPI document describes forges, the fleet, front, health and drills. */
import { expect, test } from "bun:test";
import { openapi } from "../src/contract/openapi.ts";

const WANT: readonly (readonly [string, string])[] = [
  ["get", "/api/v1/forges"],
  ["post", "/api/v1/forges"],
  ["get", "/api/v1/forges/sizes"],
  ["post", "/api/v1/forges/{name}/claim-link"],
  ["get", "/api/v1/forge"],
  ["get", "/api/v1/fleet/graph"],
  ["get", "/api/v1/fleet/ops"],
  ["get", "/api/v1/fleet/ops/{id}"],
  ["post", "/api/v1/fleet/ops"],
  ["post", "/api/v1/fleet/ops/{id}/undo"],
  ["get", "/api/v1/front"],
  ["get", "/api/v1/health"],
  ["get", "/api/v1/map"],
  ["post", "/api/v1/heartbeat"],
  ["post", "/api/v1/drills"],
];

test("each forges and fleet path and method is in the document", () => {
  const doc = openapi("https://f.test", "1") as any;
  for (const [method, path] of WANT) expect(doc.paths[path]?.[method], `${method} ${path}`).toBeDefined();
});

test("the claim link is shown once and the heartbeat and drills say who calls them", () => {
  const doc = openapi("https://f.test", "1") as any;
  expect(doc.paths["/api/v1/forges/{name}/claim-link"].post.summary).toContain("shown once");
  expect(doc.paths["/api/v1/heartbeat"].post.summary).toContain("child");
  expect(doc.paths["/api/v1/heartbeat"].post.security).toEqual([]);
  expect(doc.paths["/api/v1/drills"].post.summary).toContain("site admin");
  expect(doc.paths["/api/v1/drills"].post.security).toBeDefined();
});
