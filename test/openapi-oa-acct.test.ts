/** The OpenAPI document describes the admin's account and invite routes. */
import { expect, test } from "bun:test";
import { openapi } from "../src/contract/openapi.ts";

const A = "/api/v1/admin/accounts";
const WANT: readonly (readonly [string, string])[] = [
  ["get", A],
  ["delete", `${A}/{username}`],
  ...["role", "ceiling", "model-grant", "suspend", "unsuspend", "verify"].map((a) => ["post", `${A}/{username}/${a}`] as const),
  ["get", "/api/v1/admin/invites"],
  ["post", "/api/v1/admin/invites"],
  ["delete", "/api/v1/admin/invites/{id}"],
];

test("each admin account and invite route is in the served document", () => {
  const doc = openapi("https://f.test", "1") as any;
  for (const [method, path] of WANT) expect(doc.paths[path]?.[method], `${method} ${path}`).toBeDefined();
});

test("the invite row says the link is shown once", () => {
  const doc = openapi("https://f.test", "1") as any;
  expect(doc.paths["/api/v1/admin/invites"].post.summary).toContain("shown once");
  expect(doc.paths["/api/v1/admin/invites"].post.security).toBeDefined();
});
