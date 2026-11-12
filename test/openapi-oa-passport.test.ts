/** The OpenAPI document describes the passport edge. */
import { expect, test } from "bun:test";
import { openapi } from "../src/contract/openapi.ts";

test("GET /api/v1/passport/health is described, with its passport and its one refusal", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  const op = doc.paths["/api/v1/passport/health"]?.get;
  expect(op).toBeDefined();
  expect(op.summary).toContain("Passport");
  expect(op.summary).toContain("health:read");
  expect(JSON.stringify(op)).toContain("unauthorized");
});
